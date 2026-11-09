//! Native message-oriented WebSocket transport. No network I/O holds lifecycle locks.
use crate::serial::{
    self, FrameBatch, PeerEvent, PeerRecord, SerialError, SerialErrorCode, SerialEvent,
    SerialEventSink, SerialResult, SerialStatus, StatusEvent, StatusLog, WireFrame,
};
use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc as sync_mpsc, Arc, Mutex, OnceLock,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tokio::{
    net::TcpListener,
    runtime::Runtime,
    sync::{mpsc, oneshot, Semaphore},
    time::{timeout, Instant},
};
use tokio_tungstenite::{
    accept_hdr_async_with_config, connect_async_tls_with_config,
    tungstenite::{
        client::IntoClientRequest,
        handshake::server::{ErrorResponse, Request, Response},
        http::{HeaderName, HeaderValue, StatusCode},
        protocol::{frame::coding::CloseCode, CloseFrame, WebSocketConfig},
        Message,
    },
    Connector, WebSocketStream,
};
use tokio_util::sync::CancellationToken;

pub(crate) const MAX_MESSAGE_BYTES: usize = 1024 * 1024;
const MAX_QUEUED_BYTES: usize = 4 * MAX_MESSAGE_BYTES;
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(15);
const WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_PEERS: usize = 64;

