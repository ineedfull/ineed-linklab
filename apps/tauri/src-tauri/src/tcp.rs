use std::{
    collections::HashMap,
    io::{self, Read, Write},
    net::{Shutdown, TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::Value;

use crate::serial::{
    self, FrameBatch, PeerEvent, PeerRecord, ReceiveFraming, SerialError, SerialErrorCode,
    SerialEvent, SerialStatus, StatusEvent, StatusLog, WireFrame, MAX_PENDING_FRAME_BYTES,
};

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const ACCEPT_POLL: Duration = Duration::from_millis(20);
const FRAME_BATCH_MILLIS: u64 = 200;
const FRAME_BATCH_LIMIT: usize = 200;

type SharedEventSink = Arc<Mutex<Option<Arc<dyn serial::SerialEventSink>>>>;

pub(crate) type TcpResult<T> = Result<T, serial::SerialError>;

#[derive(Debug, Clone)]
pub(crate) struct TcpEndpoint {
    pub(crate) endpoint_id: String,
    pub(crate) transport: String,
    pub(crate) config: serde_json::Value,
}

pub(crate) struct TcpService {
    sink: SharedEventSink,
    lifecycle: Arc<Mutex<TcpLifecycle>>,
    lifecycle_changed: Condvar,
    generation: AtomicU64,
    #[cfg(test)]
    before_open_commit: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    after_open_commit_check: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    fail_before_client_reader: Mutex<Option<Arc<dyn Fn() -> SerialError + Send + Sync>>>,
    #[cfg(test)]
    fail_before_accepted_stream_config: Mutex<Option<Arc<dyn Fn() -> SerialError + Send + Sync>>>,
}

struct TcpLifecycle {
    stopped: bool,
    active_opens: usize,
    sessions: HashMap<String, Arc<TcpSession>>,
}

impl TcpService {
    pub(crate) fn new(sink: Arc<dyn serial::SerialEventSink>) -> Self {
        Self {
            sink: Arc::new(Mutex::new(Some(sink))),
            lifecycle: Arc::new(Mutex::new(TcpLifecycle {
                stopped: false,
                active_opens: 0,
                sessions: HashMap::new(),
            })),
            lifecycle_changed: Condvar::new(),
            generation: AtomicU64::new(0),
            #[cfg(test)]
            before_open_commit: Mutex::new(None),
            #[cfg(test)]
            after_open_commit_check: Mutex::new(None),
            #[cfg(test)]
            fail_before_client_reader: Mutex::new(None),
            #[cfg(test)]
            fail_before_accepted_stream_config: Mutex::new(None),
        }
    }

    pub(crate) fn open(
        &self,
        endpoint: TcpEndpoint,
        operation_id: &str,
    ) -> TcpResult<serial::OpenAcknowledgement> {
        require_id(&endpoint.endpoint_id, "endpointId")?;
        require_id(operation_id, "operationId")?;
        match endpoint.transport.as_str() {
            "tcp-client" => self.open_client(endpoint, operation_id),
            "tcp-server" => self.open_server(endpoint, operation_id),
            _ => Err(serial::SerialError::new(
                serial::SerialErrorCode::IoError,
                format!("{} is not a TCP endpoint", endpoint.endpoint_id),
            )),
        }
    }

    pub(crate) fn send(
        &self,
        endpoint_id: &str,
        bytes: &[u8],
        target: Option<&serde_json::Value>,
    ) -> TcpResult<serial::SendAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        let session = self.session(endpoint_id)?;
        // A cloned TCP stream shares the same socket. Hold one send owner across
        // all partial writes and the outbound history commit so concurrent IPC
        // commands cannot mix payload bytes or reorder the recorded wire frames.
        let _send_owner = session.send_owner.lock().map_err(poisoned)?;
        match session.kind {
            TcpSessionKind::Client => self.send_client(&session, bytes),
            TcpSessionKind::Server => self.send_server(&session, bytes, target),
        }
    }

    pub(crate) fn cancel_open(
        &self,
        endpoint_id: &str,
        operation_id: &str,
    ) -> TcpResult<serial::CancelAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        require_id(operation_id, "operationId")?;
        let session = {
            let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
            if lifecycle
                .sessions
                .get(endpoint_id)
                .is_some_and(|session| session.operation_id == operation_id)
            {
                lifecycle.sessions.remove(endpoint_id)
            } else {
                None
            }
        };
        let cancelled = session.is_some();
        if let Some(session) = session {
            session.close()?;
            flush_session(&self.sink, &session);
            self.emit_status(&session, SerialStatus::Closed, None, None);
        }
        Ok(serial::CancelAcknowledgement {
            endpoint_id: endpoint_id.into(),
            operation_id: operation_id.into(),
            cancelled,
        })
    }

    pub(crate) fn close(&self, endpoint_id: &str) -> TcpResult<serial::CloseAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        let session = self
            .lifecycle
            .lock()
            .map_err(poisoned)?
            .sessions
            .remove(endpoint_id);
        if let Some(session) = session {
            let peers = if session.kind == TcpSessionKind::Server {
                session.peer_records()
            } else {
                Vec::new()
            };
            session.close()?;
            flush_session(&self.sink, &session);
            for peer in peers {
                self.emit_peer_log(
                    &session,
                    &peer,
                    "info",
                    format!("TCP peer disconnected: {}", peer.remote_address),
                );
            }
            self.emit_status(&session, SerialStatus::Closed, None, None);
            self.emit_peers(&session, Vec::new());
        }
        Ok(serial::CloseAcknowledgement {
            endpoint_id: endpoint_id.into(),
            closed: true,
        })
    }

    pub(crate) fn disconnect_peer(
        &self,
        endpoint_id: &str,
        peer_id: &str,
    ) -> TcpResult<serde_json::Value> {
        require_id(endpoint_id, "endpointId")?;
        require_id(peer_id, "peerId")?;
        let session = self.session(endpoint_id)?;
        if session.kind != TcpSessionKind::Server {
            return Err(SerialError::new(
                SerialErrorCode::IoError,
                "Only TCP server peers can be disconnected",
            ));
        }
        let peer = session.disconnect_peer(peer_id)?;
        self.emit_peers(&session, session.peer_records());
        self.emit_peer_log(
            &session,
            &peer,
            "info",
            format!("TCP peer disconnected: {}", peer.remote_address),
        );
        Ok(
            serde_json::json!({ "endpointId": endpoint_id, "peerId": peer_id, "disconnected": true }),
        )
    }

    pub(crate) fn close_all(&self) -> TcpResult<()> {
        let endpoint_ids: Vec<String> = {
            let lifecycle = self.lifecycle.lock().map_err(poisoned)?;
            lifecycle.sessions.keys().cloned().collect()
        };
        let mut first_error = None;
        for endpoint_id in endpoint_ids {
            if let Err(error) = self.close(&endpoint_id) {
                first_error.get_or_insert(error);
            }
        }
        let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
        while lifecycle.active_opens > 0 {
            lifecycle = self.lifecycle_changed.wait(lifecycle).map_err(poisoned)?;
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(crate) fn shutdown(&self) -> TcpResult<()> {
        self.lifecycle.lock().map_err(poisoned)?.stopped = true;
        self.close_all()
    }

    pub(crate) fn force_shutdown(&self) -> Vec<String> {
        let (sessions, active_opens) = match self.lifecycle.lock() {
            Ok(mut lifecycle) => {
                lifecycle.stopped = true;
                let active_opens = lifecycle.active_opens;
                let sessions = lifecycle
                    .sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>();
                (sessions, active_opens)
            }
            Err(_) => {
                return vec![
                    "tcp service lifecycle unavailable; process exit must reclaim resources".into(),
                ];
            }
        };
        let mut fallback = Vec::new();
        for session in sessions {
            if let Err(error) = session.close() {
                fallback.push(format!("{}: {}", session.endpoint_id, error.message));
            }
        }
        if active_opens > 0 {
            fallback.push(format!(
                "{active_opens} TCP open operation(s) still active during forced cleanup"
            ));
        }
        fallback
    }

    pub(crate) fn disconnect_event_sink(&self) {
        match self.sink.lock() {
            Ok(mut sink) => {
                sink.take();
            }
            Err(poisoned) => {
                poisoned.into_inner().take();
            }
        }
    }

    fn open_client(
        &self,
        endpoint: TcpEndpoint,
        operation_id: &str,
    ) -> TcpResult<serial::OpenAcknowledgement> {
        let config = TcpConfig::client_from_value(&endpoint.config)?;
        let session = self.create_session(
            TcpSessionKind::Client,
            endpoint.endpoint_id,
            operation_id,
            config.label(),
            config.receive_framing.clone(),
            config.keep_alive,
        )?;
        let _active_open = ActiveTcpOpen { service: self };
        self.emit_status(&session, SerialStatus::Opening, None, None);
        let stream = match connect_tcp(&session, &config.host, config.port) {
            Ok(stream) => stream,
            Err(error) => {
                let error = if session.stop.load(Ordering::SeqCst) {
                    SerialError::new(SerialErrorCode::OpenCancelled, "TCP open cancelled")
                } else {
                    map_tcp_error(error)
                };
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = configure_stream(&stream, config.keep_alive) {
            let _ = stream.shutdown(Shutdown::Both);
            self.fail_open(&session, error.clone());
            return Err(error);
        }
        let read_stream = match stream.try_clone() {
            Ok(stream) => stream,
            Err(error) => {
                let _ = stream.shutdown(Shutdown::Both);
                let error = map_tcp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        #[cfg(test)]
        if let Some(hook) = self
            .fail_before_client_reader
            .lock()
            .map_err(poisoned)?
            .clone()
        {
            let error = hook();
            let _ = stream.shutdown(Shutdown::Both);
            self.fail_open(&session, error.clone());
            return Err(error);
        }
        *session.stream.lock().map_err(poisoned)? = Some(stream);
        let sink = self.sink.clone();
        let lifecycle = self.lifecycle.clone();
        let reader_session = session.clone();
        let reader = thread::Builder::new()
            .name(format!("tcp-client-read-{}", session.generation))
            .spawn(move || {
                read_stream_loop(sink, reader_session, None, read_stream, Some(lifecycle))
            })
            .map_err(|error| {
                let error = SerialError::new(SerialErrorCode::IoError, error.to_string());
                self.fail_open(&session, error.clone());
                error
            })?;
        *session.reader.lock().map_err(poisoned)? = Some(reader);
        self.commit_open(
            &session,
            TcpSessionPhase::Open,
            Some(serde_json::json!({ "host": config.host, "port": config.port })),
        )?;
        Ok(open_ack(&session))
    }

    fn open_server(
        &self,
        endpoint: TcpEndpoint,
        operation_id: &str,
    ) -> TcpResult<serial::OpenAcknowledgement> {
        let config = TcpConfig::server_from_value(&endpoint.config)?;
        let session = self.create_session(
            TcpSessionKind::Server,
            endpoint.endpoint_id,
            operation_id,
            config.label(),
            config.receive_framing.clone(),
            config.keep_alive,
        )?;
        let _active_open = ActiveTcpOpen { service: self };
        self.emit_status(&session, SerialStatus::Opening, None, None);
        let listener = match TcpListener::bind((config.host.as_str(), config.port)) {
            Ok(listener) => listener,
            Err(error) => {
                let error = map_tcp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = listener.set_nonblocking(true) {
            let error = map_tcp_error(error);
            self.fail_open(&session, error.clone());
            return Err(error);
        }
        let local_port = match listener.local_addr() {
            Ok(address) => address.port(),
            Err(error) => {
                let error = map_tcp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        let sink = self.sink.clone();
        let accept_session = session.clone();
        let acceptor = thread::Builder::new()
            .name(format!("tcp-server-accept-{}", session.generation))
            .spawn(move || accept_loop(sink, accept_session, listener))
            .map_err(|error| {
                let error = SerialError::new(SerialErrorCode::IoError, error.to_string());
                self.fail_open(&session, error.clone());
                error
            })?;
        *session.acceptor.lock().map_err(poisoned)? = Some(acceptor);
        self.commit_open(
            &session,
            TcpSessionPhase::Listening,
            Some(serde_json::json!({ "host": config.host, "port": local_port })),
        )?;
        Ok(open_ack(&session))
    }

    fn send_client(
        &self,
        session: &Arc<TcpSession>,
        bytes: &[u8],
    ) -> TcpResult<serial::SendAcknowledgement> {
        if *session.phase.lock().map_err(poisoned)? != TcpSessionPhase::Open {
            return Err(SerialError::new(
                SerialErrorCode::IoError,
                format!("Endpoint {} is not open", session.endpoint_id),
            ));
        }
        let mut stream = {
            let stream = session.stream.lock().map_err(poisoned)?;
            stream
                .as_ref()
                .ok_or_else(|| {
                    SerialError::new(SerialErrorCode::IoError, "TCP stream is unavailable")
                })?
                .try_clone()
                .map_err(map_tcp_error)?
        };
        stream.write_all(bytes).map_err(map_tcp_error)?;
        enqueue_frame(&self.sink, session, "out", None, bytes.to_vec());
        Ok(serial::SendAcknowledgement {
            endpoint_id: session.endpoint_id.clone(),
            sent: bytes.len(),
            peer_count: None,
            success_count: None,
            failure_count: None,
            peer_results: None,
        })
    }

    fn send_server(
        &self,
        session: &Arc<TcpSession>,
        bytes: &[u8],
        target: Option<&Value>,
    ) -> TcpResult<serial::SendAcknowledgement> {
        if *session.phase.lock().map_err(poisoned)? != TcpSessionPhase::Listening {
            return Err(SerialError::new(
                SerialErrorCode::IoError,
                format!("Endpoint {} is not listening", session.endpoint_id),
            ));
        }
        let peers = session.send_targets(target)?;
        let peer_count = peers.len();
        let mut peer_results = Vec::with_capacity(peer_count);
        for peer in peers {
            #[cfg(test)]
            let injected_failure = peer.fail_next_write.swap(false, Ordering::SeqCst);
            #[cfg(not(test))]
            let injected_failure = false;
            let result = if injected_failure {
                Err(SerialError::new(
                    SerialErrorCode::IoError,
                    "injected TCP peer write failure",
                ))
            } else {
                peer.stream
                    .lock()
                    .map_err(poisoned)
                    .and_then(|stream| stream.try_clone().map_err(map_tcp_error))
                    .and_then(|mut stream| stream.write_all(bytes).map_err(map_tcp_error))
            };
            match result {
                Ok(()) => {
                    enqueue_frame(
                        &self.sink,
                        session,
                        "out",
                        Some(peer.id.clone()),
                        bytes.to_vec(),
                    );
                    peer_results.push(serial::PeerSendResult {
                        peer_id: peer.id.clone(),
                        ok: true,
                        byte_count: Some(bytes.len()),
                        error: None,
                    });
                }
                Err(error) => peer_results.push(serial::PeerSendResult {
                    peer_id: peer.id.clone(),
                    ok: false,
                    byte_count: None,
                    error: Some(error),
                }),
            }
        }
        let success_count = peer_results.iter().filter(|result| result.ok).count();
        Ok(serial::SendAcknowledgement {
            endpoint_id: session.endpoint_id.clone(),
            sent: bytes.len(),
            peer_count: Some(peer_count),
            success_count: Some(success_count),
            failure_count: Some(peer_count - success_count),
            peer_results: Some(peer_results),
        })
    }

    fn session(&self, endpoint_id: &str) -> TcpResult<Arc<TcpSession>> {
        self.lifecycle
            .lock()
            .map_err(poisoned)?
            .sessions
            .get(endpoint_id)
            .cloned()
            .ok_or_else(|| {
                SerialError::new(
                    SerialErrorCode::PortNotFound,
                    format!("Endpoint {endpoint_id} is not open"),
                )
            })
    }

    fn create_session(
        &self,
        kind: TcpSessionKind,
        endpoint_id: String,
        operation_id: &str,
        remote_label: String,
        receive_framing: ReceiveFraming,
        keep_alive: TcpKeepAliveConfig,
    ) -> TcpResult<Arc<TcpSession>> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let session = Arc::new(TcpSession {
            kind,
            endpoint_id: endpoint_id.clone(),
            operation_id: operation_id.into(),
            session_id: format!("tcp-session-{generation}"),
            generation,
            remote_label,
            receive_framing,
            keep_alive,
            phase: Mutex::new(TcpSessionPhase::Opening),
            send_owner: Mutex::new(()),
            stream: Mutex::new(None),
            reader: Mutex::new(None),
            acceptor: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            next_peer_id: AtomicU64::new(0),
            batcher: Mutex::new(FrameBatcher::new(now_millis())),
            framer: Mutex::new(Framer::new(ReceiveFraming::Raw)),
            stop: AtomicBool::new(false),
            #[cfg(test)]
            fail_before_accepted_stream_config: self
                .fail_before_accepted_stream_config
                .lock()
                .map_err(poisoned)?
                .clone(),
        });
        let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
        if lifecycle.stopped {
            return Err(tcp_shutdown_error());
        }
        if lifecycle.sessions.contains_key(&endpoint_id) {
            return Err(SerialError::new(
                SerialErrorCode::PortBusy,
                format!("Endpoint {endpoint_id} is already open"),
            ));
        }
        *session.framer.lock().map_err(poisoned)? = Framer::new(session.receive_framing.clone());
        lifecycle.active_opens += 1;
        lifecycle.sessions.insert(endpoint_id, session.clone());
        Ok(session)
    }

    fn commit_open(
        &self,
        session: &Arc<TcpSession>,
        phase: TcpSessionPhase,
        details: Option<Value>,
    ) -> TcpResult<()> {
        #[cfg(test)]
        if let Some(hook) = self.before_open_commit.lock().map_err(poisoned)?.clone() {
            hook();
        }
        #[cfg(test)]
        if let Some(hook) = self
            .after_open_commit_check
            .lock()
            .map_err(poisoned)?
            .clone()
        {
            hook();
        }
        let lifecycle = self.lifecycle.lock().map_err(poisoned)?;
        let current = lifecycle
            .sessions
            .get(&session.endpoint_id)
            .is_some_and(|current| current.generation == session.generation);
        if lifecycle.stopped || !current || session.stop.load(Ordering::SeqCst) {
            drop(lifecycle);
            let _ = session.close();
            self.remove_if_current(session);
            return Err(tcp_shutdown_error());
        }
        *session.phase.lock().map_err(poisoned)? = phase;
        self.emit_status(
            session,
            if phase == TcpSessionPhase::Listening {
                SerialStatus::Listening
            } else {
                SerialStatus::Open
            },
            None,
            details,
        );
        Ok(())
    }

    fn fail_open(&self, session: &Arc<TcpSession>, error: SerialError) {
        self.remove_if_current(session);
        let _ = session.close();
        self.emit_status(session, SerialStatus::Error, Some(error), None);
    }

    fn remove_if_current(&self, session: &Arc<TcpSession>) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            if lifecycle
                .sessions
                .get(&session.endpoint_id)
                .is_some_and(|current| current.generation == session.generation)
            {
                lifecycle.sessions.remove(&session.endpoint_id);
            }
        }
    }

    fn end_open(&self) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.active_opens = lifecycle.active_opens.saturating_sub(1);
            self.lifecycle_changed.notify_all();
        }
    }

    fn emit_status(
        &self,
        session: &TcpSession,
        status: SerialStatus,
        error: Option<SerialError>,
        details: Option<Value>,
    ) {
        let created_at = now_millis();
        let log = tcp_status_log(session, status, error.as_ref(), details.clone(), created_at);
        let session_id = match status {
            SerialStatus::Opening | SerialStatus::Closed => None,
            _ => Some(session.session_id.clone()),
        };
        emit_event(
            &self.sink,
            SerialEvent::Status(StatusEvent {
                endpoint_id: session.endpoint_id.clone(),
                operation_id: session.operation_id.clone(),
                session_id,
                status,
                error,
                created_at,
                log,
            }),
        );
    }

    fn emit_peers(&self, session: &TcpSession, peers: Vec<PeerRecord>) {
        emit_event(
            &self.sink,
            SerialEvent::Peers(PeerEvent {
                endpoint_id: session.endpoint_id.clone(),
                operation_id: session.operation_id.clone(),
                session_id: session.session_id.clone(),
                peers,
            }),
        );
    }

    fn emit_peer_log(
        &self,
        session: &TcpSession,
        peer: &PeerRecord,
        level: &'static str,
        message: String,
    ) {
        emit_peer_log_with_sink(&self.sink, session, peer, level, message);
    }

    #[cfg(test)]
    fn set_before_open_commit(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.before_open_commit.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_after_open_commit_check(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.after_open_commit_check.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_fail_before_client_reader(&self, hook: Arc<dyn Fn() -> SerialError + Send + Sync>) {
        *self.fail_before_client_reader.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_fail_before_accepted_stream_config(
        &self,
        hook: Arc<dyn Fn() -> SerialError + Send + Sync>,
    ) {
        *self.fail_before_accepted_stream_config.lock().unwrap() = Some(hook);
    }
}

struct ActiveTcpOpen<'a> {
    service: &'a TcpService,
}

impl Drop for ActiveTcpOpen<'_> {
    fn drop(&mut self) {
        self.service.end_open();
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TcpSessionKind {
    Client,
    Server,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum TcpSessionPhase {
    Opening,
    Open,
    Listening,
    Closed,
}

struct TcpSession {
    kind: TcpSessionKind,
    endpoint_id: String,
    operation_id: String,
    session_id: String,
    generation: u64,
    remote_label: String,
    receive_framing: ReceiveFraming,
    keep_alive: TcpKeepAliveConfig,
    phase: Mutex<TcpSessionPhase>,
    send_owner: Mutex<()>,
    stream: Mutex<Option<TcpStream>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    acceptor: Mutex<Option<JoinHandle<()>>>,
    peers: Mutex<HashMap<String, Arc<TcpPeer>>>,
    next_peer_id: AtomicU64,
    batcher: Mutex<FrameBatcher>,
    framer: Mutex<Framer>,
    stop: AtomicBool,
    #[cfg(test)]
    fail_before_accepted_stream_config: Option<Arc<dyn Fn() -> SerialError + Send + Sync>>,
}

impl TcpSession {
    fn close(&self) -> TcpResult<()> {
        self.stop.store(true, Ordering::SeqCst);
        *self.phase.lock().map_err(poisoned)? = TcpSessionPhase::Closed;
        if let Some(stream) = self.stream.lock().map_err(poisoned)?.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
        let peers = {
            let mut peers = self.peers.lock().map_err(poisoned)?;
            peers.drain().map(|(_, peer)| peer).collect::<Vec<_>>()
        };
        for peer in peers {
            peer.close();
            peer.join()?;
        }
        if let Some(reader) = self.reader.lock().map_err(poisoned)?.take() {
            reader.join().map_err(|_| {
                SerialError::new(SerialErrorCode::IoError, "TCP reader thread panicked")
            })?;
        }
        if let Some(acceptor) = self.acceptor.lock().map_err(poisoned)?.take() {
            acceptor.join().map_err(|_| {
                SerialError::new(SerialErrorCode::IoError, "TCP accept thread panicked")
            })?;
        }
        Ok(())
    }

    fn disconnect_peer(&self, peer_id: &str) -> TcpResult<PeerRecord> {
        let peer = self
            .peers
            .lock()
            .map_err(poisoned)?
            .remove(peer_id)
            .ok_or_else(|| {
                SerialError::new(
                    SerialErrorCode::PortNotFound,
                    format!("TCP peer {peer_id} is not connected"),
                )
            })?;
        let record = peer.record();
        peer.close();
        peer.join()?;
        Ok(record)
    }

    fn peer_records(&self) -> Vec<PeerRecord> {
        self.peers
            .lock()
            .map(|peers| peers.values().map(|peer| peer.record()).collect())
            .unwrap_or_default()
    }

    fn send_targets(&self, target: Option<&Value>) -> TcpResult<Vec<Arc<TcpPeer>>> {
        let peers = self.peers.lock().map_err(poisoned)?;
        let broadcast = target.is_some_and(|value| {
            value.get("type").and_then(Value::as_str) == Some("broadcast")
                || value.get("broadcast").and_then(Value::as_bool) == Some(true)
        });
        if broadcast {
            if peers.is_empty() {
                return Err(SerialError::new(
                    SerialErrorCode::PortNotFound,
                    format!("Endpoint {} has no connected peers", self.endpoint_id),
                ));
            }
            return Ok(peers.values().cloned().collect());
        }
        if target
            .and_then(|value| value.get("type"))
            .and_then(Value::as_str)
            == Some("peer")
        {
            let peer_ids = target
                .and_then(|value| value.get("peerIds"))
                .and_then(Value::as_array)
                .filter(|values| !values.is_empty())
                .ok_or_else(|| config_error("target.peerIds must be a nonempty array"))?;
            let mut selected = Vec::with_capacity(peer_ids.len());
            let mut seen = std::collections::HashSet::with_capacity(peer_ids.len());
            for value in peer_ids {
                let peer_id = value
                    .as_str()
                    .ok_or_else(|| config_error("target.peerIds must contain strings"))?;
                require_id(peer_id, "target.peerIds[]")?;
                if !seen.insert(peer_id) {
                    return Err(config_error("target.peerIds must not contain duplicates"));
                }
                selected.push(peers.get(peer_id).cloned().ok_or_else(|| {
                    SerialError::new(
                        SerialErrorCode::PortNotFound,
                        format!("TCP peer {peer_id} is not connected"),
                    )
                })?);
            }
            return Ok(selected);
        }
        let peer_id = target
            .and_then(|value| value.get("peerId"))
            .and_then(Value::as_str)
            .ok_or_else(|| {
                SerialError::new(
                    SerialErrorCode::IoError,
                    "target.peerId must be a nonblank string",
                )
            })?;
        require_id(peer_id, "target.peerId")?;
        peers
            .get(peer_id)
            .cloned()
            .map(|peer| vec![peer])
            .ok_or_else(|| {
                SerialError::new(
                    SerialErrorCode::PortNotFound,
                    format!("TCP peer {peer_id} is not connected"),
                )
            })
    }
}

struct TcpPeer {
    id: String,
    remote_address: String,
    connected_at: u64,
    stream: Mutex<TcpStream>,
    reader: Mutex<Option<JoinHandle<()>>>,
    framer: Mutex<Framer>,
    closed: AtomicBool,
    #[cfg(test)]
    fail_next_write: AtomicBool,
}

impl TcpPeer {
    fn record(&self) -> PeerRecord {
        PeerRecord {
            id: self.id.clone(),
            remote_address: self.remote_address.clone(),
            connected_at: self.connected_at,
        }
    }

    fn close(&self) {
        self.closed.store(true, Ordering::SeqCst);
        if let Ok(stream) = self.stream.lock() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }

    fn join(&self) -> TcpResult<()> {
        if let Some(reader) = self.reader.lock().map_err(poisoned)?.take() {
            reader.join().map_err(|_| {
                SerialError::new(SerialErrorCode::IoError, "TCP peer reader thread panicked")
            })?;
        }
        Ok(())
    }
}

#[derive(Clone)]
struct TcpConfig {
    host: String,
    port: u16,
    receive_framing: ReceiveFraming,
    keep_alive: TcpKeepAliveConfig,
}

#[derive(Clone, Copy)]
struct TcpKeepAliveConfig {
    enabled: bool,
    initial_delay: Duration,
}

impl TcpConfig {
    fn client_from_value(value: &Value) -> TcpResult<Self> {
        let config = Self::from_value(value, "host", "port")?;
        if config.port == 0 {
            return Err(config_error("config.port must be greater than zero"));
        }
        Ok(config)
    }

    fn server_from_value(value: &Value) -> TcpResult<Self> {
        Self::from_value(value, "listenHost", "listenPort")
    }

    fn from_value(value: &Value, host_field: &str, port_field: &str) -> TcpResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| config_error("tcp endpoint config must be an object"))?;
        let host = object
            .get(host_field)
            .and_then(Value::as_str)
            .ok_or_else(|| config_error(format!("config.{host_field} must be a nonblank string")))?
            .trim();
        if host.is_empty() {
            return Err(config_error(format!(
                "config.{host_field} must be a nonblank string"
            )));
        }
        let port = object
            .get(port_field)
            .and_then(Value::as_u64)
            .filter(|port| *port <= u16::MAX as u64)
            .ok_or_else(|| config_error(format!("config.{port_field} must be a TCP port")))?;
        Ok(Self {
            host: host.into(),
            port: port as u16,
            receive_framing: ReceiveFraming::from_config(object.get("receiveFraming"))?,
            keep_alive: TcpKeepAliveConfig::from_config(object.get("keepAlive"))?,
        })
    }

    fn label(&self) -> String {
        format!("{}:{}", self.host, self.port)
    }
}

impl TcpKeepAliveConfig {
    fn from_config(value: Option<&Value>) -> TcpResult<Self> {
        let Some(value) = value else {
            return Ok(Self {
                enabled: true,
                initial_delay: Duration::from_secs(30),
            });
        };
        let object = value
            .as_object()
            .filter(|object| {
                object.len() == 2
                    && object.contains_key("enabled")
                    && object.contains_key("initialDelaySeconds")
            })
            .ok_or_else(|| {
                config_error(
                    "config.keepAlive must contain exactly enabled and initialDelaySeconds",
                )
            })?;
        let enabled = object
            .get("enabled")
            .and_then(Value::as_bool)
            .ok_or_else(|| config_error("config.keepAlive.enabled must be a boolean"))?;
        let initial_delay_seconds = object
            .get("initialDelaySeconds")
            .and_then(Value::as_u64)
            .filter(|seconds| (1..=3600).contains(seconds))
            .ok_or_else(|| {
                config_error(
                    "config.keepAlive.initialDelaySeconds must be an integer from 1 through 3600",
                )
            })?;
        Ok(Self {
            enabled,
            initial_delay: Duration::from_secs(initial_delay_seconds),
        })
    }
}

fn open_ack(session: &TcpSession) -> serial::OpenAcknowledgement {
    serial::OpenAcknowledgement {
        endpoint_id: session.endpoint_id.clone(),
        operation_id: session.operation_id.clone(),
        session_id: session.session_id.clone(),
    }
}

fn accept_loop(sink: SharedEventSink, session: Arc<TcpSession>, listener: TcpListener) {
    while !session.stop.load(Ordering::SeqCst) {
        match listener.accept() {
            Ok((stream, address)) => {
                let peer_id = format!(
                    "tcp-peer-{}",
                    session.next_peer_id.fetch_add(1, Ordering::SeqCst) + 1
                );
                let peer_record = PeerRecord {
                    id: peer_id.clone(),
                    remote_address: address.to_string(),
                    connected_at: now_millis(),
                };
                #[cfg(test)]
                let setup_error = session
                    .fail_before_accepted_stream_config
                    .as_ref()
                    .map(|hook| hook())
                    .map(Err)
                    .unwrap_or_else(|| configure_stream(&stream, session.keep_alive));
                #[cfg(not(test))]
                let setup_error = configure_stream(&stream, session.keep_alive);
                if setup_error.is_err() {
                    let _ = stream.shutdown(Shutdown::Both);
                    emit_peer_log_with_sink(
                        &sink,
                        &session,
                        &peer_record,
                        "warn",
                        format!("TCP peer setup failed: {}", peer_record.remote_address),
                    );
                    continue;
                }
                let read_stream = match stream.try_clone() {
                    Ok(stream) => stream,
                    Err(_) => {
                        let _ = stream.shutdown(Shutdown::Both);
                        continue;
                    }
                };
                let peer = Arc::new(TcpPeer {
                    id: peer_id.clone(),
                    remote_address: peer_record.remote_address,
                    connected_at: peer_record.connected_at,
                    stream: Mutex::new(stream),
                    reader: Mutex::new(None),
                    framer: Mutex::new(Framer::new(session.receive_framing.clone())),
                    closed: AtomicBool::new(false),
                    #[cfg(test)]
                    fail_next_write: AtomicBool::new(false),
                });
                session
                    .peers
                    .lock()
                    .map(|mut peers| peers.insert(peer_id, peer.clone()))
                    .ok();
                emit_peers_with_sink(&sink, &session, session.peer_records());
                emit_peer_log_with_sink(
                    &sink,
                    &session,
                    &peer.record(),
                    "info",
                    format!("TCP peer connected: {}", peer.remote_address),
                );
                let reader_sink = sink.clone();
                let reader_session = session.clone();
                let reader_peer = peer.clone();
                let reader = thread::Builder::new()
                    .name(format!("tcp-peer-read-{}", reader_peer.id))
                    .spawn(move || {
                        read_stream_loop(
                            reader_sink,
                            reader_session,
                            Some(reader_peer),
                            read_stream,
                            None,
                        )
                    });
                if let Ok(reader) = reader {
                    *peer.reader.lock().unwrap() = Some(reader);
                }
            }
            Err(error) if error.kind() == io::ErrorKind::WouldBlock => {
                flush_due(&sink, &session, now_millis());
                thread::sleep(ACCEPT_POLL);
            }
            Err(_) => break,
        }
    }
    flush_session(&sink, &session);
}

fn read_stream_loop(
    sink: SharedEventSink,
    session: Arc<TcpSession>,
    peer: Option<Arc<TcpPeer>>,
    mut stream: TcpStream,
    lifecycle: Option<Arc<Mutex<TcpLifecycle>>>,
) {
    let mut buffer = [0_u8; 8192];
    loop {
        if session.stop.load(Ordering::SeqCst)
            || peer
                .as_ref()
                .is_some_and(|peer| peer.closed.load(Ordering::SeqCst))
        {
            break;
        }
        match stream.read(&mut buffer) {
            Ok(0) => {
                if peer.is_none() && !session.stop.load(Ordering::SeqCst) {
                    if let Some(lifecycle) = &lifecycle {
                        finalize_client_remote_close(&sink, lifecycle, &session);
                    }
                }
                break;
            }
            Ok(length) => {
                let now = now_millis();
                let (frames, failure) = match &peer {
                    Some(peer) => peer
                        .framer
                        .lock()
                        .map(|mut framer| {
                            let frames = framer.push(&buffer[..length], now);
                            (frames, framer.take_error())
                        })
                        .unwrap_or_default(),
                    None => session
                        .framer
                        .lock()
                        .map(|mut framer| {
                            let frames = framer.push(&buffer[..length], now);
                            (frames, framer.take_error())
                        })
                        .unwrap_or_default(),
                };
                for frame in frames {
                    enqueue_frame(
                        &sink,
                        &session,
                        "in",
                        peer.as_ref().map(|peer| peer.id.clone()),
                        frame,
                    );
                }
                if let Some(error) = failure {
                    emit_framing_failure(&sink, &session, peer.as_deref(), error);
                    let _ = stream.shutdown(Shutdown::Both);
                    if peer.is_none() {
                        if let Some(lifecycle) = &lifecycle {
                            finalize_client_remote_close(&sink, lifecycle, &session);
                        }
                    }
                    break;
                }
            }
            Err(error)
                if matches!(
                    error.kind(),
                    io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                ) => {}
            Err(_) => break,
        }
        let now = now_millis();
        let idle_frames = match &peer {
            Some(peer) => peer
                .framer
                .lock()
                .map(|mut framer| framer.flush_idle(now))
                .unwrap_or_default(),
            None => session
                .framer
                .lock()
                .map(|mut framer| framer.flush_idle(now))
                .unwrap_or_default(),
        };
        for frame in idle_frames {
            enqueue_frame(
                &sink,
                &session,
                "in",
                peer.as_ref().map(|peer| peer.id.clone()),
                frame,
            );
        }
        flush_due(&sink, &session, now);
    }
    if let Some(peer) = peer {
        flush_peer(&sink, &session, &peer);
        if !peer.closed.swap(true, Ordering::SeqCst) {
            let removed = session
                .peers
                .lock()
                .map(|mut peers| peers.remove(&peer.id).is_some())
                .unwrap_or(false);
            if removed {
                emit_peers_with_sink(&sink, &session, session.peer_records());
                emit_peer_log_with_sink(
                    &sink,
                    &session,
                    &peer.record(),
                    "warn",
                    format!(
                        "TCP peer disconnected unexpectedly: {}",
                        peer.remote_address
                    ),
                );
            }
        }
    }
    flush_session(&sink, &session);
}

fn emit_framing_failure(
    sink: &SharedEventSink,
    session: &Arc<TcpSession>,
    peer: Option<&TcpPeer>,
    error: SerialError,
) {
    if let Some(peer) = peer {
        flush_peer(sink, session, peer);
    } else {
        flush_session(sink, session);
    }
    let created_at = now_millis();
    let peer_id = peer.map(|peer| peer.id.clone());
    emit_event(
        sink,
        SerialEvent::Status(StatusEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: Some(session.session_id.clone()),
            status: if peer.is_some() {
                SerialStatus::Listening
            } else {
                SerialStatus::Error
            },
            error: peer.is_none().then(|| error.clone()),
            created_at,
            log: Some(StatusLog {
                level: if peer.is_some() { "warn" } else { "error" },
                source: "tcp",
                peer_id: peer_id.clone(),
                code: peer.is_none().then(|| "IO_ERROR".into()),
                message: format!("IO_ERROR: {}", error.message),
                details: Some(
                    serde_json::json!({ "endpointId": session.endpoint_id, "peerId": peer_id, "error": error }),
                ),
                created_at,
            }),
        }),
    );
}

fn finalize_client_remote_close(
    sink: &SharedEventSink,
    lifecycle: &Arc<Mutex<TcpLifecycle>>,
    session: &Arc<TcpSession>,
) {
    let removed = lifecycle
        .lock()
        .map(|mut lifecycle| {
            if lifecycle
                .sessions
                .get(&session.endpoint_id)
                .is_some_and(|current| current.generation == session.generation)
            {
                lifecycle.sessions.remove(&session.endpoint_id);
                true
            } else {
                false
            }
        })
        .unwrap_or(false);
    if !removed {
        return;
    }
    session.stop.store(true, Ordering::SeqCst);
    if let Ok(mut phase) = session.phase.lock() {
        *phase = TcpSessionPhase::Closed;
    }
    if let Ok(mut stream) = session.stream.lock() {
        if let Some(stream) = stream.take() {
            let _ = stream.shutdown(Shutdown::Both);
        }
    }
    flush_session(sink, session);
    let created_at = now_millis();
    emit_event(
        sink,
        SerialEvent::Status(StatusEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: None,
            status: SerialStatus::Closed,
            error: None,
            created_at,
            log: Some(StatusLog {
                level: "warn",
                source: "tcp",
                peer_id: None,
                code: None,
                message: format!("TCP remote closed: {}", session.remote_label),
                details: Some(serde_json::json!({ "endpointId": session.endpoint_id })),
                created_at,
            }),
        }),
    );
}

fn enqueue_frame(
    sink: &SharedEventSink,
    session: &Arc<TcpSession>,
    direction: &'static str,
    peer_id: Option<String>,
    bytes: Vec<u8>,
) {
    let now = now_millis();
    let frames = session
        .batcher
        .lock()
        .ok()
        .and_then(|mut batcher| batcher.push(direction, peer_id, bytes, now));
    if let Some(frames) = frames {
        emit_frames_with_sink(sink, session, frames);
    }
}

fn flush_due(sink: &SharedEventSink, session: &Arc<TcpSession>, now: u64) {
    let frames = session
        .batcher
        .lock()
        .ok()
        .and_then(|mut batcher| batcher.flush_due(now));
    if let Some(frames) = frames {
        emit_frames_with_sink(sink, session, frames);
    }
}

fn flush_session(sink: &SharedEventSink, session: &Arc<TcpSession>) {
    let final_frames = session
        .framer
        .lock()
        .map(|mut framer| framer.flush())
        .unwrap_or_default();
    let mut ready_batches = Vec::new();
    if let Ok(mut batcher) = session.batcher.lock() {
        let now = now_millis();
        for frame in final_frames {
            if let Some(frames) = batcher.push("in", None, frame, now) {
                ready_batches.push(frames);
            }
        }
        if let Some(frames) = batcher.flush() {
            ready_batches.push(frames);
        }
    }
    for frames in ready_batches {
        emit_frames_with_sink(sink, session, frames);
    }
}

fn flush_peer(sink: &SharedEventSink, session: &Arc<TcpSession>, peer: &TcpPeer) {
    let final_frames = peer
        .framer
        .lock()
        .map(|mut framer| framer.flush())
        .unwrap_or_default();
    let mut ready_batches = Vec::new();
    if let Ok(mut batcher) = session.batcher.lock() {
        let now = now_millis();
        for frame in final_frames {
            if let Some(frames) = batcher.push("in", Some(peer.id.clone()), frame, now) {
                ready_batches.push(frames);
            }
        }
        if let Some(frames) = batcher.flush() {
            ready_batches.push(frames);
        }
    }
    for frames in ready_batches {
        emit_frames_with_sink(sink, session, frames);
    }
}

fn emit_frames_with_sink(sink: &SharedEventSink, session: &TcpSession, frames: Vec<WireFrame>) {
    emit_event(
        sink,
        SerialEvent::Frames(FrameBatch {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: session.session_id.clone(),
            frames,
        }),
    );
}

fn emit_peers_with_sink(sink: &SharedEventSink, session: &TcpSession, peers: Vec<PeerRecord>) {
    emit_event(
        sink,
        SerialEvent::Peers(PeerEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: session.session_id.clone(),
            peers,
        }),
    );
}

fn emit_peer_log_with_sink(
    sink: &SharedEventSink,
    session: &TcpSession,
    peer: &PeerRecord,
    level: &'static str,
    message: String,
) {
    let created_at = now_millis();
    emit_event(
        sink,
        SerialEvent::Status(StatusEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: Some(session.session_id.clone()),
            status: SerialStatus::Listening,
            error: None,
            created_at,
            log: Some(StatusLog {
                level,
                source: "tcp",
                peer_id: Some(peer.id.clone()),
                code: None,
                message,
                details: Some(serde_json::json!({
                    "peerId": peer.id,
                    "remoteAddress": peer.remote_address,
                })),
                created_at,
            }),
        }),
    );
}

fn emit_event(sink: &SharedEventSink, event: SerialEvent) {
    let sink = match sink.lock() {
        Ok(sink) => sink.clone(),
        Err(poisoned) => poisoned.into_inner().clone(),
    };
    if let Some(sink) = sink {
        sink.emit(event);
    }
}

fn tcp_status_log(
    session: &TcpSession,
    status: SerialStatus,
    error: Option<&SerialError>,
    details: Option<Value>,
    created_at: u64,
) -> Option<StatusLog> {
    let details =
        details.or_else(|| Some(serde_json::json!({ "endpointId": session.endpoint_id })));
    let lifecycle = |level, message| StatusLog {
        level,
        source: "tcp",
        peer_id: None,
        code: None,
        message,
        details: details.clone(),
        created_at,
    };
    match status {
        SerialStatus::Opening => Some(lifecycle(
            "debug",
            format!("Opening TCP endpoint: {}", session.remote_label),
        )),
        SerialStatus::Open => Some(lifecycle(
            "info",
            format!("TCP client connected: {}", session.remote_label),
        )),
        SerialStatus::Listening => Some(lifecycle(
            "info",
            format!("TCP server listening: {}", session.remote_label),
        )),
        SerialStatus::Closing => Some(lifecycle(
            "debug",
            format!("Closing TCP endpoint: {}", session.endpoint_id),
        )),
        SerialStatus::Closed => Some(lifecycle(
            "info",
            format!("TCP endpoint closed: {}", session.endpoint_id),
        )),
        SerialStatus::Error => {
            let error = error?;
            Some(StatusLog {
                level: "error",
                source: "tcp",
                peer_id: None,
                code: Some(error_code_name(error.code).into()),
                message: format!("TCP operation failed: {}", session.endpoint_id),
                details,
                created_at,
            })
        }
    }
}

fn connect_tcp(session: &TcpSession, host: &str, port: u16) -> io::Result<TcpStream> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()?;
    runtime.block_on(async {
        tokio::select! {
            biased;
            _ = async {
                while !session.stop.load(Ordering::SeqCst) { tokio::time::sleep(ACCEPT_POLL).await; }
            } => Err(io::Error::new(io::ErrorKind::Interrupted, "TCP open cancelled")),
            result = tokio::net::TcpStream::connect((host, port)) => {
                let stream = result?.into_std()?;
                stream.set_nonblocking(false)?;
                Ok(stream)
            }
        }
    })
}

fn configure_stream(stream: &TcpStream, keep_alive: TcpKeepAliveConfig) -> TcpResult<()> {
    // macOS accepted sockets inherit the nonblocking listener mode. write_all
    // needs blocking writes with the bounded timeout below to complete a payload.
    stream.set_nonblocking(false).map_err(map_tcp_error)?;
    let socket = socket2::SockRef::from(stream);
    socket
        .set_keepalive(keep_alive.enabled)
        .map_err(map_tcp_error)?;
    if keep_alive.enabled {
        let options = socket2::TcpKeepalive::new().with_time(keep_alive.initial_delay);
        socket.set_tcp_keepalive(&options).map_err(map_tcp_error)?;
    }
    stream.set_nodelay(true).map_err(map_tcp_error)?;
    stream
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(map_tcp_error)?;
    stream
        .set_write_timeout(Some(WRITE_TIMEOUT))
        .map_err(map_tcp_error)
}

fn require_id(value: &str, field: &str) -> TcpResult<()> {
    if value.trim().is_empty() {
        Err(config_error(format!("{field} must be a nonblank string")))
    } else {
        Ok(())
    }
}

fn config_error(message: impl Into<String>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, message)
}

