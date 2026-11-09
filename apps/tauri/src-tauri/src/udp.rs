use std::{
    collections::HashMap,
    io,
    net::{SocketAddr, ToSocketAddrs, UdpSocket},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde_json::{json, Value};

use crate::serial::{
    self, FrameBatch, PeerEvent, PeerRecord, ReceiveFraming, SerialError, SerialErrorCode,
    SerialEvent, SerialStatus, StatusEvent, StatusLog, WireFrame,
};

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const FRAME_BATCH_MILLIS: u64 = 200;
const FRAME_BATCH_LIMIT: usize = 200;

type SharedEventSink = Arc<Mutex<Option<Arc<dyn serial::SerialEventSink>>>>;

pub(crate) type UdpResult<T> = Result<T, serial::SerialError>;

#[derive(Debug, Clone)]
pub(crate) struct UdpEndpoint {
    pub(crate) endpoint_id: String,
    pub(crate) transport: String,
    pub(crate) config: Value,
}

pub(crate) struct UdpService {
    sink: SharedEventSink,
    lifecycle: Arc<Mutex<UdpLifecycle>>,
    lifecycle_changed: Condvar,
    generation: AtomicU64,
    #[cfg(test)]
    before_open_commit: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    before_open_success: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    fail_next_open_read: AtomicBool,
    #[cfg(test)]
    before_send_history: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

struct UdpLifecycle {
    stopped: bool,
    active_opens: usize,
    sessions: HashMap<String, Arc<UdpSession>>,
}

impl UdpService {
    pub(crate) fn new(sink: Arc<dyn serial::SerialEventSink>) -> Self {
        Self {
            sink: Arc::new(Mutex::new(Some(sink))),
            lifecycle: Arc::new(Mutex::new(UdpLifecycle {
                stopped: false,
                active_opens: 0,
                sessions: HashMap::new(),
            })),
            lifecycle_changed: Condvar::new(),
            generation: AtomicU64::new(0),
            #[cfg(test)]
            before_open_commit: Mutex::new(None),
            #[cfg(test)]
            before_open_success: Mutex::new(None),
            #[cfg(test)]
            fail_next_open_read: AtomicBool::new(false),
            #[cfg(test)]
            before_send_history: Mutex::new(None),
        }
    }

    pub(crate) fn open(
        &self,
        endpoint: UdpEndpoint,
        operation_id: &str,
    ) -> UdpResult<serial::OpenAcknowledgement> {
        require_id(&endpoint.endpoint_id, "endpointId")?;
        require_id(operation_id, "operationId")?;
        match endpoint.transport.as_str() {
            "udp-client" => self.open_client(endpoint, operation_id),
            "udp-server" => self.open_server(endpoint, operation_id),
            _ => Err(SerialError::new(
                SerialErrorCode::IoError,
                format!("{} is not a UDP endpoint", endpoint.endpoint_id),
            )),
        }
    }

    pub(crate) fn send(
        &self,
        endpoint_id: &str,
        bytes: &[u8],
        target: Option<&Value>,
    ) -> UdpResult<serial::SendAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        let session = self.session(endpoint_id)?;
        // Datagram sends are atomic, but history insertion is a separate step.
        // Own both steps together so another IPC worker cannot reverse them.
        let _send_owner = session.send_owner.lock().map_err(poisoned)?;
        match session.kind {
            UdpSessionKind::Client => self.send_client(&session, bytes),
            UdpSessionKind::Server => self.send_server(&session, bytes, target),
        }
    }

    pub(crate) fn cancel_open(
        &self,
        endpoint_id: &str,
        operation_id: &str,
    ) -> UdpResult<serial::CancelAcknowledgement> {
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

    pub(crate) fn close(&self, endpoint_id: &str) -> UdpResult<serial::CloseAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        let session = self
            .lifecycle
            .lock()
            .map_err(poisoned)?
            .sessions
            .remove(endpoint_id);
        if let Some(session) = session {
            self.emit_status(&session, SerialStatus::Closing, None, None);
            session.close()?;
            flush_session(&self.sink, &session);
            session.peers.lock().map_err(poisoned)?.clear();
            self.emit_status(&session, SerialStatus::Closed, None, None);
            self.emit_peers(&session, Vec::new());
        }
        Ok(serial::CloseAcknowledgement {
            endpoint_id: endpoint_id.into(),
            closed: true,
        })
    }

    pub(crate) fn disconnect_peer(&self, _endpoint_id: &str, _peer_id: &str) -> UdpResult<Value> {
        Err(SerialError::new(
            SerialErrorCode::IoError,
            "UDP peers cannot be disconnected; they are passive",
        ))
    }

    pub(crate) fn close_all(&self) -> UdpResult<()> {
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

    pub(crate) fn shutdown(&self) -> UdpResult<()> {
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
                    "udp service lifecycle unavailable; process exit must reclaim resources".into(),
                ];
            }
        };
        let mut fallback = Vec::new();
        for session in sessions {
            emit_status_with_sink(&self.sink, &session, SerialStatus::Closing, None, None);
            if let Err(error) = session.close() {
                fallback.push(format!("{}: {}", session.endpoint_id, error.message));
            }
            flush_session(&self.sink, &session);
            if let Ok(mut peers) = session.peers.lock() {
                peers.clear();
            }
            emit_status_with_sink(&self.sink, &session, SerialStatus::Closed, None, None);
            emit_peers_with_sink(&self.sink, &session, Vec::new());
        }
        if active_opens > 0 {
            fallback.push(format!(
                "{active_opens} UDP open operation(s) still active during forced cleanup"
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

    fn session(&self, endpoint_id: &str) -> UdpResult<Arc<UdpSession>> {
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

    fn open_client(
        &self,
        endpoint: UdpEndpoint,
        operation_id: &str,
    ) -> UdpResult<serial::OpenAcknowledgement> {
        let config = UdpConfig::client_from_value(&endpoint.config)?;
        let session = self.create_session(
            UdpSessionKind::Client,
            endpoint.endpoint_id,
            operation_id,
            config.label(),
            config.receive_framing.clone(),
        )?;
        let _active_open = ActiveUdpOpen { service: self };
        self.emit_status(&session, SerialStatus::Opening, None, None);
        let socket = match UdpSocket::bind((config.bind_host.as_str(), config.bind_port)) {
            Ok(socket) => socket,
            Err(error) => {
                let error = map_udp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = configure_socket(&socket) {
            self.fail_open(&session, error.clone());
            return Err(error);
        }
        let local_address = match socket.local_addr() {
            Ok(address) => address,
            Err(error) => {
                let error = map_udp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        let read_socket = match socket.try_clone() {
            Ok(socket) => socket,
            Err(error) => {
                let error = map_udp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        let target = match config.target_addr_for(local_address.is_ipv4()) {
            Ok(target) => target,
            Err(error) => {
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        {
            let mut sock = session.socket.lock().map_err(poisoned)?;
            *sock = Some(socket);
        }
        *session.target.lock().map_err(poisoned)? = Some(target);
        let sink = self.sink.clone();
        let lifecycle = self.lifecycle.clone();
        let reader_session = session.clone();
        let reader = thread::Builder::new()
            .name(format!("udp-client-read-{}", session.generation))
            .spawn(move || read_loop(sink, lifecycle, reader_session, read_socket))
            .map_err(|error| {
                let error = SerialError::new(SerialErrorCode::IoError, error.to_string());
                self.fail_open(&session, error.clone());
                error
            })?;
        *session.reader.lock().map_err(poisoned)? = Some(reader);
        self.commit_open(
            &session,
            UdpSessionPhase::Open,
            SerialStatus::Open,
            Some(json!({ "bindHost": config.bind_host, "bindPort": local_address.port(), "targetHost": config.target_host, "targetPort": config.target_port })),
        )?;
        Ok(open_ack(&session))
    }

    fn open_server(
        &self,
        endpoint: UdpEndpoint,
        operation_id: &str,
    ) -> UdpResult<serial::OpenAcknowledgement> {
        let config = UdpConfig::server_from_value(&endpoint.config)?;
        let session = self.create_session(
            UdpSessionKind::Server,
            endpoint.endpoint_id,
            operation_id,
            config.label(),
            config.receive_framing.clone(),
        )?;
        let _active_open = ActiveUdpOpen { service: self };
        self.emit_status(&session, SerialStatus::Opening, None, None);
        let socket = match UdpSocket::bind((config.bind_host.as_str(), config.bind_port)) {
            Ok(socket) => socket,
            Err(error) => {
                let error = map_udp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        if let Err(error) = configure_socket(&socket) {
            self.fail_open(&session, error.clone());
            return Err(error);
        }
        let local_address = match socket.local_addr() {
            Ok(address) => address,
            Err(error) => {
                let error = map_udp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        let read_socket = match socket.try_clone() {
            Ok(socket) => socket,
            Err(error) => {
                let error = map_udp_error(error);
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        };
        {
            let mut sock = session.socket.lock().map_err(poisoned)?;
            *sock = Some(socket);
        }
        match config.target_addr_opt_for(local_address.is_ipv4()) {
            Ok(Some(target)) => *session.target.lock().map_err(poisoned)? = Some(target),
            Ok(None) => {}
            Err(error) => {
                self.fail_open(&session, error.clone());
                return Err(error);
            }
        }
        let sink = self.sink.clone();
        let lifecycle = self.lifecycle.clone();
        let reader_session = session.clone();
        let reader = thread::Builder::new()
            .name(format!("udp-server-read-{}", session.generation))
            .spawn(move || read_loop(sink, lifecycle, reader_session, read_socket))
            .map_err(|error| {
                let error = SerialError::new(SerialErrorCode::IoError, error.to_string());
                self.fail_open(&session, error.clone());
                error
            })?;
        *session.reader.lock().map_err(poisoned)? = Some(reader);
        self.commit_open(
            &session,
            UdpSessionPhase::Listening,
            SerialStatus::Listening,
            Some(json!({ "bindHost": config.bind_host, "bindPort": local_address.port() })),
        )?;
        Ok(open_ack(&session))
    }

    fn create_session(
        &self,
        kind: UdpSessionKind,
        endpoint_id: String,
        operation_id: &str,
        remote_label: String,
        receive_framing: ReceiveFraming,
    ) -> UdpResult<Arc<UdpSession>> {
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let session = Arc::new(UdpSession {
            kind,
            endpoint_id: endpoint_id.clone(),
            operation_id: operation_id.into(),
            session_id: format!("udp-session-{generation}"),
            generation,
            remote_label,
            receive_framing: receive_framing.clone(),
            phase: Mutex::new(UdpSessionPhase::Opening),
            send_owner: Mutex::new(()),
            socket: Mutex::new(None),
            reader: Mutex::new(None),
            peers: Mutex::new(HashMap::new()),
            next_peer_id: AtomicU64::new(0),
            batcher: Mutex::new(FrameBatcher::new(now_millis())),
            framer: Mutex::new(Framer::new(receive_framing)),
            stop: AtomicBool::new(false),
            reader_started: AtomicBool::new(false),
            target: Mutex::new(None),
            #[cfg(test)]
            fail_next_read: AtomicBool::new(self.fail_next_open_read.swap(false, Ordering::SeqCst)),
        });
        let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
        if lifecycle.stopped {
            return Err(udp_shutdown_error());
        }
        if lifecycle.sessions.contains_key(&endpoint_id) {
            return Err(SerialError::new(
                SerialErrorCode::PortBusy,
                format!("Endpoint {endpoint_id} is already open"),
            ));
        }
        lifecycle.active_opens += 1;
        lifecycle.sessions.insert(endpoint_id, session.clone());
        Ok(session)
    }

    fn commit_open(
        &self,
        session: &Arc<UdpSession>,
        phase: UdpSessionPhase,
        status: SerialStatus,
        details: Option<Value>,
    ) -> UdpResult<()> {
        #[cfg(test)]
        if let Some(hook) = self.before_open_commit.lock().map_err(poisoned)?.clone() {
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
            return Err(udp_shutdown_error());
        }
        *session.phase.lock().map_err(poisoned)? = phase;
        #[cfg(test)]
        if let Some(hook) = self.before_open_success.lock().map_err(poisoned)?.clone() {
            hook();
        }
        self.emit_status(session, status, None, details);
        session.reader_started.store(true, Ordering::SeqCst);
        Ok(())
    }

    fn fail_open(&self, session: &Arc<UdpSession>, error: SerialError) {
        self.remove_if_current(session);
        let _ = session.close();
        flush_session(&self.sink, session);
        self.emit_status(session, SerialStatus::Error, Some(error), None);
    }

    fn remove_if_current(&self, session: &Arc<UdpSession>) {
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

    #[cfg(test)]
    fn set_before_open_commit(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.before_open_commit.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_before_open_success(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.before_open_success.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn fail_next_open_read(&self) {
        self.fail_next_open_read.store(true, Ordering::SeqCst);
    }

    fn send_client(
        &self,
        session: &Arc<UdpSession>,
        bytes: &[u8],
    ) -> UdpResult<serial::SendAcknowledgement> {
        if *session.phase.lock().map_err(poisoned)? != UdpSessionPhase::Open {
            return Err(SerialError::new(
                SerialErrorCode::IoError,
                format!("Endpoint {} is not open", session.endpoint_id),
            ));
        }
        let socket = session
            .socket
            .lock()
            .map_err(poisoned)?
            .as_ref()
            .ok_or_else(|| SerialError::new(SerialErrorCode::IoError, "UDP socket is unavailable"))?
            .try_clone()
            .map_err(map_udp_error);
        let socket = match socket {
            Ok(socket) => socket,
            Err(error) => {
                self.fail_session(session, error.clone());
                return Err(error);
            }
        };
        let target = session.target.lock().map_err(poisoned)?.ok_or_else(|| {
            SerialError::new(SerialErrorCode::IoError, "UDP client has no target")
        })?;
        if let Err(error) = socket.send_to(bytes, target).map_err(map_udp_error) {
            self.fail_session(session, error.clone());
            return Err(error);
        }
        #[cfg(test)]
        self.run_before_send_history();
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
        session: &Arc<UdpSession>,
        bytes: &[u8],
        target: Option<&Value>,
    ) -> UdpResult<serial::SendAcknowledgement> {
        if *session.phase.lock().map_err(poisoned)? != UdpSessionPhase::Listening {
            return Err(SerialError::new(
                SerialErrorCode::IoError,
                format!("Endpoint {} is not listening", session.endpoint_id),
            ));
        }
        let targets = send_targets(session, target)?;
        let socket = session
            .socket
            .lock()
            .map_err(poisoned)?
            .as_ref()
            .ok_or_else(|| SerialError::new(SerialErrorCode::IoError, "UDP socket is unavailable"))?
            .try_clone()
            .map_err(map_udp_error);
        let socket = match socket {
            Ok(socket) => socket,
            Err(error) => {
                self.fail_session(session, error.clone());
                return Err(error);
            }
        };
        for (peer_id, addr) in &targets {
            if let Err(error) = socket.send_to(bytes, *addr).map_err(map_udp_error) {
                self.fail_session(session, error.clone());
                return Err(error);
            }
            #[cfg(test)]
            self.run_before_send_history();
            enqueue_frame(&self.sink, session, "out", peer_id.clone(), bytes.to_vec());
        }
        Ok(serial::SendAcknowledgement {
            endpoint_id: session.endpoint_id.clone(),
            sent: bytes.len(),
            peer_count: None,
            success_count: None,
            failure_count: None,
            peer_results: None,
        })
    }

    #[cfg(test)]
    fn run_before_send_history(&self) {
        let hook = self.before_send_history.lock().unwrap().clone();
        if let Some(hook) = hook {
            hook();
        }
    }

    fn fail_session(&self, session: &Arc<UdpSession>, error: SerialError) {
        self.remove_if_current(session);
        self.emit_status(session, SerialStatus::Error, Some(error), None);
        self.emit_status(session, SerialStatus::Closing, None, None);
        let _ = session.close();
        flush_session(&self.sink, session);
        if let Ok(mut peers) = session.peers.lock() {
            peers.clear();
        }
        self.emit_status(session, SerialStatus::Closed, None, None);
        self.emit_peers(session, Vec::new());
    }

    fn emit_status(
        &self,
        session: &UdpSession,
        status: SerialStatus,
        error: Option<SerialError>,
        details: Option<Value>,
    ) {
        emit_status_with_sink(&self.sink, session, status, error, details);
    }

    fn emit_peers(&self, session: &UdpSession, peers: Vec<PeerRecord>) {
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
}

struct ActiveUdpOpen<'a> {
    service: &'a UdpService,
}

impl Drop for ActiveUdpOpen<'_> {
    fn drop(&mut self) {
        self.service.end_open();
    }
}

struct UdpSession {
    kind: UdpSessionKind,
    endpoint_id: String,
    operation_id: String,
    session_id: String,
    generation: u64,
    remote_label: String,
    receive_framing: ReceiveFraming,
    phase: Mutex<UdpSessionPhase>,
    send_owner: Mutex<()>,
    socket: Mutex<Option<UdpSocket>>,
    reader: Mutex<Option<JoinHandle<()>>>,
    peers: Mutex<HashMap<String, UdpPeer>>,
    next_peer_id: AtomicU64,
    batcher: Mutex<FrameBatcher>,
    framer: Mutex<Framer>,
    stop: AtomicBool,
    reader_started: AtomicBool,
    target: Mutex<Option<SocketAddr>>,
    #[cfg(test)]
    fail_next_read: AtomicBool,
}

impl UdpSession {
    fn close(&self) -> UdpResult<()> {
        self.stop.store(true, Ordering::SeqCst);
        *self.phase.lock().map_err(poisoned)? = UdpSessionPhase::Closed;
        self.socket.lock().map_err(poisoned)?.take();
        if let Some(reader) = self.reader.lock().map_err(poisoned)?.take() {
            let _ = reader.join();
        }
        Ok(())
    }

    fn peer_records(&self) -> Vec<PeerRecord> {
        self.peers
            .lock()
            .map(|peers| {
                peers
                    .values()
                    .map(|peer| PeerRecord {
                        id: peer.id.clone(),
                        remote_address: peer.remote_address.clone(),
                        connected_at: peer.connected_at,
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

struct UdpPeer {
    id: String,
    remote_address: String,
    address: SocketAddr,
    connected_at: u64,
    framer: Mutex<Framer>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UdpSessionKind {
    Client,
    Server,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum UdpSessionPhase {
    Opening,
    Open,
    Listening,
    Closed,
}

#[derive(Clone)]
struct UdpConfig {
    bind_host: String,
    bind_port: u16,
    target_host: Option<String>,
    target_port: Option<u16>,
    receive_framing: ReceiveFraming,
}

impl UdpConfig {
    fn client_from_value(value: &Value) -> UdpResult<Self> {
        let config = Self::from_value(value)?;
        config.require_target()?;
        Ok(config)
    }

    fn server_from_value(value: &Value) -> UdpResult<Self> {
        Self::from_value(value)
    }

    fn from_value(value: &Value) -> UdpResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| config_error("udp endpoint config must be an object"))?;
        let bind_host = object
            .get("bindHost")
            .and_then(Value::as_str)
            .unwrap_or("0.0.0.0")
            .trim()
            .to_string();
        if bind_host.is_empty() {
            return Err(config_error("config.bindHost must be a nonblank string"));
        }
        let bind_port = object
            .get("bindPort")
            .and_then(Value::as_u64)
            .filter(|port| *port <= u16::MAX as u64)
            .ok_or_else(|| config_error("config.bindPort must be a UDP port"))?
            as u16;
        let target_host = object
            .get("targetHost")
            .and_then(Value::as_str)
            .map(|s| s.trim().to_string());
        let target_port = object
            .get("targetPort")
            .and_then(Value::as_u64)
            .filter(|port| *port <= u16::MAX as u64)
            .map(|port| port as u16);
        Ok(Self {
            bind_host,
            bind_port,
            target_host,
            target_port,
            receive_framing: ReceiveFraming::Raw,
        })
    }

    fn require_target(&self) -> UdpResult<()> {
        if self.target_host.is_none() || self.target_port.is_none() {
            return Err(config_error(
                "UDP client requires targetHost and targetPort",
            ));
        }
        Ok(())
    }

    fn target_addr_for(&self, ipv4: bool) -> UdpResult<SocketAddr> {
        let host = self
            .target_host
            .as_ref()
            .ok_or_else(|| config_error("missing targetHost"))?;
        let port = self
            .target_port
            .ok_or_else(|| config_error("missing targetPort"))?;
        (host.as_str(), port)
            .to_socket_addrs()
            .map_err(|error| config_error(format!("invalid target address: {error}")))?
            .find(|address| address.is_ipv4() == ipv4)
            .ok_or_else(|| config_error("target address family does not match the bound socket"))
    }

    fn target_addr_opt_for(&self, ipv4: bool) -> UdpResult<Option<SocketAddr>> {
        if self.target_host.is_some() && self.target_port.is_some() {
            Ok(Some(self.target_addr_for(ipv4)?))
        } else {
            Ok(None)
        }
    }

    fn label(&self) -> String {
        format!("{}:{}", self.bind_host, self.bind_port)
    }
}

fn send_targets(
    session: &UdpSession,
    target: Option<&Value>,
) -> UdpResult<Vec<(Option<String>, SocketAddr)>> {
    let broadcast = target
        .and_then(|value| value.get("broadcast"))
        .and_then(Value::as_bool)
        .unwrap_or(false);
    if broadcast {
        let peers = session.peers.lock().map_err(poisoned)?;
        if peers.is_empty() {
            return Err(SerialError::new(
                SerialErrorCode::PortNotFound,
                format!("Endpoint {} has no known peers", session.endpoint_id),
            ));
        }
        return Ok(peers
            .values()
            .map(|peer| (Some(peer.id.clone()), peer.address))
            .collect());
    }
    let peer_id = target
        .and_then(|value| value.get("peerId"))
        .and_then(Value::as_str);
    if let Some(peer_id) = peer_id {
        require_id(peer_id, "target.peerId")?;
        let peers = session.peers.lock().map_err(poisoned)?;
        let peer = peers.get(peer_id).ok_or_else(|| {
            SerialError::new(
                SerialErrorCode::PortNotFound,
                format!("UDP peer {peer_id} is not known"),
            )
        })?;
        return Ok(vec![(Some(peer.id.clone()), peer.address)]);
    }
    if let Some(addr) = session.target.lock().map_err(poisoned)?.as_ref() {
        return Ok(vec![(None, *addr)]);
    }
    Err(SerialError::new(
        SerialErrorCode::IoError,
        "No send target specified and no default target configured",
    ))
}

fn read_loop(
    sink: SharedEventSink,
    lifecycle: Arc<Mutex<UdpLifecycle>>,
    session: Arc<UdpSession>,
    socket: UdpSocket,
) {
    let mut buffer = [0_u8; 65536];
    while !session.reader_started.load(Ordering::SeqCst) && !session.stop.load(Ordering::SeqCst) {
        thread::sleep(Duration::from_millis(1));
    }
    while !session.stop.load(Ordering::SeqCst) {
        #[cfg(test)]
        if session.fail_next_read.swap(false, Ordering::SeqCst) {
            terminalize_reader_failure(
                &sink,
                &lifecycle,
                &session,
                SerialError::new(SerialErrorCode::IoError, "injected UDP read failure"),
            );
            return;
        }
        match socket.recv_from(&mut buffer) {
            Ok((length, addr)) => {
                let now = now_millis();
                let bytes = &buffer[..length];
                let peer_id = if session.kind == UdpSessionKind::Server {
                    ensure_peer_with_sink(&sink, &session, addr, now)
                } else {
                    None
                };
                for frame in frame_datagram(&session, peer_id.as_deref(), bytes, now) {
                    enqueue_frame(&sink, &session, "in", peer_id.clone(), frame);
                }
                flush_due(&sink, &session, now);
            }
            Err(error)
                if error.kind() == io::ErrorKind::WouldBlock
                    || error.kind() == io::ErrorKind::TimedOut =>
            {
                let now = now_millis();
                flush_idle_frames(&sink, &session, now);
                flush_due(&sink, &session, now);
            }
            Err(error) => {
                if !session.stop.load(Ordering::SeqCst) {
                    terminalize_reader_failure(&sink, &lifecycle, &session, map_udp_error(error));
                    return;
                }
                break;
            }
        }
    }
    flush_session(&sink, &session);
}

fn terminalize_reader_failure(
    sink: &SharedEventSink,
    lifecycle: &Arc<Mutex<UdpLifecycle>>,
    session: &Arc<UdpSession>,
    error: SerialError,
) {
    if let Ok(mut lifecycle) = lifecycle.lock() {
        if lifecycle
            .sessions
            .get(&session.endpoint_id)
            .is_some_and(|current| current.generation == session.generation)
        {
            lifecycle.sessions.remove(&session.endpoint_id);
        }
    }
    emit_status_with_sink(sink, session, SerialStatus::Error, Some(error), None);
    emit_status_with_sink(sink, session, SerialStatus::Closing, None, None);
    session.stop.store(true, Ordering::SeqCst);
    if let Ok(mut phase) = session.phase.lock() {
        *phase = UdpSessionPhase::Closed;
    }
    if let Ok(mut socket) = session.socket.lock() {
        socket.take();
    }
    if let Ok(mut reader) = session.reader.lock() {
        reader.take();
    }
    flush_session(sink, session);
    if let Ok(mut peers) = session.peers.lock() {
        peers.clear();
    }
    emit_status_with_sink(sink, session, SerialStatus::Closed, None, None);
    emit_peers_with_sink(sink, session, Vec::new());
}

fn ensure_peer_with_sink(
    sink: &SharedEventSink,
    session: &UdpSession,
    addr: SocketAddr,
    now: u64,
) -> Option<String> {
    let mut peers = session
        .peers
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for peer in peers.values() {
        if peer.address == addr {
            return Some(peer.id.clone());
        }
    }
    let peer_id = format!(
        "udp-peer-{}",
        session.next_peer_id.fetch_add(1, Ordering::SeqCst) + 1
    );
    let remote_address = addr.to_string();
    let peer = UdpPeer {
        id: peer_id.clone(),
        remote_address: remote_address.clone(),
        address: addr,
        connected_at: now,
        framer: Mutex::new(Framer::new(session.receive_framing.clone())),
    };
    peers.insert(peer_id.clone(), peer);
    drop(peers);
    emit_peers_with_sink(sink, session, session.peer_records());
    emit_peer_log_with_sink(
        sink,
        session,
        &peer_id,
        &remote_address,
        "info",
        format!("UDP peer discovered: {remote_address}"),
    );
    Some(peer_id)
}

fn enqueue_frame(
    sink: &SharedEventSink,
    session: &Arc<UdpSession>,
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

fn frame_datagram(
    session: &UdpSession,
    peer_id: Option<&str>,
    bytes: &[u8],
    now: u64,
) -> Vec<Vec<u8>> {
    if let Some(peer_id) = peer_id {
        return session
            .peers
            .lock()
            .ok()
            .and_then(|peers| {
                peers.get(peer_id).and_then(|peer| {
                    peer.framer
                        .lock()
                        .ok()
                        .map(|mut framer| framer.push(bytes, now))
                })
            })
            .unwrap_or_default();
    }
    session
        .framer
        .lock()
        .map(|mut framer| framer.push(bytes, now))
        .unwrap_or_default()
}

fn flush_idle_frames(sink: &SharedEventSink, session: &Arc<UdpSession>, now: u64) {
    let ready = if session.kind == UdpSessionKind::Server {
        session
            .peers
            .lock()
            .map(|peers| {
                peers
                    .values()
                    .flat_map(|peer| {
                        peer.framer
                            .lock()
                            .map(|mut framer| {
                                framer
                                    .flush_idle(now)
                                    .into_iter()
                                    .map(|frame| (Some(peer.id.clone()), frame))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        session
            .framer
            .lock()
            .map(|mut framer| {
                framer
                    .flush_idle(now)
                    .into_iter()
                    .map(|frame| (None, frame))
                    .collect()
            })
            .unwrap_or_default()
    };
    for (peer_id, frame) in ready {
        enqueue_frame(sink, session, "in", peer_id, frame);
    }
}

fn flush_due(sink: &SharedEventSink, session: &Arc<UdpSession>, now: u64) {
    let frames = session
        .batcher
        .lock()
        .ok()
        .and_then(|mut batcher| batcher.flush_due(now));
    if let Some(frames) = frames {
        emit_frames_with_sink(sink, session, frames);
    }
}

fn flush_session(sink: &SharedEventSink, session: &Arc<UdpSession>) {
    let pending = if session.kind == UdpSessionKind::Server {
        session
            .peers
            .lock()
            .map(|peers| {
                peers
                    .values()
                    .flat_map(|peer| {
                        peer.framer
                            .lock()
                            .map(|mut framer| {
                                framer
                                    .flush()
                                    .into_iter()
                                    .map(|frame| (Some(peer.id.clone()), frame))
                                    .collect::<Vec<_>>()
                            })
                            .unwrap_or_default()
                    })
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    } else {
        session
            .framer
            .lock()
            .map(|mut framer| {
                framer
                    .flush()
                    .into_iter()
                    .map(|frame| (None, frame))
                    .collect()
            })
            .unwrap_or_default()
    };
    let mut ready_batches = Vec::new();
    if let Ok(mut batcher) = session.batcher.lock() {
        let now = now_millis();
        for (peer_id, frame) in pending {
            if let Some(frames) = batcher.push("in", peer_id, frame, now) {
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

fn emit_frames_with_sink(sink: &SharedEventSink, session: &UdpSession, frames: Vec<WireFrame>) {
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

fn emit_peers_with_sink(sink: &SharedEventSink, session: &UdpSession, peers: Vec<PeerRecord>) {
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
    session: &UdpSession,
    peer_id: &str,
    remote_address: &str,
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
                source: "udp",
                peer_id: Some(peer_id.into()),
                code: None,
                message,
                details: Some(json!({ "peerId": peer_id, "remoteAddress": remote_address })),
                created_at,
            }),
        }),
    );
}

fn emit_status_with_sink(
    sink: &SharedEventSink,
    session: &UdpSession,
    status: SerialStatus,
    error: Option<SerialError>,
    details: Option<Value>,
) {
    let created_at = now_millis();
    let log = udp_status_log(session, status, error.as_ref(), details, created_at);
    emit_event(
        sink,
        SerialEvent::Status(StatusEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: if status == SerialStatus::Opening || status == SerialStatus::Closed {
                None
            } else {
                Some(session.session_id.clone())
            },
            status,
            error,
            created_at,
            log,
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

fn udp_status_log(
    session: &UdpSession,
    status: SerialStatus,
    error: Option<&SerialError>,
    details: Option<Value>,
    created_at: u64,
) -> Option<StatusLog> {
    let details = details.or_else(|| Some(json!({ "endpointId": session.endpoint_id })));
    let lifecycle = |level, message| StatusLog {
        level,
        source: "udp",
        peer_id: None,
        code: None,
        message,
        details: details.clone(),
        created_at,
    };
    match status {
        SerialStatus::Opening => Some(lifecycle(
            "debug",
            format!("Opening UDP endpoint: {}", session.remote_label),
        )),
        SerialStatus::Open => Some(lifecycle(
            "info",
            format!("UDP client ready: {}", session.remote_label),
        )),
        SerialStatus::Listening => Some(lifecycle(
            "info",
            format!("UDP server listening: {}", session.remote_label),
        )),
        SerialStatus::Closing => Some(lifecycle(
            "debug",
            format!("Closing UDP endpoint: {}", session.endpoint_id),
        )),
        SerialStatus::Closed => Some(lifecycle(
            "info",
            format!("UDP endpoint closed: {}", session.endpoint_id),
        )),
        SerialStatus::Error => {
            let error = error?;
            Some(StatusLog {
                level: "error",
                source: "udp",
                peer_id: None,
                code: Some(error_code_name(error.code).into()),
                message: format!("UDP operation failed: {}", session.endpoint_id),
                details,
                created_at,
            })
        }
    }
}

fn configure_socket(socket: &UdpSocket) -> UdpResult<()> {
    socket
        .set_read_timeout(Some(READ_TIMEOUT))
        .map_err(map_udp_error)?;
    Ok(())
}

fn open_ack(session: &UdpSession) -> serial::OpenAcknowledgement {
    serial::OpenAcknowledgement {
        endpoint_id: session.endpoint_id.clone(),
        operation_id: session.operation_id.clone(),
        session_id: session.session_id.clone(),
    }
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
}

impl Framer {
    fn new(mode: ReceiveFraming) -> Self {
        Self {
            mode,
            pending: Vec::new(),
            last_input_at: None,
        }
    }

    fn push(&mut self, bytes: &[u8], now: u64) -> Vec<Vec<u8>> {
        if bytes.is_empty() {
            return Vec::new();
        }
        match &self.mode {
            ReceiveFraming::Raw => vec![bytes.to_vec()],
            ReceiveFraming::Delimiter(delimiter) => {
                self.pending.extend_from_slice(bytes);
                let delimiter = delimiter.clone();
                let mut frames = Vec::new();
                while let Some(index) = find_subslice(&self.pending, &delimiter) {
                    frames.push(self.pending[..index].to_vec());
                    self.pending.drain(..index + delimiter.len());
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
                self.pending.extend_from_slice(bytes);
                self.last_input_at = Some(now);
                Vec::new()
            }
        }
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

fn require_id(value: &str, field: &str) -> UdpResult<()> {
    if value.trim().is_empty() {
        return Err(SerialError::new(
            SerialErrorCode::IoError,
            format!("{field} must be a nonblank string"),
        ));
    }
    Ok(())
}

fn config_error(message: impl Into<String>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, message.into())
}

fn udp_shutdown_error() -> SerialError {
    SerialError::new(SerialErrorCode::IoError, "UDP service is shutting down")
}

fn poisoned<T>(_error: std::sync::PoisonError<T>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, "UDP session lock poisoned")
}

fn map_udp_error(error: io::Error) -> SerialError {
    let code = match error.kind() {
        io::ErrorKind::PermissionDenied => SerialErrorCode::PermissionDenied,
        io::ErrorKind::AddrInUse => SerialErrorCode::PortBusy,
        _ => SerialErrorCode::IoError,
    };
    SerialError::new(code, error.to_string())
}

fn error_code_name(code: SerialErrorCode) -> &'static str {
    match code {
        SerialErrorCode::IoError => "IO_ERROR",
        SerialErrorCode::PortBusy => "PORT_BUSY",
        SerialErrorCode::PortNotFound => "PORT_NOT_FOUND",
        SerialErrorCode::PermissionDenied => "PERMISSION_DENIED",
        _ => "IO_ERROR",
    }
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::UdpSocket as TestUdpSocket;
    use std::sync::Condvar;

    #[derive(Default)]
    struct RecordingUdpSink {
        events: Mutex<Vec<SerialEvent>>,
        changed: Condvar,
    }

    impl serial::SerialEventSink for RecordingUdpSink {
        fn emit(&self, event: SerialEvent) {
            self.events.lock().unwrap().push(event);
            self.changed.notify_all();
        }
    }

    impl RecordingUdpSink {
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

        fn frame_count(&self) -> usize {
            self.frames().iter().map(|batch| batch.frames.len()).sum()
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

        fn udp_log_count(&self) -> usize {
            self.events
                .lock()
                .unwrap()
                .iter()
                .filter(|event| {
                    matches!(event, SerialEvent::Status(status)
                        if status.log.as_ref().is_some_and(|log| log.source == "udp"))
                })
                .count()
        }

        fn wait_for_status(&self, endpoint_id: &str, status: SerialStatus) -> StatusEvent {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            loop {
                if let Some(found) = events.iter().find_map(|event| match event {
                    SerialEvent::Status(s)
                        if s.endpoint_id == endpoint_id && s.status == status =>
                    {
                        Some(s.clone())
                    }
                    _ => None,
                }) {
                    return found;
                }
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .expect("timed out");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for status");
            }
        }

        fn wait_for_peer_count(&self, endpoint_id: &str, count: usize) -> PeerEvent {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            loop {
                if let Some(peers) = events.iter().rev().find_map(|event| match event {
                    SerialEvent::Peers(p)
                        if p.endpoint_id == endpoint_id && p.peers.len() == count =>
                    {
                        Some(p.clone())
                    }
                    _ => None,
                }) {
                    return peers;
                }
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .expect("timed out");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for peers");
            }
        }

        fn wait_for_frame(&self, endpoint_id: &str, predicate: impl Fn(&WireFrame) -> bool) {
            let deadline = std::time::Instant::now() + Duration::from_secs(2);
            let mut events = self.events.lock().unwrap();
            loop {
                if events.iter().any(|event| {
                    matches!(event, SerialEvent::Frames(batch) if batch.endpoint_id == endpoint_id && batch.frames.iter().any(&predicate))
                }) {
                    return;
                }
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .expect("timed out");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for frame");
            }
        }
    }

    fn udp_client_endpoint(endpoint_id: &str, target: SocketAddr) -> UdpEndpoint {
        UdpEndpoint {
            endpoint_id: endpoint_id.into(),
            transport: "udp-client".into(),
            config: json!({
                "bindHost": "127.0.0.1",
                "bindPort": 0,
                "targetHost": target.ip().to_string(),
                "targetPort": target.port(),
            }),
        }
    }

    fn udp_server_endpoint(endpoint_id: &str) -> UdpEndpoint {
        udp_server_endpoint_with_framing(endpoint_id, json!({ "mode": "raw" }))
    }

    fn udp_server_endpoint_with_framing(endpoint_id: &str, receive_framing: Value) -> UdpEndpoint {
        UdpEndpoint {
            endpoint_id: endpoint_id.into(),
            transport: "udp-server".into(),
            config: json!({
                "bindHost": "127.0.0.1",
                "bindPort": 0,
                "receiveFraming": receive_framing,
            }),
        }
    }

    #[test]
    fn cancel_open_is_scoped_to_the_operation_and_releases_the_reservation() {
        let service = UdpService::new(Arc::new(RecordingUdpSink::default()));
        let session = service
            .create_session(
                UdpSessionKind::Client,
                "cancel-test".into(),
                "open-1",
                "review".into(),
                ReceiveFraming::Raw,
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
    fn udp_config_ignores_legacy_stream_framing_for_clients_and_servers() {
        let client = UdpConfig::client_from_value(&json!({
            "bindHost": "127.0.0.1",
            "bindPort": 0,
            "targetHost": "127.0.0.1",
            "targetPort": 41000,
            "receiveFraming": { "mode": "delimiter", "delimiterBytes": [13, 10] },
        }))
        .unwrap();
        let server = UdpConfig::server_from_value(&json!({
            "bindHost": "127.0.0.1",
            "bindPort": 0,
            "receiveFraming": { "mode": "fixed", "length": 4 },
        }))
        .unwrap();

        assert_eq!(client.receive_framing, crate::serial::ReceiveFraming::Raw);
        assert_eq!(server.receive_framing, crate::serial::ReceiveFraming::Raw);
    }

    fn listening_port(status: &StatusEvent) -> u16 {
        status
            .log
            .as_ref()
            .and_then(|log| log.details.as_ref())
            .and_then(|details| details.get("bindPort"))
            .and_then(Value::as_u64)
            .unwrap() as u16
    }

    #[test]
    #[ignore]
    fn real_udp_transport_contract() {
        match std::env::var("INEED_PHASE05_UDP_MODE").as_deref() {
            Ok("server") => run_phase05_tauri_server_probe(),
            Ok("client") => run_phase05_tauri_client_probe(),
            _ => run_phase05_tauri_loopback_probe(),
        }
    }

    fn run_phase05_tauri_loopback_probe() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_server_endpoint("phase05-tauri-server"),
                "open-tauri-server",
            )
            .unwrap();
        let port =
            listening_port(&sink.wait_for_status("phase05-tauri-server", SerialStatus::Listening));
        let peer = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        peer.send_to(&[0x31, 0x32], ("127.0.0.1", port)).unwrap();
        let peer_id = sink.wait_for_peer_count("phase05-tauri-server", 1).peers[0]
            .id
            .clone();
        sink.wait_for_frame("phase05-tauri-server", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x31, 0x32]
        });
        service
            .send(
                "phase05-tauri-server",
                &[0x41, 0x42],
                Some(&json!({ "peerId": peer_id })),
            )
            .unwrap();
        let mut peer_buffer = [0_u8; 2];
        let (length, _) = peer.recv_from(&mut peer_buffer).unwrap();
        assert_eq!(&peer_buffer[..length], &[0x41, 0x42]);

        let echo = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        let echo_address = echo.local_addr().unwrap();
        let echo_worker = thread::spawn(move || {
            let mut buffer = [0_u8; 16];
            let (length, remote) = echo.recv_from(&mut buffer).unwrap();
            echo.send_to(&[0x51, buffer[0]], remote).unwrap();
            assert_eq!(length, 1);
        });
        service
            .open(
                udp_client_endpoint("phase05-tauri-client", echo_address),
                "open-tauri-client",
            )
            .unwrap();
        service.send("phase05-tauri-client", &[0x33], None).unwrap();
        sink.wait_for_frame("phase05-tauri-client", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x51, 0x33]
        });
        echo_worker.join().unwrap();

        service.close("phase05-tauri-client").unwrap();
        service.close("phase05-tauri-server").unwrap();
        println!(
            "PHASE05_TAURI_RESULT={}",
            json!({
                "runtime": "tauri",
                "scenario": "tauri-loopback",
                "frames": sink.frame_count(),
                "logs": sink.log_count(),
                "peerFrames": sink.peer_frame_count(),
                "udpLogs": sink.udp_log_count(),
            })
        );
    }

    fn run_phase05_tauri_server_probe() {
        use std::io::Write as _;

        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_server_endpoint("phase05-mixed-tauri-server"),
                "open-mixed-tauri-server",
            )
            .unwrap();
        let port = listening_port(
            &sink.wait_for_status("phase05-mixed-tauri-server", SerialStatus::Listening),
        );
        println!(
            "PHASE05_TAURI_SERVER_READY={}",
            json!({
                "runtime": "tauri",
                "scenario": "electron-client-to-tauri-server",
                "port": port,
            })
        );
        std::io::stdout().flush().unwrap();
        let peer_id = sink
            .wait_for_peer_count("phase05-mixed-tauri-server", 1)
            .peers[0]
            .id
            .clone();
        sink.wait_for_frame("phase05-mixed-tauri-server", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x61, 0x62]
        });
        service
            .send(
                "phase05-mixed-tauri-server",
                &[0x71, 0x72],
                Some(&json!({ "peerId": peer_id })),
            )
            .unwrap();
        service.close("phase05-mixed-tauri-server").unwrap();
        println!(
            "PHASE05_TAURI_SERVER_RESULT={}",
            json!({
                "runtime": "tauri",
                "scenario": "electron-client-to-tauri-server",
                "frames": sink.frame_count(),
                "logs": sink.log_count(),
                "peerFrames": sink.peer_frame_count(),
                "udpLogs": sink.udp_log_count(),
            })
        );
    }

    fn run_phase05_tauri_client_probe() {
        let port = std::env::var("INEED_PHASE05_UDP_SERVER_PORT")
            .unwrap()
            .parse::<u16>()
            .unwrap();
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_client_endpoint(
                    "phase05-mixed-tauri-client",
                    SocketAddr::from(([127, 0, 0, 1], port)),
                ),
                "open-mixed-tauri-client",
            )
            .unwrap();
        service
            .send("phase05-mixed-tauri-client", &[0x81, 0x82], None)
            .unwrap();
        sink.wait_for_frame("phase05-mixed-tauri-client", |frame| {
            frame.direction == "in" && frame.bytes == vec![0x91, 0x92]
        });
        service.close("phase05-mixed-tauri-client").unwrap();
        println!(
            "PHASE05_TAURI_CLIENT_RESULT={}",
            json!({
                "runtime": "tauri",
                "scenario": "tauri-client-to-electron-server",
                "frames": sink.frame_count(),
                "logs": sink.log_count(),
                "udpLogs": sink.udp_log_count(),
            })
        );
    }

    #[test]
    fn udp_duplicate_open_is_rejected_without_replacing_the_live_session() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink));
        service
            .open(udp_server_endpoint("udp-duplicate"), "open-first")
            .unwrap();

        let error = service
            .open(udp_server_endpoint("udp-duplicate"), "open-second")
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::PortBusy);
        assert!(service.send("udp-duplicate", &[1], None).is_err());
        service.close("udp-duplicate").unwrap();
    }

    #[test]
    fn cancel_open_prevents_late_success_and_releases_real_resources() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        let entered_hook = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let release_hook = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
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
        let open_worker = thread::spawn(move || {
            open_service.open(udp_server_endpoint("udp-open-race"), "open-race")
        });
        {
            let mut entered = entered_hook.0.lock().unwrap();
            while !*entered {
                entered = entered_hook.1.wait(entered).unwrap();
            }
        }
        assert!(
            !service
                .cancel_open("udp-open-race", "wrong-operation")
                .unwrap()
                .cancelled
        );
        assert!(
            service
                .cancel_open("udp-open-race", "open-race")
                .unwrap()
                .cancelled
        );
        *release_hook.0.lock().unwrap() = true;
        release_hook.1.notify_all();

        let error = open_worker.join().unwrap().unwrap_err();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "UDP service is shutting down");
        assert!(service.send("udp-open-race", &[1], None).is_err());
        assert!(!sink
            .statuses("udp-open-race")
            .iter()
            .any(|status| status.status == SerialStatus::Listening));
    }

    #[test]
    fn shutdown_during_in_flight_open_prevents_late_success_and_session_leak() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        let entered_hook = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
        let release_hook = Arc::new((Mutex::new(false), std::sync::Condvar::new()));
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
        let open_worker = thread::spawn(move || {
            open_service.open(udp_server_endpoint("udp-open-race"), "open-race")
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
        let shutdown_worker = thread::spawn(move || {
            shutdown_service.shutdown().unwrap();
            shutdown_done_worker.store(true, Ordering::SeqCst);
        });
        thread::sleep(Duration::from_millis(25));
        assert!(!shutdown_done.load(Ordering::SeqCst));
        *release_hook.0.lock().unwrap() = true;
        release_hook.1.notify_all();

        let error = open_worker.join().unwrap().unwrap_err();
        shutdown_worker.join().unwrap();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "UDP service is shutting down");
        assert!(service.send("udp-open-race", &[1], None).is_err());
        assert!(!sink
            .statuses("udp-open-race")
            .iter()
            .any(|status| status.status == SerialStatus::Listening));
    }

    fn assert_concurrent_udp_history_matches_wire_order(server: bool) {
        let remote = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        remote
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        let id = "concurrent-history";
        let target = if server {
            service
                .open(udp_server_endpoint(id), "open-history")
                .unwrap();
            let port = listening_port(&sink.wait_for_status(id, SerialStatus::Listening));
            remote.send_to(b"hello", ("127.0.0.1", port)).unwrap();
            let peer = sink.wait_for_peer_count(id, 1).peers[0].id.clone();
            Some(json!({"type":"peer", "peerId":peer}))
        } else {
            service
                .open(
                    udp_client_endpoint(id, remote.local_addr().unwrap()),
                    "open-history",
                )
                .unwrap();
            None
        };
        // Pause after the first real datagram has left the socket. A second
        // command must not commit its history ahead of that datagram.
        let (entered_tx, entered_rx) = std::sync::mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        let first = Arc::new(AtomicBool::new(true));
        *service.before_send_history.lock().unwrap() = Some({
            let release = release.clone();
            Arc::new(move || {
                if first.swap(false, Ordering::SeqCst) {
                    entered_tx.send(()).unwrap();
                    let mut ready = release.0.lock().unwrap();
                    while !*ready {
                        ready = release.1.wait(ready).unwrap();
                    }
                }
            })
        });
        let sending = service.clone();
        let target1 = target.clone();
        let writer1 = thread::spawn(move || sending.send(id, &[1], target1.as_ref()));
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let sending = service.clone();
        let writer2 = thread::spawn(move || {
            let result = sending.send(id, &[2], target.as_ref());
            finished_tx.send(()).unwrap();
            result
        });
        let _ = finished_rx.recv_timeout(Duration::from_millis(500));
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        writer1.join().unwrap().unwrap();
        writer2.join().unwrap().unwrap();
        let mut wire = Vec::new();
        for _ in 0..2 {
            let mut bytes = [0; 8];
            let (length, _) = remote.recv_from(&mut bytes).unwrap();
            wire.push(bytes[..length].to_vec());
        }
        service.close(id).unwrap();
        let history: Vec<_> = sink
            .frames()
            .into_iter()
            .flat_map(|batch| batch.frames)
            .filter(|frame| frame.direction == "out")
            .map(|frame| frame.bytes)
            .collect();
        assert_eq!(wire, vec![vec![1], vec![2]]);
        assert_eq!(
            history, wire,
            "UDP outgoing history differs from actual datagram order"
        );
        assert!(service.lifecycle.lock().unwrap().sessions.is_empty());
    }

    #[test]
    fn concurrent_udp_client_history_matches_wire_order() {
        assert_concurrent_udp_history_matches_wire_order(false);
    }

    #[test]
    fn concurrent_udp_server_history_matches_wire_order() {
        assert_concurrent_udp_history_matches_wire_order(true);
    }

    #[test]
    fn udp_client_resolves_hostname_target_for_bound_socket_family() {
        let echo_socket = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        let echo_addr = echo_socket.local_addr().unwrap();
        let echo_thread = thread::spawn(move || {
            let mut buffer = [0_u8; 8];
            let (length, remote) = echo_socket.recv_from(&mut buffer).unwrap();
            echo_socket.send_to(&buffer[..length], remote).unwrap();
        });
        let sink = Arc::new(RecordingUdpSink::default());
        let service = UdpService::new(sink.clone());
        service
            .open(
                UdpEndpoint {
                    endpoint_id: "udp-hostname".into(),
                    transport: "udp-client".into(),
                    config: json!({
                        "bindHost": "127.0.0.1",
                        "bindPort": 0,
                        "targetHost": "localhost",
                        "targetPort": echo_addr.port(),
                        "receiveFraming": { "mode": "raw" },
                    }),
                },
                "open-hostname",
            )
            .unwrap();

        service.send("udp-hostname", b"host", None).unwrap();
        sink.wait_for_frame("udp-hostname", |frame| {
            frame.direction == "in" && frame.bytes == b"host"
        });
        echo_thread.join().unwrap();
        service.close("udp-hostname").unwrap();
    }

    #[test]
    fn udp_bind_failure_emits_error_and_releases_endpoint_reservation() {
        let occupied = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        let port = occupied.local_addr().unwrap().port();
        let sink = Arc::new(RecordingUdpSink::default());
        let service = UdpService::new(sink.clone());
        let failed = UdpEndpoint {
            endpoint_id: "udp-bind-failure".into(),
            transport: "udp-server".into(),
            config: json!({
                "bindHost": "127.0.0.1",
                "bindPort": port,
                "receiveFraming": { "mode": "raw" },
            }),
        };

        let error = service.open(failed, "open-bind-failure").unwrap_err();

        assert_eq!(error.code, SerialErrorCode::PortBusy);
        assert!(sink
            .statuses("udp-bind-failure")
            .iter()
            .any(|status| status.status == SerialStatus::Error));
        service
            .open(
                udp_server_endpoint("udp-bind-failure"),
                "open-after-bind-failure",
            )
            .unwrap();
        service.close("udp-bind-failure").unwrap();
    }

    #[test]
    fn udp_close_emits_closing_before_closed() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = UdpService::new(sink.clone());
        service
            .open(udp_server_endpoint("udp-closing"), "open-closing")
            .unwrap();

        service.close("udp-closing").unwrap();

        let statuses = sink.statuses("udp-closing");
        assert_eq!(statuses[statuses.len() - 2].status, SerialStatus::Closing);
        assert_eq!(statuses[statuses.len() - 1].status, SerialStatus::Closed);
    }

    #[test]
    fn udp_read_failure_terminalizes_and_removes_the_session() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = UdpService::new(sink.clone());
        service
            .open(udp_server_endpoint("udp-read-failure"), "open-read-failure")
            .unwrap();
        service
            .session("udp-read-failure")
            .unwrap()
            .fail_next_read
            .store(true, Ordering::SeqCst);

        sink.wait_for_status("udp-read-failure", SerialStatus::Closed);

        assert!(service.send("udp-read-failure", &[1], None).is_err());
        let statuses = sink.statuses("udp-read-failure");
        assert_eq!(statuses[statuses.len() - 3].status, SerialStatus::Error);
        assert_eq!(statuses[statuses.len() - 2].status, SerialStatus::Closing);
        assert_eq!(statuses[statuses.len() - 1].status, SerialStatus::Closed);
    }

    #[test]
    fn reader_failure_during_open_cannot_publish_success_after_closed() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        let entered_success = Arc::new((Mutex::new(false), Condvar::new()));
        let release_success = Arc::new((Mutex::new(false), Condvar::new()));
        service.fail_next_open_read();
        service.set_before_open_success({
            let entered_success = entered_success.clone();
            let release_success = release_success.clone();
            Arc::new(move || {
                *entered_success.0.lock().unwrap() = true;
                entered_success.1.notify_all();
                let mut released = release_success.0.lock().unwrap();
                while !*released {
                    released = release_success.1.wait(released).unwrap();
                }
            })
        });
        let open_service = service.clone();
        let open_worker = thread::spawn(move || {
            open_service.open(
                udp_server_endpoint("udp-read-during-open"),
                "open-read-during-open",
            )
        });
        {
            let mut entered = entered_success.0.lock().unwrap();
            while !*entered {
                entered = entered_success.1.wait(entered).unwrap();
            }
        }
        thread::sleep(Duration::from_millis(25));
        *release_success.0.lock().unwrap() = true;
        release_success.1.notify_all();

        open_worker.join().unwrap().unwrap();
        sink.wait_for_status("udp-read-during-open", SerialStatus::Closed);

        let statuses = sink.statuses("udp-read-during-open");
        let success_index = statuses
            .iter()
            .position(|status| status.status == SerialStatus::Listening)
            .unwrap();
        let closed_index = statuses
            .iter()
            .position(|status| status.status == SerialStatus::Closed)
            .unwrap();
        assert!(success_index < closed_index);
        assert!(!statuses[closed_index + 1..]
            .iter()
            .any(|status| matches!(status.status, SerialStatus::Open | SerialStatus::Listening)));
        assert!(service.send("udp-read-during-open", &[1], None).is_err());
    }

    #[test]
    fn udp_shutdown_rejects_new_opens_and_emits_no_late_success() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service.shutdown().unwrap();

        let error = service
            .open(
                udp_server_endpoint("udp-after-shutdown"),
                "open-after-shutdown",
            )
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::IoError);
        assert_eq!(error.message, "UDP service is shutting down");
        assert!(!sink
            .statuses("udp-after-shutdown")
            .iter()
            .any(|status| matches!(status.status, SerialStatus::Open | SerialStatus::Listening)));
    }

    #[test]
    fn udp_client_sends_and_receives_through_localhost_echo() {
        let echo_socket = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        let echo_addr = echo_socket.local_addr().unwrap();
        let echo_thread = thread::spawn(move || {
            let mut buf = [0u8; 1024];
            let (len, addr) = echo_socket.recv_from(&mut buf).unwrap();
            echo_socket.send_to(&buf[..len], addr).unwrap();
        });

        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_client_endpoint("udp-client-1", echo_addr),
                "open-client",
            )
            .unwrap();

        service.send("udp-client-1", &[0x31, 0x32], None).unwrap();
        sink.wait_for_frame("udp-client-1", |frame| frame.direction == "in");

        let batches = sink.frames();
        let frames: Vec<_> = batches
            .iter()
            .flat_map(|batch| batch.frames.iter())
            .collect();
        assert!(frames.iter().any(|f| f.direction == "out"));
        assert!(frames.iter().any(|f| f.direction == "in"));
        echo_thread.join().unwrap();
        service.close("udp-client-1").unwrap();
    }

    #[test]
    fn udp_server_discovers_peers_and_sends_back() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(udp_server_endpoint("udp-server-1"), "open-server")
            .unwrap();

        let port = sink
            .wait_for_status("udp-server-1", SerialStatus::Listening)
            .log
            .as_ref()
            .and_then(|log| log.details.as_ref())
            .and_then(|d| d.get("bindPort"))
            .and_then(Value::as_u64)
            .unwrap() as u16;

        let client = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        client.send_to(&[0x21], ("127.0.0.1", port)).unwrap();

        let peers = sink.wait_for_peer_count("udp-server-1", 1);
        let peer_id = peers.peers[0].id.clone();

        service
            .send("udp-server-1", &[0x42], Some(&json!({ "peerId": peer_id })))
            .unwrap();

        let mut buf = [0u8; 1];
        let (len, _) = client.recv_from(&mut buf).unwrap();
        assert_eq!(len, 1);
        assert_eq!(buf[0], 0x42);

        sink.wait_for_frame("udp-server-1", |frame| {
            frame.direction == "in" && frame.peer_id.as_deref() == Some(&peer_id)
        });
        sink.wait_for_frame("udp-server-1", |frame| {
            frame.direction == "out" && frame.peer_id.as_deref() == Some(&peer_id)
        });

        service.close("udp-server-1").unwrap();
    }

    #[test]
    fn udp_server_preserves_datagrams_with_legacy_delimiter_framing() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_server_endpoint_with_framing(
                    "udp-server-delimiter",
                    json!({ "mode": "delimiter", "delimiterBytes": [10] }),
                ),
                "open-delimiter",
            )
            .unwrap();

        let port = sink
            .wait_for_status("udp-server-delimiter", SerialStatus::Listening)
            .log
            .as_ref()
            .and_then(|log| log.details.as_ref())
            .and_then(|details| details.get("bindPort"))
            .and_then(Value::as_u64)
            .unwrap() as u16;
        let peer = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        peer.send_to(b"partial", ("127.0.0.1", port)).unwrap();
        peer.send_to(b"done\n", ("127.0.0.1", port)).unwrap();

        let peer_id = sink.wait_for_peer_count("udp-server-delimiter", 1).peers[0]
            .id
            .clone();
        sink.wait_for_frame("udp-server-delimiter", |frame| {
            frame.direction == "in"
                && frame.peer_id.as_deref() == Some(&peer_id)
                && frame.bytes == b"partial"
        });
        sink.wait_for_frame("udp-server-delimiter", |frame| {
            frame.direction == "in"
                && frame.peer_id.as_deref() == Some(&peer_id)
                && frame.bytes == b"done\n"
        });
        assert!(!sink.frames().iter().any(|batch| {
            batch.endpoint_id == "udp-server-delimiter"
                && batch
                    .frames
                    .iter()
                    .any(|frame| frame.bytes == b"partialdone")
        }));

        service.close("udp-server-delimiter").unwrap();
    }

    #[test]
    fn udp_server_preserves_datagrams_with_legacy_fixed_framing() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_server_endpoint_with_framing(
                    "udp-server-fixed",
                    json!({ "mode": "fixed", "length": 4 }),
                ),
                "open-fixed",
            )
            .unwrap();

        let port = sink
            .wait_for_status("udp-server-fixed", SerialStatus::Listening)
            .log
            .as_ref()
            .and_then(|log| log.details.as_ref())
            .and_then(|details| details.get("bindPort"))
            .and_then(Value::as_u64)
            .unwrap() as u16;
        let peer = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        peer.send_to(b"ab", ("127.0.0.1", port)).unwrap();
        peer.send_to(b"cd", ("127.0.0.1", port)).unwrap();

        sink.wait_for_frame("udp-server-fixed", |frame| {
            frame.direction == "in" && frame.bytes == b"ab"
        });
        sink.wait_for_frame("udp-server-fixed", |frame| {
            frame.direction == "in" && frame.bytes == b"cd"
        });
        assert!(!sink.frames().iter().any(|batch| {
            batch.endpoint_id == "udp-server-fixed"
                && batch.frames.iter().any(|frame| frame.bytes == b"abcd")
        }));
        service.close("udp-server-fixed").unwrap();
    }

    #[test]
    fn udp_server_emits_datagram_immediately_with_legacy_idle_framing() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = Arc::new(UdpService::new(sink.clone()));
        service
            .open(
                udp_server_endpoint_with_framing(
                    "udp-server-idle",
                    json!({ "mode": "idle", "idleMs": 500 }),
                ),
                "open-idle",
            )
            .unwrap();

        let port = sink
            .wait_for_status("udp-server-idle", SerialStatus::Listening)
            .log
            .as_ref()
            .and_then(|log| log.details.as_ref())
            .and_then(|details| details.get("bindPort"))
            .and_then(Value::as_u64)
            .unwrap() as u16;
        let peer = TestUdpSocket::bind(("127.0.0.1", 0)).unwrap();
        peer.send_to(b"idle", ("127.0.0.1", port)).unwrap();

        thread::sleep(Duration::from_millis(300));
        assert!(sink.frames().iter().any(|batch| {
            batch.endpoint_id == "udp-server-idle"
                && batch
                    .frames
                    .iter()
                    .any(|frame| frame.direction == "in" && frame.bytes == b"idle")
        }));

        sink.wait_for_frame("udp-server-idle", |frame| {
            frame.direction == "in" && frame.bytes == b"idle"
        });
        service.close("udp-server-idle").unwrap();
    }

    #[test]
    fn udp_disconnect_peer_is_unavailable() {
        let sink = Arc::new(RecordingUdpSink::default());
        let service = UdpService::new(sink);
        let result = service.disconnect_peer("any", "any");
        assert!(result.is_err());
    }
}