#[derive(Debug, Clone)]
pub(crate) struct WebSocketEndpoint {
    pub(crate) endpoint_id: String,
    pub(crate) transport: String,
    pub(crate) config: Value,
}
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct WebSocketHeader {
    pub(crate) name: String,
    pub(crate) value: String,
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Heartbeat {
    #[serde(default)]
    enabled: bool,
    #[serde(default = "default_interval")]
    interval_ms: u64,
    #[serde(default = "default_timeout")]
    timeout_ms: u64,
}
fn default_interval() -> u64 {
    30_000
}
fn default_timeout() -> u64 {
    10_000
}
impl Default for Heartbeat {
    fn default() -> Self {
        Self {
            enabled: false,
            interval_ms: default_interval(),
            timeout_ms: default_timeout(),
        }
    }
}
#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Config {
    #[serde(default)]
    url: String,
    #[serde(default = "default_host")]
    listen_host: String,
    #[serde(default)]
    listen_port: u16,
    #[serde(default = "default_path")]
    path: String,
    #[serde(default)]
    subprotocols: Vec<String>,
    #[serde(default = "default_type")]
    message_type: String,
    #[serde(default)]
    heartbeat: Heartbeat,
    #[serde(default, rename = "autoReconnect")]
    _auto_reconnect: bool,
}
fn default_host() -> String {
    "127.0.0.1".into()
}
fn default_path() -> String {
    "/".into()
}
fn default_type() -> String {
    "text".into()
}
fn error(message: impl Into<String>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, message)
}
fn cancelled() -> SerialError {
    SerialError::new(SerialErrorCode::OpenCancelled, "WebSocket open cancelled")
}
fn token(value: &str) -> bool {
    !value.is_empty()
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"!#$%&'*+-.^_`|~".contains(&b))
}
fn validate_config_inner(transport: &str, value: &Value, allow_zero: bool) -> SerialResult<Config> {
    fn contains_headers(v: &Value) -> bool {
        match v {
            Value::Object(o) => o.iter().any(|(k, v)| {
                k.eq_ignore_ascii_case("headers")
                    || k.eq_ignore_ascii_case("websocketHeaders")
                    || contains_headers(v)
            }),
            Value::Array(a) => a.iter().any(contains_headers),
            _ => false,
        }
    }
    if !value.is_object() || contains_headers(value) {
        return Err(error(
            "WebSocket headers are session-only; configuration must not contain headers",
        ));
    }
    let config: Config = serde_json::from_value(value.clone())
        .map_err(|_| error("Invalid WebSocket configuration"))?;
    if !matches!(config.message_type.as_str(), "text" | "binary") {
        return Err(error("WebSocket messageType must be text or binary"));
    }
    let mut seen = HashSet::new();
    if config.subprotocols.len() > 16
        || config
            .subprotocols
            .iter()
            .any(|p| p.len() > 128 || !token(p) || !seen.insert(p))
    {
        return Err(error("WebSocket subprotocols must be unique HTTP tokens"));
    }
    if !(1000..=60000).contains(&config.heartbeat.interval_ms)
        || !(1000..=60000).contains(&config.heartbeat.timeout_ms)
    {
        return Err(error(
            "WebSocket heartbeat must be between 1000 and 60000 milliseconds",
        ));
    }
    match transport {
        "websocket-client" => {
            let url = url::Url::parse(&config.url).map_err(|_| error("Invalid WebSocket URL"))?;
            if !matches!(url.scheme(), "ws" | "wss")
                || url.host_str().is_none()
                || !url.username().is_empty()
                || url.password().is_some()
                || url.fragment().is_some()
            {
                return Err(error(
                    "WebSocket URL must use ws/wss without credentials or fragment",
                ));
            }
        }
        "websocket-server" => {
            if config.listen_host.trim().is_empty()
                || (!allow_zero && config.listen_port == 0)
                || !config.path.starts_with('/')
                || config.path.contains(['?', '#', '\r', '\n'])
            {
                return Err(error("Invalid WebSocket listen host, port or path"));
            }
        }
        _ => return Err(error("Endpoint is not a WebSocket transport")),
    }
    Ok(config)
}
pub(crate) fn validate_config(
    transport: &str,
    value: &Value,
    allow_zero: bool,
) -> SerialResult<()> {
    validate_config_inner(transport, value, allow_zero).map(|_| ())
}
fn header_value(value: &str) -> SerialResult<HeaderValue> {
    let bytes = value
        .chars()
        .map(|c| {
            if c == '\t' || (' '..='~').contains(&c) || ('\u{80}'..='\u{ff}').contains(&c) {
                Ok(c as u8)
            } else {
                Err(error("Invalid WebSocket header value"))
            }
        })
        .collect::<SerialResult<Vec<_>>>()?;
    HeaderValue::from_bytes(&bytes).map_err(|_| error("Invalid WebSocket header value"))
}
pub(crate) fn validate_headers(headers: &[WebSocketHeader]) -> SerialResult<()> {
    let mut seen = HashSet::new();
    let mut total = 0;
    if headers.len() > 32 {
        return Err(error("At most 32 WebSocket headers are allowed"));
    }
    for header in headers {
        let name = header.name.to_ascii_lowercase();
        total += header.name.len() + header.value.len();
        if !token(&header.name)
            || header.value.len() > 4096
            || header.value.contains(['\r', '\n'])
            || !seen.insert(name.clone())
            || matches!(
                name.as_str(),
                "host" | "connection" | "upgrade" | "content-length" | "transfer-encoding"
            )
            || name.starts_with("sec-websocket-")
            || header_value(&header.value).is_err()
        {
            return Err(error("Invalid, duplicate or reserved WebSocket header"));
        }
    }
    if total > 16384 {
        return Err(error("WebSocket headers exceed 16 KiB"));
    }
    Ok(())
}
fn socket_config() -> WebSocketConfig {
    WebSocketConfig::default()
        .max_message_size(Some(MAX_MESSAGE_BYTES))
        .max_frame_size(Some(MAX_MESSAGE_BYTES))
        .write_buffer_size(0)
        .max_write_buffer_size(MAX_QUEUED_BYTES)
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

struct SendCommand {
    message: Message,
    bytes: Vec<u8>,
    message_type: String,
    deadline: Instant,
    reply: oneshot::Sender<SerialResult<()>>,
    _budget: tokio::sync::OwnedSemaphorePermit,
}
struct Peer {
    record: PeerRecord,
    tx: mpsc::Sender<SendCommand>,
    budget: Arc<Semaphore>,
    cancel: CancellationToken,
    finished: AtomicBool,
}
struct Session {
    endpoint_id: String,
    operation_id: String,
    session_id: String,
    server: bool,
    config: Config,
    cancel: CancellationToken,
    finished: AtomicBool,
    peers: Mutex<HashMap<String, Arc<Peer>>>,
    sink: Arc<dyn SerialEventSink>,
    sensitive_session: bool,
}
impl Session {
    fn emit(&self, event: SerialEvent) {
        if !self.cancel.is_cancelled() {
            self.sink.emit(event);
        }
    }
    fn status(
        &self,
        status: SerialStatus,
        err: Option<SerialError>,
        peer: Option<String>,
        close: Option<(u16, String)>,
    ) {
        let created_at = now();
        let details = close
            .map(|(code, reason)| json!({"closeCode":code,"closeReason":self.redact(&reason)}))
            .or_else(|| {
                err.as_ref()
                    .filter(|e| e.message.contains("heartbeat timed out"))
                    .map(|_| json!({"reason":"HEARTBEAT_TIMEOUT"}))
            });
        let level = match status {
            SerialStatus::Opening | SerialStatus::Closing => "debug",
            SerialStatus::Error => "error",
            SerialStatus::Listening if err.is_some() => "warn",
            _ => "info",
        };
        self.emit(SerialEvent::Status(StatusEvent {
            endpoint_id: self.endpoint_id.clone(),
            operation_id: self.operation_id.clone(),
            session_id: if matches!(status, SerialStatus::Opening | SerialStatus::Closed) {
                None
            } else {
                Some(self.session_id.clone())
            },
            status,
            error: if status == SerialStatus::Error {
                err.clone()
            } else {
                None
            },
            created_at,
            log: Some(StatusLog {
                level,
                source: "websocket",
                peer_id: peer,
                code: if status == SerialStatus::Error {
                    Some("IO_ERROR".into())
                } else {
                    None
                },
                message: if let Some(e) = err {
                    e.message
                } else {
                    format!(
                        "WebSocket {}",
                        match status {
                            SerialStatus::Opening => "opening",
                            SerialStatus::Open => "connected",
                            SerialStatus::Listening => "listening",
                            SerialStatus::Closing => "closing",
                            SerialStatus::Closed => "closed",
                            SerialStatus::Error => "failed",
                        }
                    )
                },
                details,
                created_at,
            }),
        }));
    }
    fn redact(&self, value: &str) -> String {
        if !self.server && self.sensitive_session && !value.is_empty() {
            return "[redacted: authenticated/session parameters]".into();
        }
        value
            .chars()
            .filter(|c| !c.is_control())
            .take(123)
            .collect()
    }
    fn peers_event(&self) {
        let peers = self
            .peers
            .lock()
            .unwrap()
            .values()
            .map(|p| p.record.clone())
            .collect();
        self.emit(SerialEvent::Peers(PeerEvent {
            endpoint_id: self.endpoint_id.clone(),
            operation_id: self.operation_id.clone(),
            session_id: self.session_id.clone(),
            peers,
        }));
    }
    fn frame(
        &self,
        peer_id: Option<String>,
        direction: &'static str,
        bytes: Vec<u8>,
        message_type: &str,
    ) {
        self.emit(SerialEvent::Frames(FrameBatch {
            endpoint_id: self.endpoint_id.clone(),
            operation_id: self.operation_id.clone(),
            session_id: self.session_id.clone(),
            frames: vec![WireFrame {
                direction,
                peer_id,
                bytes,
                message_type: Some(message_type.into()),
                framing: Some("websocket".into()),
                created_at: now(),
            }],
        }));
    }
}
struct Lifecycle {
    stopped: bool,
    sessions: HashMap<String, Arc<Session>>,
}
fn native_tls_config() -> Arc<rustls::ClientConfig> {
    static TLS: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    TLS.get_or_init(|| {
        let mut roots = rustls::RootCertStore::empty();
        for certificate in rustls_native_certs::load_native_certs().certs {
            let _ = roots.add(certificate);
        }
        // Select this connection's provider explicitly: OPC UA also enables aws-lc.
        // No global provider change, custom trust roots or certificate bypass.
        let tls = Arc::new(
            rustls::ClientConfig::builder_with_provider(Arc::new(
                rustls::crypto::ring::default_provider(),
            ))
            .with_safe_default_protocol_versions()
            .expect("standard TLS protocol versions")
            .with_root_certificates(roots)
            .with_no_client_auth(),
        );
        tls
    })
    .clone()
}
pub(crate) struct WebSocketService {
    runtime: Runtime,
    tls: Arc<rustls::ClientConfig>,
    lifecycle: Mutex<Lifecycle>,
    sequence: AtomicU64,
    sink: Arc<dyn SerialEventSink>,
}
impl WebSocketService {
    pub(crate) fn new(sink: Arc<dyn SerialEventSink>) -> Self {
        let tls = native_tls_config();
        Self {
            tls,
            runtime: tokio::runtime::Builder::new_multi_thread()
                .worker_threads(2)
                .enable_all()
                .build()
                .expect("WebSocket runtime"),
            lifecycle: Mutex::new(Lifecycle {
                stopped: false,
                sessions: HashMap::new(),
            }),
            sequence: AtomicU64::new(0),
            sink,
        }
    }
    pub(crate) fn open(
        &self,
        endpoint: WebSocketEndpoint,
        operation_id: &str,
        headers: &[WebSocketHeader],
    ) -> SerialResult<serial::OpenAcknowledgement> {
        if endpoint.endpoint_id.trim().is_empty() || operation_id.trim().is_empty() {
            return Err(error("endpointId and operationId are required"));
        }
        let config = validate_config_inner(&endpoint.transport, &endpoint.config, false)?;
        validate_headers(headers)?;
        if endpoint.transport == "websocket-server" && !headers.is_empty() {
            return Err(error(
                "Custom headers are available only for WebSocket clients",
            ));
        }
        let sensitive_session = !headers.is_empty()
            || url::Url::parse(&config.url)
                .ok()
                .is_some_and(|url| url.query().is_some_and(|query| !query.is_empty()));
        let session = Arc::new(Session {
            endpoint_id: endpoint.endpoint_id.clone(),
            operation_id: operation_id.into(),
            session_id: format!(
                "websocket-{}-{}",
                now(),
                self.sequence.fetch_add(1, Ordering::SeqCst)
            ),
            server: endpoint.transport == "websocket-server",
            config,
            cancel: CancellationToken::new(),
            finished: AtomicBool::new(false),
            peers: Mutex::new(HashMap::new()),
            sink: self.sink.clone(),
            sensitive_session,
        });
        {
            let mut lifecycle = self.lifecycle.lock().unwrap();
            if lifecycle.stopped {
                return Err(error("WebSocket service stopped"));
            }
            if lifecycle
                .sessions
                .get(&session.endpoint_id)
                .is_some_and(|s| !s.cancel.is_cancelled() && !s.finished.load(Ordering::SeqCst))
            {
                return Err(SerialError::new(
                    SerialErrorCode::PortBusy,
                    "WebSocket endpoint already active",
                ));
            }
            lifecycle
                .sessions
                .insert(session.endpoint_id.clone(), session.clone());
        }
        session.status(SerialStatus::Opening, None, None, None);
        let (tx, rx) = sync_mpsc::sync_channel(1);
        let run = session.clone();
        let headers = headers.to_vec();
        let tls = self.tls.clone();
        self.runtime.spawn(async move {
            let result = if run.server {
                run_server(run.clone(), tx).await
            } else {
                run_client(run.clone(), headers, tls, tx).await
            };
            if let Err(err) = result {
                run.status(SerialStatus::Error, Some(err), None, None);
            }
            run.finished.store(true, Ordering::SeqCst);
        });
        match rx.recv_timeout(HANDSHAKE_TIMEOUT + Duration::from_secs(1)) {
            Ok(Ok(())) => {
                if session.cancel.is_cancelled() {
                    return Err(cancelled());
                }
                Ok(serial::OpenAcknowledgement {
                    endpoint_id: session.endpoint_id.clone(),
                    operation_id: operation_id.into(),
                    session_id: session.session_id.clone(),
                })
            }
            Ok(Err(err)) => Err(err),
            Err(_) => {
                session.cancel.cancel();
                Err(error("WebSocket handshake timed out"))
            }
        }
    }
    fn session(&self, id: &str) -> SerialResult<Arc<Session>> {
        self.lifecycle
            .lock()
            .unwrap()
            .sessions
            .get(id)
            .filter(|s| !s.cancel.is_cancelled() && !s.finished.load(Ordering::SeqCst))
            .cloned()
            .ok_or_else(|| error("WebSocket endpoint is not open"))
    }
    pub(crate) fn send(
        &self,
        id: &str,
        bytes: &[u8],
        target: Option<&Value>,
        message_type: Option<&str>,
    ) -> SerialResult<serial::SendAcknowledgement> {
        if bytes.len() > MAX_MESSAGE_BYTES {
            return Err(error("WebSocket message exceeds 1 MiB"));
        }
        let session = self.session(id)?;
        let kind = message_type.unwrap_or(&session.config.message_type);
        let message = match kind {
            "binary" => Message::Binary(bytes.to_vec().into()),
            "text" => Message::Text(
                std::str::from_utf8(bytes)
                    .map_err(|_| error("WebSocket text requires valid UTF-8"))?
                    .to_owned()
                    .into(),
            ),
            _ => return Err(error("WebSocket messageType must be text or binary")),
        };
        if let Some(expected) = target.and_then(|t| t.get("expectedSessionId")) {
            if expected.as_str() != Some(&session.session_id) {
                return Err(error("WebSocket session changed"));
            }
        }
        let peers: Vec<(String, Option<Arc<Peer>>)> = {
            let peers = session.peers.lock().unwrap();
            if !session.server {
                peers
                    .iter()
                    .map(|(id, peer)| (id.clone(), Some(peer.clone())))
                    .collect()
            } else {
                let target = target
                    .ok_or_else(|| error("WebSocket server requires a peer target or broadcast"))?;
                if target.get("type").and_then(Value::as_str) == Some("broadcast")
                    || target.get("broadcast").and_then(Value::as_bool) == Some(true)
                {
                    peers
                        .iter()
                        .map(|(id, peer)| (id.clone(), Some(peer.clone())))
                        .collect()
                } else {
                    let ids = if let Some(ids) = target.get("peerIds") {
                        ids.as_array()
                            .ok_or_else(|| error("target.peerIds must be an array"))?
                            .iter()
                            .map(|v| v.as_str().ok_or_else(|| error("peer ID must be a string")))
                            .collect::<SerialResult<Vec<_>>>()?
                    } else {
                        vec![target
                            .get("peerId")
                            .and_then(Value::as_str)
                            .ok_or_else(|| error("WebSocket peer target required"))?]
                    };
                    let mut seen = HashSet::new();
                    if ids.is_empty()
                        || ids.len() > MAX_PEERS
                        || ids.iter().any(|id| id.is_empty() || !seen.insert(*id))
                    {
                        return Err(error("WebSocket peer IDs must be unique and nonempty"));
                    }
                    ids.into_iter()
                        .map(|id| (id.to_owned(), peers.get(id).cloned()))
                        .collect()
                }
            }
        };
        if peers.is_empty() {
            return Err(error("WebSocket endpoint has no connected peers"));
        }
        let futures = peers.iter().map(|(_, peer)| {
            let message = message.clone();
            let bytes = bytes.to_vec();
            let kind = kind.to_owned();
            async move {
                let peer = peer
                    .as_ref()
                    .ok_or_else(|| error("WebSocket peer is not connected"))?;
                let budget = peer
                    .budget
                    .clone()
                    .try_acquire_many_owned(bytes.len().max(1) as u32)
                    .map_err(|_| error("WebSocket send buffer exceeds 4 MiB"))?;
                let (tx, rx) = oneshot::channel();
                peer.tx
                    .try_send(SendCommand {
                        message,
                        bytes,
                        message_type: kind,
                        deadline: Instant::now() + WRITE_TIMEOUT,
                        reply: tx,
                        _budget: budget,
                    })
                    .map_err(|_| error("WebSocket send queue is full or closed"))?;
                timeout(WRITE_TIMEOUT + Duration::from_secs(1), rx)
                    .await
                    .map_err(|_| error("WebSocket send timed out"))?
                    .map_err(|_| error("WebSocket peer closed"))?
            }
        });
        let results = self.runtime.block_on(futures::future::join_all(futures));
        if !session.server {
            results.into_iter().next().unwrap()?;
            return Ok(serial::SendAcknowledgement {
                endpoint_id: id.into(),
                sent: bytes.len(),
                peer_count: None,
                success_count: None,
                failure_count: None,
                peer_results: None,
            });
        }
        let results: Vec<_> = peers
            .iter()
            .zip(results)
            .map(|(p, r)| serial::PeerSendResult {
                peer_id: p.0.clone(),
                ok: r.is_ok(),
                byte_count: if r.is_ok() { Some(bytes.len()) } else { None },
                error: r.err(),
            })
            .collect();
        let success = results.iter().filter(|r| r.ok).count();
        Ok(serial::SendAcknowledgement {
            endpoint_id: id.into(),
            sent: bytes.len() * success,
            peer_count: Some(results.len()),
            success_count: Some(success),
            failure_count: Some(results.len() - success),
            peer_results: Some(results),
        })
    }
    fn remove(&self, id: &str, operation: Option<&str>) -> Option<Arc<Session>> {
        let mut lifecycle = self.lifecycle.lock().unwrap();
        if lifecycle
            .sessions
            .get(id)
            .is_some_and(|s| operation.is_none_or(|op| s.operation_id == op))
        {
            lifecycle.sessions.remove(id)
        } else {
            None
        }
    }
    fn stop(&self, session: Arc<Session>) {
        self.stop_until(
            session,
            std::time::Instant::now() + Duration::from_millis(500),
        );
    }
    fn stop_until(&self, session: Arc<Session>, deadline: std::time::Instant) {
        session.cancel.cancel();
        while !session.finished.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        let created_at = now();
        // A cancelled token is visible to every handshake and peer before the terminal event.
        self.sink.emit(SerialEvent::Status(StatusEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: None,
            status: SerialStatus::Closed,
            error: None,
            created_at,
            log: Some(StatusLog {
                level: "info",
                source: "websocket",
                peer_id: None,
                code: None,
                message: "WebSocket closed".into(),
                details: Some(json!({"closeCode":1000,"closeReason":""})),
                created_at,
            }),
        }));
        if session.server {
            self.sink.emit(SerialEvent::Peers(PeerEvent {
                endpoint_id: session.endpoint_id.clone(),
                operation_id: session.operation_id.clone(),
                session_id: session.session_id.clone(),
                peers: vec![],
            }));
        }
    }
    pub(crate) fn cancel_open(
        &self,
        id: &str,
        op: &str,
    ) -> SerialResult<serial::CancelAcknowledgement> {
        let session = self.remove(id, Some(op));
        let cancelled = session.is_some();
        if let Some(session) = session {
            self.stop(session);
        }
        Ok(serial::CancelAcknowledgement {
            endpoint_id: id.into(),
            operation_id: op.into(),
            cancelled,
        })
    }
    pub(crate) fn close(&self, id: &str) -> SerialResult<serial::CloseAcknowledgement> {
        if let Some(session) = self.remove(id, None) {
            session.status(SerialStatus::Closing, None, None, None);
            self.stop(session);
        }
        Ok(serial::CloseAcknowledgement {
            endpoint_id: id.into(),
            closed: true,
        })
    }
    pub(crate) fn disconnect_peer(&self, id: &str, peer_id: &str) -> SerialResult<Value> {
        let s = self.session(id)?;
        if !s.server {
            return Err(error("Only WebSocket servers have disconnectable peers"));
        }
        let peer = s
            .peers
            .lock()
            .unwrap()
            .remove(peer_id)
            .ok_or_else(|| error("WebSocket peer is not connected"))?;
        peer.cancel.cancel();
        let deadline = std::time::Instant::now() + Duration::from_millis(250);
        while !peer.finished.load(Ordering::SeqCst) && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(1));
        }
        s.peers_event();
        Ok(json!({"endpointId":id,"peerId":peer_id,"disconnected":true}))
    }
    pub(crate) fn close_all(&self) -> SerialResult<()> {
        let sessions: Vec<_> = self
            .lifecycle
            .lock()
            .unwrap()
            .sessions
            .drain()
            .map(|(_, s)| s)
            .collect();
        // Cancel every endpoint first; shutdown has one deadline across all listeners/peers.
        for session in &sessions {
            session.cancel.cancel();
        }
        let deadline = std::time::Instant::now() + Duration::from_millis(500);
        for session in sessions {
            self.stop_until(session, deadline);
        }
        Ok(())
    }
    pub(crate) fn shutdown(&self) -> SerialResult<()> {
        self.lifecycle.lock().unwrap().stopped = true;
        self.close_all()
    }
}
impl Drop for WebSocketService {
    fn drop(&mut self) {
        let _ = self.shutdown();
    }
}