fn tcp_shutdown_error() -> SerialError {
    SerialError::new(SerialErrorCode::IoError, "TCP service is shutting down")
}

fn poisoned<T>(_error: std::sync::PoisonError<T>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, "TCP service mutex poisoned")
}

fn map_tcp_error(error: io::Error) -> SerialError {
    let code = match error.kind() {
        io::ErrorKind::ConnectionRefused | io::ErrorKind::NotFound => SerialErrorCode::PortNotFound,
        io::ErrorKind::AddrInUse => SerialErrorCode::PortBusy,
        io::ErrorKind::PermissionDenied => SerialErrorCode::PermissionDenied,
        _ => SerialErrorCode::IoError,
    };
    SerialError::new(code, error.to_string())
}

fn error_code_name(code: SerialErrorCode) -> &'static str {
    match code {
        SerialErrorCode::PortNotFound => "PORT_NOT_FOUND",
        SerialErrorCode::PortBusy => "PORT_BUSY",
        SerialErrorCode::PermissionDenied => "PERMISSION_DENIED",
        SerialErrorCode::OpenCancelled => "OPEN_CANCELLED",
        SerialErrorCode::DeviceRemoved => "DEVICE_REMOVED",
        SerialErrorCode::ModbusException => "MODBUS_EXCEPTION",
        SerialErrorCode::IoError => "IO_ERROR",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

struct FrameBatcher {
    started_at: u64,
    frames: Vec<WireFrame>,
}

impl FrameBatcher {
    fn new(now: u64) -> Self {
        Self {
            started_at: now,
            frames: Vec::new(),
        }
    }

    fn push(
        &mut self,
        direction: &'static str,
        peer_id: Option<String>,
        bytes: Vec<u8>,
        created_at: u64,
    ) -> Option<Vec<WireFrame>> {
        if self.frames.is_empty() {
            self.started_at = created_at;
        }
        self.frames.push(WireFrame {
            message_type: None,
            framing: None,
            direction,
            peer_id,
            bytes,
            created_at,
        });
        (self.frames.len() >= FRAME_BATCH_LIMIT).then(|| self.take(created_at))
    }

    fn flush_due(&mut self, now: u64) -> Option<Vec<WireFrame>> {
        (!self.frames.is_empty() && now.saturating_sub(self.started_at) >= FRAME_BATCH_MILLIS)
            .then(|| self.take(now))
    }

    fn flush(&mut self) -> Option<Vec<WireFrame>> {
        (!self.frames.is_empty()).then(|| self.take(now_millis()))
    }

    fn take(&mut self, now: u64) -> Vec<WireFrame> {
        self.started_at = now;
        std::mem::take(&mut self.frames)
    }
}

struct Framer {
    mode: ReceiveFraming,
    pending: Vec<u8>,
    last_input_at: Option<u64>,
    failure: Option<SerialError>,
}

impl Framer {
    fn new(mode: ReceiveFraming) -> Self {
        Self {
            mode,
            pending: Vec::new(),
            last_input_at: None,
            failure: None,
        }
    }

    fn push(&mut self, bytes: &[u8], now: u64) -> Vec<Vec<u8>> {
        if bytes.is_empty() {
            return Vec::new();
        }
        match &self.mode {
            ReceiveFraming::Raw => vec![bytes.to_vec()],
            ReceiveFraming::Delimiter(delimiter) => {
                let delimiter = delimiter.clone();
                let mut frames = Vec::new();
                let mut remaining = bytes;
                while !remaining.is_empty() {
                    let available = MAX_PENDING_FRAME_BYTES - self.pending.len();
                    if available == 0 {
                        self.reject_overflow();
                        break;
                    }
                    let length = available.min(remaining.len());
                    let mut scan_start = self.pending.len().saturating_sub(delimiter.len() - 1);
                    self.append_bounded(&remaining[..length]);
                    remaining = &remaining[length..];
                    while let Some(offset) = find_subslice(&self.pending[scan_start..], &delimiter)
                    {
                        let index = scan_start + offset;
                        frames.push(self.pending[..index].to_vec());
                        self.pending.drain(..index + delimiter.len());
                        scan_start = 0;
                    }
                }
                frames
            }
            ReceiveFraming::Fixed(length) => {
                let length = *length;
                self.pending.extend_from_slice(bytes);
                let mut frames = Vec::new();
                while self.pending.len() >= length {
                    frames.push(self.pending.drain(..length).collect());
                }
                frames
            }
            ReceiveFraming::Idle(_) => {
                if bytes.len() > MAX_PENDING_FRAME_BYTES - self.pending.len() {
                    self.reject_overflow();
                    return Vec::new();
                }
                self.append_bounded(bytes);
                self.last_input_at = Some(now);
                Vec::new()
            }
        }
    }

    fn append_bounded(&mut self, bytes: &[u8]) {
        let required = self.pending.len() + bytes.len();
        if self.pending.capacity() < required {
            let capacity = required
                .max(self.pending.capacity().saturating_mul(2))
                .min(MAX_PENDING_FRAME_BYTES);
            self.pending.reserve_exact(capacity - self.pending.len());
        }
        self.pending.extend_from_slice(bytes);
    }

    fn reject_overflow(&mut self) {
        self.pending = Vec::new();
        self.last_input_at = None;
        self.failure = Some(SerialError::new(
            SerialErrorCode::IoError,
            format!(
                "Receive pending frame exceeds {} bytes; connection must be reopened",
                MAX_PENDING_FRAME_BYTES
            ),
        ));
    }

    fn take_error(&mut self) -> Option<SerialError> {
        self.failure.take()
    }

    fn flush_idle(&mut self, now: u64) -> Vec<Vec<u8>> {
        let ReceiveFraming::Idle(duration) = self.mode else {
            return Vec::new();
        };
        let elapsed = self
            .last_input_at
            .is_some_and(|last| now.saturating_sub(last) >= duration.as_millis() as u64);
        if elapsed && !self.pending.is_empty() {
            self.last_input_at = None;
            vec![std::mem::take(&mut self.pending)]
        } else {
            Vec::new()
        }
    }

    fn flush(&mut self) -> Vec<Vec<u8>> {
        if self.pending.is_empty() {
            Vec::new()
        } else {
            self.last_input_at = None;
            vec![std::mem::take(&mut self.pending)]
        }
    }
}

fn find_subslice(values: &[u8], needle: &[u8]) -> Option<usize> {
    values
        .windows(needle.len())
        .position(|candidate| candidate == needle)
}

#[cfg(test)]
mod tests {

    #[test]
    fn cancel_open_is_scoped_to_the_operation_and_releases_the_reservation() {
        let service = TcpService::new(Arc::new(RecordingTcpSink::default()));
        let session = service
            .create_session(
                super::TcpSessionKind::Client,
                "cancel-test".into(),
                "open-1",
                "review".into(),
                super::ReceiveFraming::Raw,
                super::TcpKeepAliveConfig {
                    enabled: false,
                    initial_delay: Duration::ZERO,
                },
            )
            .unwrap();
        assert!(
            !service
                .cancel_open("cancel-test", "old-open")
                .unwrap()
                .cancelled
        );
        assert!(!session.stop.load(Ordering::SeqCst));
        assert!(
            service
                .cancel_open("cancel-test", "open-1")
                .unwrap()
                .cancelled
        );
        assert!(session.stop.load(Ordering::SeqCst));
        assert!(!service
            .lifecycle
            .lock()
            .unwrap()
            .sessions
            .contains_key("cancel-test"));
        service.end_open();
    }

    #[test]
    fn pending_frame_overflow_disconnects_only_the_affected_tcp_connection() {
        for framing in [
            json!({ "mode": "delimiter", "delimiterBytes": [0] }),
            json!({ "mode": "idle", "idleMs": 60000 }),
        ] {
            let sink = Arc::new(RecordingTcpSink::default());
            let service = TcpService::new(sink.clone());
            service
                .open(
                    tcp_server_endpoint("overflow-server", framing.clone()),
                    "open-overflow-server",
                )
                .unwrap();
            let port =
                listening_port(&sink.wait_for_status("overflow-server", SerialStatus::Listening));
            let healthy = TcpStream::connect(("127.0.0.1", port)).unwrap();
            sink.wait_for_peer_count("overflow-server", 1);
            let mut oversized = TcpStream::connect(("127.0.0.1", port)).unwrap();
            sink.wait_for_peer_count("overflow-server", 2);
            oversized.write_all(&vec![1; 1024 * 1024 + 1]).unwrap();
            sink.wait_for_log("overflow-server", |log| {
                log.message.contains("pending frame exceeds")
            });
            sink.wait_for_peer_count("overflow-server", 1);
            let statuses = sink.statuses("overflow-server");
            let failure = statuses
                .iter()
                .find(|status| {
                    status
                        .log
                        .as_ref()
                        .is_some_and(|log| log.message.contains("pending frame exceeds"))
                })
                .unwrap();
            assert_eq!(failure.status, SerialStatus::Listening);
            assert!(failure.error.is_none());
            assert_eq!(failure.log.as_ref().unwrap().level, "warn");
            assert!(failure.log.as_ref().unwrap().code.is_none());
            assert_eq!(
                failure.log.as_ref().unwrap().details.as_ref().unwrap()["error"]["code"],
                "IO_ERROR"
            );
            assert!(failure.log.as_ref().unwrap().peer_id.is_some());
            assert!(sink.frames().is_empty());
            drop(healthy);
            service.close("overflow-server").unwrap();

            let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
            let mut endpoint =
                tcp_client_endpoint("overflow-client", listener.local_addr().unwrap());
            endpoint.config["receiveFraming"] = framing;
            service.open(endpoint, "open-overflow-client").unwrap();
            let (mut remote, _) = listener.accept().unwrap();
            remote.write_all(&vec![1; 1024 * 1024 + 1]).unwrap();
            let failure = sink.wait_for_status("overflow-client", SerialStatus::Error);
            assert_eq!(
                failure.error.as_ref().unwrap().code,
                SerialErrorCode::IoError
            );
            assert!(failure
                .error
                .as_ref()
                .unwrap()
                .message
                .contains("pending frame exceeds 1048576 bytes"));
            sink.wait_for_status("overflow-client", SerialStatus::Closed);
            assert!(sink.frames().is_empty());
            service.shutdown().unwrap();
        }
    }
    #[test]
    fn pending_frame_overflow_releases_delimiter_and_idle_buffers() {
        let limit = 1024 * 1024;
        for mode in [
            super::ReceiveFraming::Delimiter(vec![0]),
            super::ReceiveFraming::Idle(std::time::Duration::from_millis(50)),
        ] {
            let mut framer = super::Framer::new(mode);
            for n in 0..128 {
                assert!(framer.push(&vec![1; 8192], n).is_empty());
            }
            assert!(framer.push(&[1], 128).is_empty());
            assert!(
                framer.pending.is_empty(),
                "overflow must release the incomplete frame"
            );
            assert_eq!(framer.pending.capacity(), 0);
            let error = framer.take_error().unwrap();
            assert_eq!(error.code, super::SerialErrorCode::IoError);
            assert!(error.message.contains("1048576 bytes"));
            assert!(framer.flush().is_empty());
            assert!(framer.flush_idle(1000).is_empty());
        }
        let mut framer = super::Framer::new(super::ReceiveFraming::Delimiter(vec![0, 0]));
        assert!(framer.push(&vec![1; limit - 2], 1).is_empty());
        assert!(framer.push(&[0], 2).is_empty());
        let frames = framer.push(&[0], 3);
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].len(), limit - 2);
        let mut chunk = vec![1; limit * 2];
        for n in (8190..chunk.len()).step_by(8192) {
            chunk[n] = 0;
            chunk[n + 1] = 0;
        }
        assert_eq!(framer.push(&chunk, 4).len(), 256);
    }

    use std::{
        io::{Read, Write},
        net::{Shutdown, SocketAddr, TcpListener, TcpStream},
        sync::{
            atomic::{AtomicBool, Ordering},
            Arc, Condvar, Mutex,
        },
        time::{Duration, Instant},
    };

    use serde_json::json;

    use crate::serial::{
        FrameBatch, PeerEvent, SerialErrorCode, SerialEvent, SerialEventSink, SerialStatus,
        StatusEvent, StatusLog,
    };

    use super::{configure_stream, TcpConfig, TcpEndpoint, TcpKeepAliveConfig, TcpService};

    #[derive(Default)]
    struct RecordingTcpSink {
        events: Mutex<Vec<SerialEvent>>,
        changed: Condvar,
    }

    impl SerialEventSink for RecordingTcpSink {
        fn emit(&self, event: SerialEvent) {
            self.events.lock().unwrap().push(event);
            self.changed.notify_all();
        }
    }

    impl RecordingTcpSink {
        fn frames(&self) -> Vec<FrameBatch> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| match event {
                    SerialEvent::Frames(batch) => Some(batch.clone()),
                    _ => None,
                })
                .collect()
        }

        fn statuses(&self, endpoint_id: &str) -> Vec<StatusEvent> {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter_map(|event| match event {
                    SerialEvent::Status(status) if status.endpoint_id == endpoint_id => {
                        Some(status.clone())
                    }
                    _ => None,
                })
                .collect()
        }

        fn event_count(&self) -> usize {
            self.events.lock().unwrap().len()
        }

        fn frame_count(&self) -> usize {
            self.frames()
                .iter()
                .map(|batch| batch.frames.len())
                .sum::<usize>()
        }

        fn log_count(&self) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(
                    |event| matches!(event, SerialEvent::Status(status) if status.log.is_some()),
                )
                .count()
        }

        fn peer_frame_count(&self) -> usize {
            self.frames()
                .iter()
                .flat_map(|batch| batch.frames.iter())
                .filter(|frame| frame.peer_id.is_some())
                .count()
        }

        fn tcp_log_count(&self) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    matches!(
                        event,
                        SerialEvent::Status(status)
                            if status.log.as_ref().is_some_and(|log| log.source == "tcp")
                    )
                })
                .count()
        }

        fn wait_for_inbound(&self, endpoint_id: &str) {
            self.wait_for_frame(endpoint_id, |frame| frame.direction == "in");
        }

        fn wait_for_frame(
            &self,
            endpoint_id: &str,
            predicate: impl Fn(&crate::serial::WireFrame) -> bool,
        ) {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            while !events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Frames(batch)
                        if batch.endpoint_id == endpoint_id
                            && batch.frames.iter().any(&predicate)
                )
            }) {
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .expect("timed out waiting for inbound TCP frame");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(
                    !timeout.timed_out(),
                    "timed out waiting for inbound TCP frame"
                );
            }
        }

        fn wait_for_status(&self, endpoint_id: &str, status: SerialStatus) -> StatusEvent {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            loop {
                if let Some(status) = events.iter().find_map(|event| match event {
                    SerialEvent::Status(event)
                        if event.endpoint_id == endpoint_id && event.status == status =>
                    {
                        Some(event.clone())
                    }
                    _ => None,
                }) {
                    return status;
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .expect("timed out waiting for TCP status");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for TCP status");
            }
        }

        fn wait_for_peer_count(&self, endpoint_id: &str, count: usize) -> PeerEvent {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            loop {
                if let Some(peers) = events.iter().rev().find_map(|event| match event {
                    SerialEvent::Peers(event)
                        if event.endpoint_id == endpoint_id && event.peers.len() == count =>
                    {
                        Some(event.clone())
                    }
                    _ => None,
                }) {
                    return peers;
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .expect("timed out waiting for TCP peers");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for TCP peers");
            }
        }

        fn wait_for_log(&self, endpoint_id: &str, predicate: impl Fn(&StatusLog) -> bool) {
            let deadline = Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            loop {
                if events.iter().any(|event| {
                    matches!(
                        event,
                        SerialEvent::Status(status)
                            if status.endpoint_id == endpoint_id
                                && status.log.as_ref().is_some_and(&predicate)
                    )
                }) {
                    return;
                }
                let remaining = deadline
                    .checked_duration_since(Instant::now())
                    .expect("timed out waiting for TCP log");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for TCP log");
            }
        }
    }

    fn tcp_client_endpoint(endpoint_id: &str, address: SocketAddr) -> TcpEndpoint {
        TcpEndpoint {
            endpoint_id: endpoint_id.into(),
            transport: "tcp-client".into(),
            config: json!({
                "host": address.ip().to_string(),
                "port": address.port(),
                "receiveFraming": { "mode": "raw" }
            }),
        }
    }

    fn tcp_server_endpoint(endpoint_id: &str, receive_framing: serde_json::Value) -> TcpEndpoint {
        TcpEndpoint {
            endpoint_id: endpoint_id.into(),
            transport: "tcp-server".into(),
            config: json!({
                "listenHost": "127.0.0.1",
                "listenPort": 0,
                "receiveFraming": receive_framing
            }),
        }
    }

    #[test]
    fn tcp_config_enforces_client_and_server_shapes() {
        assert!(TcpConfig::client_from_value(&json!({
            "host": "127.0.0.1",
            "port": 4100,
        }))
        .is_ok());
        assert!(TcpConfig::server_from_value(&json!({
            "listenHost": "127.0.0.1",
            "listenPort": 0,
        }))
        .is_ok());

        assert!(TcpConfig::client_from_value(&json!({
            "listenHost": "127.0.0.1",
            "listenPort": 4100,
        }))
        .is_err());
        assert!(TcpConfig::server_from_value(&json!({
            "host": "127.0.0.1",
            "port": 0,
        }))
        .is_err());
        assert!(TcpConfig::client_from_value(&json!({
            "port": 4100,
        }))
        .is_err());
        assert!(TcpConfig::server_from_value(&json!({
            "listenPort": 0,
        }))
        .is_err());
    }

    #[test]
    fn tcp_config_normalizes_and_validates_keepalive() {
        let legacy = TcpConfig::client_from_value(&json!({
            "host": "127.0.0.1", "port": 4100
        }))
        .unwrap();
        assert!(legacy.keep_alive.enabled);
        assert_eq!(legacy.keep_alive.initial_delay, Duration::from_secs(30));

        let disabled = TcpConfig::server_from_value(&json!({
            "listenHost": "127.0.0.1", "listenPort": 0,
            "keepAlive": { "enabled": false, "initialDelaySeconds": 3600 }
        }))
        .unwrap();
        assert!(!disabled.keep_alive.enabled);
        assert_eq!(disabled.keep_alive.initial_delay, Duration::from_secs(3600));

        for value in [json!(0), json!(3601), json!(1.5), json!("30")] {
            assert!(TcpConfig::client_from_value(&json!({
                "host": "127.0.0.1", "port": 4100,
                "keepAlive": { "enabled": true, "initialDelaySeconds": value }
            }))
            .is_err());
        }
    }

    #[test]
    fn configure_stream_applies_enabled_and_disabled_keepalive() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let client = TcpStream::connect(address).unwrap();
        let (server, _) = listener.accept().unwrap();

        configure_stream(
            &client,
            TcpKeepAliveConfig {
                enabled: true,
                initial_delay: Duration::from_secs(30),
            },
        )
        .unwrap();
        assert!(socket2::SockRef::from(&client).keepalive().unwrap());

        configure_stream(
            &server,
            TcpKeepAliveConfig {
                enabled: false,
                initial_delay: Duration::from_secs(30),
            },
        )
        .unwrap();
        assert!(!socket2::SockRef::from(&server).keepalive().unwrap());
    }

    fn listening_port(status: &StatusEvent) -> u16 {
        status
            .log
            .as_ref()
            .and_then(|log| log.details.as_ref())
            .and_then(|details| details.get("port"))
            .and_then(serde_json::Value::as_u64)
            .unwrap() as u16
    }

    #[test]
    #[ignore]
    fn real_tcp_transport_contract() {
        match std::env::var("INEED_PHASE04_TCP_MODE").as_deref() {
            Ok("server") => run_phase04_tauri_server_probe(),
            Ok("client") => run_phase04_tauri_client_probe(),
            _ => run_phase04_tauri_loopback_probe(),
        }
    }

    fn run_phase04_tauri_loopback_probe() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_server_endpoint("phase04-tauri-server", json!({ "mode": "raw" })),
                "open-tauri-server",
            )
            .unwrap();
        let port =
            listening_port(&sink.wait_for_status("phase04-tauri-server", SerialStatus::Listening));
        let mut peer = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let peer_id = sink.wait_for_peer_count("phase04-tauri-server", 1).peers[0]
            .id
            .clone();
        peer.write_all(&[0x31, 0x32]).unwrap();
        sink.wait_for_frame("phase04-tauri-server", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x31, 0x32]
        });
        service
            .send(
                "phase04-tauri-server",
                &[0x41, 0x42],
                Some(&json!({ "peerId": peer_id })),
            )
            .unwrap();
        let mut peer_buffer = [0_u8; 2];
        peer.read_exact(&mut peer_buffer).unwrap();
        assert_eq!(peer_buffer, [0x41, 0x42]);
        peer.shutdown(Shutdown::Both).ok();

        let echo = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let echo_address = echo.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = echo.accept().unwrap();
            let mut buffer = [0_u8; 1];
            socket.read_exact(&mut buffer).unwrap();
            socket.write_all(&[0x51, buffer[0]]).unwrap();
            socket.shutdown(Shutdown::Both).ok();
        });
        service
            .open(
                tcp_client_endpoint("phase04-tauri-client", echo_address),
                "open-tauri-client",
            )
            .unwrap();
        service.send("phase04-tauri-client", &[0x33], None).unwrap();
        sink.wait_for_frame("phase04-tauri-client", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x51, 0x33]
        });

        service.close("phase04-tauri-client").unwrap();
        service.close("phase04-tauri-server").unwrap();
        println!(
            "PHASE04_TAURI_RESULT={}",
            json!({
                "runtime": "tauri",
                "scenario": "tauri-loopback",
                "frames": sink.frame_count(),
                "logs": sink.log_count(),
                "peerFrames": sink.peer_frame_count(),
                "tcpLogs": sink.tcp_log_count(),
            })
        );
    }

    fn run_phase04_tauri_server_probe() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_server_endpoint("phase04-mixed-tauri-server", json!({ "mode": "raw" })),
                "open-mixed-tauri-server",
            )
            .unwrap();
        let port = listening_port(
            &sink.wait_for_status("phase04-mixed-tauri-server", SerialStatus::Listening),
        );
        println!(
            "PHASE04_TAURI_SERVER_READY={}",
            json!({
                "runtime": "tauri",
                "scenario": "electron-client-to-tauri-server",
                "port": port,
            })
        );
        std::io::stdout().flush().unwrap();
        let peer_id = sink
            .wait_for_peer_count("phase04-mixed-tauri-server", 1)
            .peers[0]
            .id
            .clone();
        sink.wait_for_frame("phase04-mixed-tauri-server", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x61, 0x62]
        });
        service
            .send(
                "phase04-mixed-tauri-server",
                &[0x71, 0x72],
                Some(&json!({ "peerId": peer_id })),
            )
            .unwrap();
        sink.wait_for_peer_count("phase04-mixed-tauri-server", 0);
        service.close("phase04-mixed-tauri-server").unwrap();
        println!(
            "PHASE04_TAURI_SERVER_RESULT={}",
            json!({
                "runtime": "tauri",
                "scenario": "electron-client-to-tauri-server",
                "frames": sink.frame_count(),
                "logs": sink.log_count(),
                "peerFrames": sink.peer_frame_count(),
                "tcpLogs": sink.tcp_log_count(),
            })
        );
    }

    fn run_phase04_tauri_client_probe() {
        let port = std::env::var("INEED_PHASE04_TCP_SERVER_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_client_endpoint(
                    "phase04-mixed-tauri-client",
                    SocketAddr::from(([127, 0, 0, 1], port)),
                ),
                "open-mixed-tauri-client",
            )
            .unwrap();
        service
            .send("phase04-mixed-tauri-client", &[0x81, 0x82], None)
            .unwrap();
        sink.wait_for_frame("phase04-mixed-tauri-client", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x91, 0x92]
        });
        service.close("phase04-mixed-tauri-client").unwrap();
        println!(
            "PHASE04_TAURI_CLIENT_RESULT={}",
            json!({
                "runtime": "tauri",
                "scenario": "tauri-client-to-electron-server",
                "frames": sink.frame_count(),
                "logs": sink.log_count(),
                "tcpLogs": sink.tcp_log_count(),
            })
        );
    }

    #[test]
    fn tcp_client_connects_to_localhost_echo_server_and_emits_frames() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut buffer = [0_u8; 2];
            socket.read_exact(&mut buffer).unwrap();
            socket.write_all(&[0x41, buffer[0], buffer[1]]).unwrap();
            socket.shutdown(Shutdown::Both).ok();
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));

        service
            .open(tcp_client_endpoint("tcp-client-1", address), "open-client")
            .unwrap();
        service.send("tcp-client-1", &[0x31, 0x32], None).unwrap();

        sink.wait_for_inbound("tcp-client-1");
        assert!(sink.frames().iter().any(|batch| {
            batch
                .frames
                .iter()
                .any(|frame| frame.direction == "in" && frame.bytes == vec![0x41, 0x31, 0x32])
        }));
        service.close("tcp-client-1").unwrap();
    }

    #[test]
    fn tcp_client_remote_close_removes_session_and_emits_terminal_log() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        let (close_tx, close_rx) = std::sync::mpsc::channel();
        let peer = std::thread::spawn(move || {
            let (socket, _) = server.accept().unwrap();
            close_rx.recv_timeout(Duration::from_secs(5)).unwrap();
            drop(socket);
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_client_endpoint("tcp-remote-close", address),
                "open-client",
            )
            .unwrap();

        close_tx.send(()).unwrap();
        // Writing while waiting can turn FIN into a reset on the peer. Observe
        // the receive-side close directly, then assert the session was retired.
        sink.wait_for_log("tcp-remote-close", |log| {
            log.level == "warn" && log.source == "tcp"
        });
        assert!(service.send("tcp-remote-close", &[1], None).is_err());
        peer.join().unwrap();
    }

    #[test]
    fn open_after_shutdown_is_rejected_and_detached_sink_drops_events() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));

        service.shutdown().unwrap();
        service.disconnect_event_sink();
        let error = service
            .open(tcp_client_endpoint("tcp-after-shutdown", address), "open")
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "TCP service is shutting down");
        assert_eq!(sink.event_count(), 0);
    }

    #[test]
    fn cancel_open_prevents_late_success_and_releases_real_resources() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        let peer = std::thread::spawn(move || {
            let (mut socket, _) = server.accept().unwrap();
            let mut byte = [0];
            let _ = socket.read(&mut byte);
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        let entered_hook = Arc::new((Mutex::new(false), Condvar::new()));
        let release_hook = Arc::new((Mutex::new(false), Condvar::new()));
        service.set_before_open_commit({
            let entered_hook = entered_hook.clone();
            let release_hook = release_hook.clone();
            Arc::new(move || {
                *entered_hook.0.lock().unwrap() = true;
                entered_hook.1.notify_all();
                let mut released = release_hook.0.lock().unwrap();
                while !*released {
                    released = release_hook.1.wait(released).unwrap();
                }
            })
        });
        let open_service = service.clone();
        let open_worker = std::thread::spawn(move || {
            open_service.open(tcp_client_endpoint("tcp-race", address), "open-race")
        });
        {
            let mut entered = entered_hook.0.lock().unwrap();
            while !*entered {
                entered = entered_hook.1.wait(entered).unwrap();
            }
        }
        assert!(
            !service
                .cancel_open("tcp-race", "wrong-operation")
                .unwrap()
                .cancelled
        );
        assert!(
            service
                .cancel_open("tcp-race", "open-race")
                .unwrap()
                .cancelled
        );
        *release_hook.0.lock().unwrap() = true;
        release_hook.1.notify_all();

        let error = open_worker.join().unwrap().unwrap_err();
        peer.join().unwrap();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "TCP service is shutting down");
        assert!(service.send("tcp-race", &[1], None).is_err());
        assert!(!sink
            .statuses("tcp-race")
            .iter()
            .any(|status| status.status == SerialStatus::Open));
    }

    #[test]
    fn shutdown_during_in_flight_open_prevents_late_success_and_session_leak() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (_socket, _) = server.accept().unwrap();
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        let entered_hook = Arc::new((Mutex::new(false), Condvar::new()));
        let release_hook = Arc::new((Mutex::new(false), Condvar::new()));
        service.set_before_open_commit({
            let entered_hook = entered_hook.clone();
            let release_hook = release_hook.clone();
            Arc::new(move || {
                *entered_hook.0.lock().unwrap() = true;
                entered_hook.1.notify_all();
                let mut released = release_hook.0.lock().unwrap();
                while !*released {
                    released = release_hook.1.wait(released).unwrap();
                }
            })
        });
        let open_service = service.clone();
        let open_worker = std::thread::spawn(move || {
            open_service.open(tcp_client_endpoint("tcp-race", address), "open-race")
        });
        {
            let mut entered = entered_hook.0.lock().unwrap();
            while !*entered {
                entered = entered_hook.1.wait(entered).unwrap();
            }
        }
        let shutdown_service = service.clone();
        let shutdown_done = Arc::new(AtomicBool::new(false));
        let shutdown_done_worker = shutdown_done.clone();
        let shutdown_worker = std::thread::spawn(move || {
            shutdown_service.shutdown().unwrap();
            shutdown_done_worker.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(25));
        assert!(!shutdown_done.load(Ordering::SeqCst));
        *release_hook.0.lock().unwrap() = true;
        release_hook.1.notify_all();

        let error = open_worker.join().unwrap().unwrap_err();
        shutdown_worker.join().unwrap();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "TCP service is shutting down");
        assert!(service.send("tcp-race", &[1], None).is_err());
        assert!(!sink
            .statuses("tcp-race")
            .iter()
            .any(|status| status.status == SerialStatus::Open));
    }

    #[test]
    fn shutdown_after_open_commit_check_cannot_return_late_success() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (_socket, _) = server.accept().unwrap();
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        let entered_hook = Arc::new((Mutex::new(false), Condvar::new()));
        let release_hook = Arc::new((Mutex::new(false), Condvar::new()));
        service.set_after_open_commit_check({
            let entered_hook = entered_hook.clone();
            let release_hook = release_hook.clone();
            Arc::new(move || {
                *entered_hook.0.lock().unwrap() = true;
                entered_hook.1.notify_all();
                let mut released = release_hook.0.lock().unwrap();
                while !*released {
                    released = release_hook.1.wait(released).unwrap();
                }
            })
        });
        let open_service = service.clone();
        let open_worker = std::thread::spawn(move || {
            open_service.open(
                tcp_client_endpoint("tcp-post-check-race", address),
                "open-race",
            )
        });
        {
            let mut entered = entered_hook.0.lock().unwrap();
            while !*entered {
                entered = entered_hook.1.wait(entered).unwrap();
            }
        }
        let shutdown_service = service.clone();
        let shutdown_done = Arc::new(AtomicBool::new(false));
        let shutdown_done_worker = shutdown_done.clone();
        let shutdown_worker = std::thread::spawn(move || {
            shutdown_service.shutdown().unwrap();
            shutdown_done_worker.store(true, Ordering::SeqCst);
        });
        std::thread::sleep(Duration::from_millis(25));
        assert!(!shutdown_done.load(Ordering::SeqCst));
        *release_hook.0.lock().unwrap() = true;
        release_hook.1.notify_all();

        let error = open_worker.join().unwrap().unwrap_err();
        shutdown_worker.join().unwrap();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "TCP service is shutting down");
        assert!(service.send("tcp-post-check-race", &[1], None).is_err());
        assert!(!sink
            .statuses("tcp-post-check-race")
            .iter()
            .any(|status| status.status == SerialStatus::Open));
    }

    #[test]
    fn force_shutdown_reports_active_open_fallback_without_waiting() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (_socket, _) = server.accept().unwrap();
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink));
        let entered_hook = Arc::new((Mutex::new(false), Condvar::new()));
        let release_hook = Arc::new((Mutex::new(false), Condvar::new()));
        service.set_before_open_commit({
            let entered_hook = entered_hook.clone();
            let release_hook = release_hook.clone();
            Arc::new(move || {
                *entered_hook.0.lock().unwrap() = true;
                entered_hook.1.notify_all();
                let mut released = release_hook.0.lock().unwrap();
                while !*released {
                    released = release_hook.1.wait(released).unwrap();
                }
            })
        });
        let open_service = service.clone();
        let open_worker = std::thread::spawn(move || {
            open_service.open(tcp_client_endpoint("tcp-force-race", address), "open-force")
        });
        {
            let mut entered = entered_hook.0.lock().unwrap();
            while !*entered {
                entered = entered_hook.1.wait(entered).unwrap();
            }
        }

        let fallback = service.force_shutdown();

        assert!(fallback
            .iter()
            .any(|message| message.contains("open operation")));
        *release_hook.0.lock().unwrap() = true;
        release_hook.1.notify_all();
        assert_eq!(
            open_worker.join().unwrap().unwrap_err().message,
            "TCP service is shutting down"
        );
    }

    #[test]
    fn failed_client_setup_removes_registered_session() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (_socket, _) = server.accept().unwrap();
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service.set_fail_before_client_reader(Arc::new(|| {
            crate::serial::SerialError::new(SerialErrorCode::IoError, "injected setup failure")
        }));

        let error = service
            .open(tcp_client_endpoint("tcp-setup-fail", address), "open-fail")
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "injected setup failure");
        assert!(service.send("tcp-setup-fail", &[1], None).is_err());
        let statuses = sink.statuses("tcp-setup-fail");
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Error)
                .count(),
            1
        );
    }

    #[test]
    fn accepted_stream_setup_failure_logs_warning_and_keeps_listener_active() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service.set_fail_before_accepted_stream_config(Arc::new(|| {
            crate::serial::SerialError::new(SerialErrorCode::IoError, "injected setup failure")
        }));
        service
            .open(
                tcp_server_endpoint("tcp-accepted-setup-fail", json!({ "mode": "raw" })),
                "open-server",
            )
            .unwrap();
        let port = listening_port(
            &sink.wait_for_status("tcp-accepted-setup-fail", SerialStatus::Listening),
        );

        let first_client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sink.wait_for_log("tcp-accepted-setup-fail", |log| {
            log.level == "warn"
                && log.peer_id.as_deref() == Some("tcp-peer-1")
                && log.message.starts_with("TCP peer setup failed: ")
                && log.details.as_ref().is_some_and(|details| {
                    details.get("peerId") == Some(&json!("tcp-peer-1"))
                        && details.get("remoteAddress").is_some()
                })
        });
        drop(first_client);

        let second_client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sink.wait_for_log("tcp-accepted-setup-fail", |log| {
            log.level == "warn" && log.peer_id.as_deref() == Some("tcp-peer-2")
        });
        drop(second_client);
        service.close("tcp-accepted-setup-fail").unwrap();
    }

    #[test]
    fn accepted_tcp_stream_completes_a_large_send_under_backpressure() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = TcpService::new(sink.clone());
        service
            .open(
                tcp_server_endpoint("large-server", json!({"mode":"raw"})),
                "open-large",
            )
            .unwrap();
        let port = listening_port(&sink.wait_for_status("large-server", SerialStatus::Listening));
        let mut remote = TcpStream::connect(("127.0.0.1", port)).unwrap();
        remote
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        sink.wait_for_peer_count("large-server", 1);
        let session = service.session("large-server").unwrap();
        {
            let peer = session
                .peers
                .lock()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .clone();
            let stream = peer.stream.lock().unwrap();
            socket2::SockRef::from(&*stream)
                .set_send_buffer_size(4096)
                .unwrap();
        }
        let reader = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(100));
            let mut bytes = Vec::new();
            remote.read_to_end(&mut bytes).unwrap();
            bytes
        });
        let payload = vec![0x42; 512 * 1024];
        let ack = service
            .send("large-server", &payload, Some(&json!({"type":"broadcast"})))
            .unwrap();
        service.close("large-server").unwrap();
        let received = reader.join().unwrap();
        assert_eq!(
            ack.failure_count,
            Some(0),
            "Accepted TCP stream stopped writing before the payload was complete"
        );
        assert_eq!(
            received.len(),
            payload.len(),
            "Large TCP payload was truncated"
        );
        assert!(received.iter().all(|byte| *byte == 0x42));
    }

    #[test]
    fn concurrent_tcp_client_sends_preserve_whole_payloads_under_backpressure() {
        const PAYLOAD_BYTES: usize = 512 * 1024;
        const WRITERS: usize = 4;
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        service
            .open(
                tcp_client_endpoint("concurrent-client", listener.local_addr().unwrap()),
                "open-concurrent",
            )
            .unwrap();
        let (mut remote, _) = listener.accept().unwrap();
        remote
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let session = service.session("concurrent-client").unwrap();
        {
            let stream = session.stream.lock().unwrap();
            socket2::SockRef::from(stream.as_ref().unwrap())
                .set_send_buffer_size(4096)
                .unwrap();
        }
        let ready = Arc::new(std::sync::Barrier::new(WRITERS));
        let writers = (1..=WRITERS)
            .map(|marker| {
                let service = service.clone();
                let ready = ready.clone();
                std::thread::spawn(move || {
                    let bytes = vec![marker as u8; PAYLOAD_BYTES];
                    ready.wait();
                    service.send("concurrent-client", &bytes, None).unwrap();
                })
            })
            .collect::<Vec<_>>();
        std::thread::sleep(Duration::from_millis(100));
        let mut received = vec![0; PAYLOAD_BYTES * WRITERS];
        remote.read_exact(&mut received).unwrap();
        for writer in writers {
            writer.join().unwrap();
        }
        service.close("concurrent-client").unwrap();
        let mut markers = Vec::new();
        for chunk in received.chunks_exact(PAYLOAD_BYTES) {
            let marker = chunk[0];
            assert!(
                chunk.iter().all(|byte| *byte == marker),
                "Concurrent TCP client sends interleaved payload bytes"
            );
            markers.push(marker);
        }
        markers.sort_unstable();
        assert_eq!(markers, vec![1, 2, 3, 4]);
    }

    #[test]
    fn concurrent_tcp_server_sends_preserve_whole_payloads_under_backpressure() {
        const PAYLOAD_BYTES: usize = 512 * 1024;
        const WRITERS: usize = 4;
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_server_endpoint("concurrent-server", json!({"mode":"raw"})),
                "open-concurrent",
            )
            .unwrap();
        let port =
            listening_port(&sink.wait_for_status("concurrent-server", SerialStatus::Listening));
        let mut remote = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sink.wait_for_peer_count("concurrent-server", 1);
        remote
            .set_read_timeout(Some(Duration::from_secs(10)))
            .unwrap();
        let session = service.session("concurrent-server").unwrap();
        {
            let peer = session
                .peers
                .lock()
                .unwrap()
                .values()
                .next()
                .unwrap()
                .clone();
            let stream = peer.stream.lock().unwrap();
            // Isolate concurrent writes from the accepted-socket mode regression.
            stream.set_nonblocking(false).unwrap();
            socket2::SockRef::from(&*stream)
                .set_send_buffer_size(4096)
                .unwrap();
        }
        let ready = Arc::new(std::sync::Barrier::new(WRITERS));
        let writers = (1..=WRITERS)
            .map(|marker| {
                let service = service.clone();
                let ready = ready.clone();
                std::thread::spawn(move || {
                    let bytes = vec![marker as u8; PAYLOAD_BYTES];
                    ready.wait();
                    service
                        .send(
                            "concurrent-server",
                            &bytes,
                            Some(&json!({ "type": "broadcast" })),
                        )
                        .unwrap();
                })
            })
            .collect::<Vec<_>>();
        std::thread::sleep(Duration::from_millis(100));
        let mut received = vec![0; PAYLOAD_BYTES * WRITERS];
        remote.read_exact(&mut received).unwrap();
        for writer in writers {
            writer.join().unwrap();
        }
        service.close("concurrent-server").unwrap();
        let mut markers = Vec::new();
        for chunk in received.chunks_exact(PAYLOAD_BYTES) {
            let marker = chunk[0];
            assert!(
                chunk.iter().all(|byte| *byte == marker),
                "Concurrent TCP server sends interleaved payload bytes"
            );
            markers.push(marker);
        }
        markers.sort_unstable();
        assert_eq!(markers, vec![1, 2, 3, 4]);
    }

    #[test]
    fn tcp_server_accepts_peer_sends_to_target_and_disconnects_peer() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_server_endpoint("tcp-server-1", json!({ "mode": "raw" })),
                "open-server",
            )
            .unwrap();
        let port = listening_port(&sink.wait_for_status("tcp-server-1", SerialStatus::Listening));
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        let peers = sink.wait_for_peer_count("tcp-server-1", 1);
        let peer_id = peers.peers[0].id.clone();
        sink.wait_for_log("tcp-server-1", |log| {
            log.peer_id.as_deref() == Some(&peer_id)
        });

        service
            .send("tcp-server-1", &[0x42], Some(&json!({ "peerId": peer_id })))
            .unwrap();
        let mut buffer = [0_u8; 1];
        client.read_exact(&mut buffer).unwrap();
        assert_eq!(buffer, [0x42]);
        client.write_all(&[0x21]).unwrap();
        sink.wait_for_frame("tcp-server-1", |frame| {
            frame.direction == "in" && frame.peer_id.as_deref() == Some(&peer_id)
        });
        sink.wait_for_frame("tcp-server-1", |frame| {
            frame.direction == "out" && frame.peer_id.as_deref() == Some(&peer_id)
        });

        service.disconnect_peer("tcp-server-1", &peer_id).unwrap();
        sink.wait_for_peer_count("tcp-server-1", 0);
        sink.wait_for_log("tcp-server-1", |log| {
            log.peer_id.as_deref() == Some(&peer_id) && log.message.contains("disconnected")
        });
        service.close("tcp-server-1").unwrap();
    }

    #[test]
    fn tcp_server_multi_peer_send_reports_partial_failures() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_server_endpoint("tcp-server-multi", json!({ "mode": "raw" })),
                "open-server",
            )
            .unwrap();
        let port =
            listening_port(&sink.wait_for_status("tcp-server-multi", SerialStatus::Listening));
        let mut clients = (0..3)
            .map(|_| {
                let client = TcpStream::connect(("127.0.0.1", port)).unwrap();
                client
                    .set_read_timeout(Some(Duration::from_secs(1)))
                    .unwrap();
                client
            })
            .collect::<Vec<_>>();
        let peers = sink.wait_for_peer_count("tcp-server-multi", 3).peers;
        let session = service.session("tcp-server-multi").unwrap();
        let failed_client_port = clients[1].local_addr().unwrap().port();
        let failed_peer_id = peers
            .iter()
            .find(|peer| {
                peer.remote_address
                    .ends_with(&format!(":{failed_client_port}"))
            })
            .unwrap()
            .id
            .clone();
        session
            .peers
            .lock()
            .unwrap()
            .get(&failed_peer_id)
            .unwrap()
            .fail_next_write
            .store(true, Ordering::SeqCst);
        let peer_ids = peers.iter().map(|peer| peer.id.clone()).collect::<Vec<_>>();

        let acknowledgement = service
            .send(
                "tcp-server-multi",
                &[0x41, 0x42],
                Some(&json!({ "type": "peer", "peerIds": peer_ids })),
            )
            .unwrap();

        for (index, client) in clients.iter_mut().enumerate() {
            if index == 1 {
                continue;
            }
            let mut bytes = [0_u8; 2];
            client.read_exact(&mut bytes).unwrap();
            assert_eq!(bytes, [0x41, 0x42]);
        }
        let results = acknowledgement.peer_results.unwrap();
        assert_eq!(results.len(), 3);
        assert_eq!(results.iter().filter(|result| result.ok).count(), 2);
        assert_eq!(
            results
                .iter()
                .find(|result| result.peer_id == failed_peer_id)
                .unwrap()
                .error
                .as_ref()
                .unwrap()
                .code,
            SerialErrorCode::IoError
        );

        for client in clients {
            client.shutdown(Shutdown::Both).ok();
        }
        service.close("tcp-server-multi").unwrap();
    }

    #[test]
    fn tcp_server_peer_disconnect_flushes_pending_delimiter_frame() {
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink.clone()));
        service
            .open(
                tcp_server_endpoint(
                    "tcp-server-delimiter",
                    json!({ "mode": "delimiter", "delimiterBytes": [10] }),
                ),
                "open-server",
            )
            .unwrap();
        let port =
            listening_port(&sink.wait_for_status("tcp-server-delimiter", SerialStatus::Listening));
        let mut client = TcpStream::connect(("127.0.0.1", port)).unwrap();
        sink.wait_for_peer_count("tcp-server-delimiter", 1);
        client.write_all(b"partial").unwrap();
        client.shutdown(Shutdown::Both).unwrap();

        sink.wait_for_frame("tcp-server-delimiter", |frame| {
            frame.direction == "in" && frame.bytes == b"partial"
        });
        service.close("tcp-server-delimiter").unwrap();
    }

    #[test]
    fn tcp_client_disconnect_peer_returns_controlled_io_error() {
        let server = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = server.local_addr().unwrap();
        std::thread::spawn(move || {
            let (_socket, _) = server.accept().unwrap();
        });
        let sink = Arc::new(RecordingTcpSink::default());
        let service = Arc::new(TcpService::new(sink));
        service
            .open(
                tcp_client_endpoint("tcp-client-peer", address),
                "open-client",
            )
            .unwrap();

        let error = service
            .disconnect_peer("tcp-client-peer", "tcp-peer-1")
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "Only TCP server peers can be disconnected");
        service.close("tcp-client-peer").unwrap();
    }
}