async fn run_client(
    session: Arc<Session>,
    headers: Vec<WebSocketHeader>,
    tls: Arc<rustls::ClientConfig>,
    ready: sync_mpsc::SyncSender<SerialResult<()>>,
) -> SerialResult<()> {
    let connect = async {
        let mut request = session
            .config
            .url
            .as_str()
            .into_client_request()
            .map_err(|_| error("Invalid WebSocket request"))?;
        for header in headers {
            request.headers_mut().insert(
                HeaderName::from_bytes(header.name.as_bytes())
                    .map_err(|_| error("Invalid WebSocket header"))?,
                header_value(&header.value)?,
            );
        }
        if !session.config.subprotocols.is_empty() {
            request.headers_mut().insert(
                "sec-websocket-protocol",
                HeaderValue::from_str(&session.config.subprotocols.join(", "))
                    .map_err(|_| error("Invalid WebSocket protocols"))?,
            );
        }
        // rustls-tls-native-roots validates the platform trust store and DNS name. No permissive verifier.
        connect_async_tls_with_config(
            request,
            Some(socket_config()),
            false,
            Some(Connector::Rustls(tls)),
        )
        .await
        .map_err(|_| error("WebSocket connection or TLS handshake failed"))
    };
    let connected = tokio::select! {_ =session.cancel.cancelled()=>Err(cancelled()),result=timeout(HANDSHAKE_TIMEOUT,connect)=>result.unwrap_or_else(|_|Err(error("WebSocket handshake timed out")))};
    let (socket, response) = match connected {
        Ok(v) => v,
        Err(err) => {
            let _ = ready.send(Err(err.clone()));
            return Err(err);
        }
    };
    let negotiated = response
        .headers()
        .get("sec-websocket-protocol")
        .and_then(|h| h.to_str().ok());
    if !session.config.subprotocols.is_empty()
        && !negotiated.is_some_and(|p| session.config.subprotocols.iter().any(|s| s == p))
    {
        let err = error("WebSocket server did not negotiate a requested subprotocol");
        let _ = ready.send(Err(err.clone()));
        return Err(err);
    }
    let (peer, rx) = new_peer(&session, "client".into(), "remote".into());
    session.status(SerialStatus::Open, None, None, None);
    let _ = ready.send(Ok(()));
    run_peer(socket, session, peer, rx).await;
    Ok(())
}
fn reject(status: StatusCode) -> ErrorResponse {
    let mut response = ErrorResponse::new(Some("WebSocket handshake rejected".into()));
    *response.status_mut() = status;
    response
}
fn valid_handshake_key(request: &Request) -> bool {
    let mut keys = request.headers().get_all("sec-websocket-key").iter();
    let Some(key) = keys.next() else {
        return false;
    };
    keys.next().is_none()
        && BASE64
            .decode(key.as_bytes())
            .is_ok_and(|bytes| bytes.len() == 16)
}
async fn run_server(
    session: Arc<Session>,
    ready: sync_mpsc::SyncSender<SerialResult<()>>,
) -> SerialResult<()> {
    let bind = TcpListener::bind((
        session.config.listen_host.as_str(),
        session.config.listen_port,
    ));
    let listener = tokio::select! {_=session.cancel.cancelled()=>Err(cancelled()),result=timeout(HANDSHAKE_TIMEOUT,bind)=>result.map_err(|_|error("WebSocket listen timed out")).and_then(|r|r.map_err(|_|error("WebSocket listen failed")))};
    let listener = match listener {
        Ok(l) => l,
        Err(e) => {
            let _ = ready.send(Err(e.clone()));
            return Err(e);
        }
    };
    session.status(SerialStatus::Listening, None, None, None);
    let _ = ready.send(Ok(()));
    let capacity = Arc::new(Semaphore::new(MAX_PEERS));
    let mut sequence = 0u64;
    let mut tasks = tokio::task::JoinSet::new();
    loop {
        tokio::select! {
            _=session.cancel.cancelled()=>break,
            Some(_)=tasks.join_next(),if !tasks.is_empty()=>{},
            accepted=listener.accept()=>{
                let (stream,address)=accepted.map_err(|_|error("WebSocket accept failed"))?;
                let Ok(permit)=capacity.clone().try_acquire_owned() else {drop(stream);continue};
                sequence+=1;let id=format!("{}-peer-{sequence}",session.session_id);let s=session.clone();
                tasks.spawn(async move {
                    let _capacity=permit;let config=s.config.clone();
                    let callback=move |request:&Request,mut response:Response|->Result<Response,ErrorResponse>{
                        if !valid_handshake_key(request){return Err(reject(StatusCode::BAD_REQUEST));}
                        if request.uri().path()!=config.path{return Err(reject(StatusCode::NOT_FOUND));}
                        let offered:Vec<_>=request.headers().get("sec-websocket-protocol").and_then(|v|v.to_str().ok()).unwrap_or("").split(',').map(str::trim).filter(|p|!p.is_empty()).collect();
                        if !config.subprotocols.is_empty(){let Some(protocol)=config.subprotocols.iter().find(|p|offered.contains(&p.as_str()))else{return Err(reject(StatusCode::BAD_REQUEST))};response.headers_mut().insert("sec-websocket-protocol",HeaderValue::from_str(protocol).unwrap());}Ok(response)
                    };
                    let socket=tokio::select!{_=s.cancel.cancelled()=>return,result=timeout(HANDSHAKE_TIMEOUT,accept_hdr_async_with_config(stream,callback,Some(socket_config())))=>match result{Ok(Ok(socket))=>socket,_=>return}};
                    let(peer,rx)=new_peer(&s,id,address.to_string());s.peers_event();run_peer(socket,s,peer,rx).await;
                });
            }
        }
    }
    drop(listener);
    // Children observe cancellation and get at most 100ms to transmit a normal close.
    let _ = timeout(Duration::from_millis(250), async {
        while tasks.join_next().await.is_some() {}
    })
    .await;
    tasks.abort_all();
    Ok(())
}
fn new_peer(
    session: &Session,
    id: String,
    address: String,
) -> (Arc<Peer>, mpsc::Receiver<SendCommand>) {
    let (tx, rx) = mpsc::channel(32);
    let peer = Arc::new(Peer {
        record: PeerRecord {
            id: id.clone(),
            remote_address: address,
            connected_at: now(),
        },
        tx,
        budget: Arc::new(Semaphore::new(MAX_QUEUED_BYTES)),
        cancel: session.cancel.child_token(),
        finished: AtomicBool::new(false),
    });
    session.peers.lock().unwrap().insert(id, peer.clone());
    (peer, rx)
}
async fn run_peer<S>(
    mut socket: WebSocketStream<S>,
    session: Arc<Session>,
    peer: Arc<Peer>,
    mut rx: mpsc::Receiver<SendCommand>,
) where
    S: tokio::io::AsyncRead + tokio::io::AsyncWrite + Unpin,
{
    let mut heartbeat =
        tokio::time::interval(Duration::from_millis(session.config.heartbeat.interval_ms));
    heartbeat.tick().await;
    let mut pong_deadline: Option<Instant> = None;
    let mut close = None;
    let mut failure = None;
    loop {
        let deadline = pong_deadline.unwrap_or_else(|| Instant::now() + Duration::from_secs(86400));
        tokio::select! {
            _=peer.cancel.cancelled()=>{let _=timeout(Duration::from_millis(100),socket.send(Message::Close(Some(CloseFrame{code:CloseCode::Normal,reason:"".into()})))).await;break;}
            _=tokio::time::sleep_until(deadline),if pong_deadline.is_some()=>{failure=Some(error("WebSocket heartbeat timed out"));break;}
            _=heartbeat.tick(),if session.config.heartbeat.enabled && pong_deadline.is_none()=>{
                if timeout(WRITE_TIMEOUT,socket.send(Message::Ping(b"linklab".to_vec().into()))).await.map_or(true,|r|r.is_err()){failure=Some(error("WebSocket heartbeat write failed"));break;}pong_deadline=Some(Instant::now()+Duration::from_millis(session.config.heartbeat.timeout_ms));
            }
            command=rx.recv()=>{let Some(command)=command else{break};
            if command.reply.is_closed() || command.deadline <= Instant::now() || peer.cancel.is_cancelled() {
                let _=command.reply.send(Err(error("WebSocket queued send expired or cancelled")));
                continue;
            }
            let sent=tokio::select!{_=peer.cancel.cancelled()=>Err(error("WebSocket peer closed")),r=tokio::time::timeout_at(command.deadline,socket.send(command.message))=>r.map_err(|_|error("WebSocket write timed out")).and_then(|r|r.map_err(|_|error("WebSocket write failed")))};
                if sent.is_ok(){session.frame(if session.server{Some(peer.record.id.clone())}else{None},"out",command.bytes,&command.message_type);}let failed=sent.is_err();let _=command.reply.send(sent);if failed{failure=Some(error("WebSocket write failed"));break;}
            }
            message=socket.next()=>match message {
                Some(Ok(Message::Text(text)))=>session.frame(if session.server{Some(peer.record.id.clone())}else{None},"in",text.as_bytes().to_vec(),"text"),
                Some(Ok(Message::Binary(bytes)))=>session.frame(if session.server{Some(peer.record.id.clone())}else{None},"in",bytes.to_vec(),"binary"),
                Some(Ok(Message::Pong(payload)))=>{if payload.as_ref()==b"linklab"{pong_deadline=None;}},
                Some(Ok(Message::Ping(_)))=>{if timeout(WRITE_TIMEOUT,socket.flush()).await.map_or(true,|r|r.is_err()){break;}},
                Some(Ok(Message::Close(frame)))=>{close=Some(frame.map(|f|(u16::from(f.code),f.reason.to_string())).unwrap_or((1005,String::new())));let _=timeout(Duration::from_millis(100),socket.flush()).await;break;},
                Some(Ok(_))=>{},Some(Err(_))=>{failure=Some(error("WebSocket connection closed or protocol limit exceeded"));break;},None=>{close=Some((1006,String::new()));break;}
            }
        }
    }
    peer.cancel.cancel();
    session.peers.lock().unwrap().remove(&peer.record.id);
    if session.server {
        session.peers_event();
        session.status(
            SerialStatus::Listening,
            failure,
            Some(peer.record.id.clone()),
            close,
        );
    } else {
        session.status(
            if failure.is_some() {
                SerialStatus::Error
            } else {
                SerialStatus::Closed
            },
            failure,
            None,
            close,
        );
    }
    peer.finished.store(true, Ordering::SeqCst);
}
#[cfg(test)]
mod tests;

/// Isolated NDJSON native acceptance driver; the desktop uses the coordinator.
#[doc(hidden)]
pub fn run_native_harness() {
    use std::io::BufRead;
    struct Sink;
    impl SerialEventSink for Sink {
        fn emit(&self, event: SerialEvent) {
            let value = match event {
                SerialEvent::Status(e) => json!({"type":"status","payload":e}),
                SerialEvent::Frames(e) => json!({"type":"frames","payload":e}),
                SerialEvent::Peers(e) => json!({"type":"peers","payload":e}),
            };
            println!("{}", json!({"event":value}));
        }
    }
    let service = Arc::new(WebSocketService::new(Arc::new(Sink)));
    let mut workers = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let service = service.clone();
        workers.push(std::thread::spawn(move || {
            let input: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => {
                    println!("{}", json!({"error":"Invalid JSON"}));
                    return;
                }
            };
            let id = input.get("id").cloned().unwrap_or(Value::Null);
            let result: SerialResult<Value> = (|| {
                let endpoint_id = input["endpointId"].as_str().unwrap_or("");
                match input["method"].as_str().unwrap_or("") {
                    "open" => {
                        let endpoint = &input["endpoint"];
                        let headers: Vec<WebSocketHeader> = serde_json::from_value(
                            input.get("websocketHeaders").cloned().unwrap_or(json!([])),
                        )
                        .map_err(|_| error("Invalid WebSocket headers"))?;
                        let ack = service.open(
                            WebSocketEndpoint {
                                endpoint_id: endpoint["id"].as_str().unwrap_or("").into(),
                                transport: endpoint["transport"].as_str().unwrap_or("").into(),
                                config: endpoint["config"].clone(),
                            },
                            input["operationId"].as_str().unwrap_or(""),
                            &headers,
                        )?;
                        Ok(serde_json::to_value(ack).unwrap())
                    }
                    "send" => {
                        let bytes: Vec<u8> = serde_json::from_value(input["bytes"].clone())
                            .map_err(|_| error("Invalid bytes"))?;
                        service
                            .send(
                                endpoint_id,
                                &bytes,
                                input.get("target"),
                                input["messageType"].as_str(),
                            )
                            .map(|v| serde_json::to_value(v).unwrap())
                    }
                    "close" => service
                        .close(endpoint_id)
                        .map(|v| serde_json::to_value(v).unwrap()),
                    "cancelOpen" => service
                        .cancel_open(endpoint_id, input["operationId"].as_str().unwrap_or(""))
                        .map(|v| serde_json::to_value(v).unwrap()),
                    "disconnectPeer" => {
                        service.disconnect_peer(endpoint_id, input["peerId"].as_str().unwrap_or(""))
                    }
                    "shutdown" => service.shutdown().map(|_| json!({"closed":true})),
                    _ => Err(error("Unknown native harness method")),
                }
            })();
            match result {
                Ok(value) => println!("{}", json!({"id":id,"result":value})),
                Err(err) => println!("{}", json!({"id":id,"error":err})),
            }
        }));
    }
    let _ = service.shutdown();
    for worker in workers {
        let _ = worker.join();
    }
}
