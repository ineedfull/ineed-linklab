mod wire;
use wire::*;

use std::{
    borrow::Cow,
    collections::{HashMap, VecDeque},
    future, io,
    net::{SocketAddr, ToSocketAddrs},
    pin::Pin,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc, Arc, Condvar, Mutex, MutexGuard,
    },
    task::{Context as TaskContext, Poll},
    thread::{self, JoinHandle},
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{State, WebviewWindow};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio_modbus::{
    client::Client as _, server::Service, slave::SlaveContext as _, ExceptionCode, Request,
    Response, Slave, SlaveRequest,
};
use tokio_serial::{DataBits, FlowControl, Parity, SerialStream, StopBits};
use tokio_util::sync::CancellationToken;

use crate::serial::{
    CloseAcknowledgement, OpenAcknowledgement, SerialError, SerialErrorCode, SerialEvent,
    SerialEventSink, SerialStatus, StatusEvent, StatusLog,
};
use crate::{runtime, AppState};

macro_rules! authorize_command {
    ($window:expr, $method:literal) => {
        if let Some(denied) = runtime::authorize_window($window.label(), $method) {
            return Ok(denied);
        }
    };
}

pub(crate) trait ModbusEventSink: Send + Sync + 'static {
    fn emit(&self, transaction: ModbusTransaction);
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModbusTransaction {
    endpoint_id: String,
    session_id: String,
    request_group_id: Option<String>,
    request_id: Option<String>,
    origin: &'static str,
    unit_id: u8,
    function_code: u8,
    address: u16,
    quantity: u16,
    request_values: Vec<Value>,
    values: Vec<Value>,
    success: bool,
    exception_code: Option<u8>,
    message: Option<String>,
    transport: String,
    request_frame: Vec<u8>,
    response_frame: Vec<u8>,
    created_at: u64,
    duration_ms: u64,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModbusExecuteRequest {
    endpoint_id: String,
    expected_session_id: Option<String>,
    request_group_id: Option<String>,
    request_id: Option<String>,
    timeout_ms: Option<u64>,
    function_code: u8,
    unit_id: u8,
    address: u16,
    quantity: u16,
    values: Vec<Value>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModbusMapWriteRequest {
    endpoint_id: String,
    expected_session_id: Option<String>,
    area: String,
    address: u16,
    values: Vec<Value>,
}

#[derive(Debug, Clone)]
pub(crate) struct ModbusEndpoint {
    pub(crate) endpoint_id: String,
    pub(crate) transport: String,
    pub(crate) config: Value,
}

pub(crate) struct ModbusService {
    transport_sink: Arc<dyn SerialEventSink>,
    modbus_sink: Arc<dyn ModbusEventSink>,
    lifecycle: Arc<Mutex<Lifecycle>>,
    opening_changed: Condvar,
    #[cfg(test)]
    before_open_commit: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

struct Lifecycle {
    stopped: bool,
    next_session_id: u64,
    sessions: HashMap<String, Arc<Session>>,
    opening: HashMap<String, OpeningOperation>,
}

struct OpeningOperation {
    operation_id: String,
    cancel: CancellationToken,
}

// Own the async context and runtime so connecting can be cancelled before a
// session is published. Calls retain the previous synchronous timeout behavior.
struct MasterContext {
    runtime: tokio::runtime::Runtime,
    context: Option<tokio_modbus::client::Context>,
    timeout: Option<Duration>,
}

impl MasterContext {
    fn timeout(&self) -> Option<Duration> {
        self.timeout
    }
    fn set_timeout(&mut self, timeout: impl Into<Option<Duration>>) {
        self.timeout = timeout.into();
    }
    fn set_slave(&mut self, slave: Slave) {
        if let Some(context) = &mut self.context {
            context.set_slave(slave);
        }
    }
    fn call(&mut self, request: Request<'_>) -> tokio_modbus::Result<Response> {
        let Some(context) = &mut self.context else {
            return Err(
                io::Error::new(io::ErrorKind::NotConnected, "Modbus session closed").into(),
            );
        };
        self.runtime.block_on(async {
            if let Some(timeout) = self.timeout {
                tokio::time::timeout(timeout, context.call(request))
                    .await
                    .unwrap_or_else(|error| {
                        Err(io::Error::new(io::ErrorKind::TimedOut, error).into())
                    })
            } else {
                context.call(request).await
            }
        })
    }
}

struct Session {
    endpoint_id: String,
    operation_id: String,
    session_id: String,
    transport: String,
    unit_id: u8,
    kind: SessionKind,
}

enum SessionKind {
    Master(Mutex<MasterContext>),
    Slave {
        data: Arc<Mutex<DataStore>>,
        cancel: CancellationToken,
        worker: Mutex<Option<JoinHandle<()>>>,
    },
}

struct SlaveTermination {
    lifecycle: Arc<Mutex<Lifecycle>>,
    transport_sink: Arc<dyn SerialEventSink>,
    endpoint_id: String,
    operation_id: String,
    session_id: String,
    transport: String,
    terminal_error: Mutex<Option<SerialError>>,
    armed: AtomicBool,
}

impl SlaveTermination {
    #[cfg(test)]
    fn new(
        lifecycle: Arc<Mutex<Lifecycle>>,
        transport_sink: Arc<dyn SerialEventSink>,
        session: &Session,
    ) -> Arc<Self> {
        Self::for_open(
            lifecycle,
            transport_sink,
            &session.endpoint_id,
            &session.operation_id,
            &session.session_id,
            &session.transport,
        )
    }

    fn for_open(
        lifecycle: Arc<Mutex<Lifecycle>>,
        transport_sink: Arc<dyn SerialEventSink>,
        endpoint_id: &str,
        operation_id: &str,
        session_id: &str,
        transport: &str,
    ) -> Arc<Self> {
        Arc::new(Self {
            lifecycle,
            transport_sink,
            endpoint_id: endpoint_id.to_owned(),
            operation_id: operation_id.to_owned(),
            session_id: session_id.to_owned(),
            transport: transport.to_owned(),
            terminal_error: Mutex::new(None),
            armed: AtomicBool::new(false),
        })
    }

    fn fail(&self, error: SerialError) {
        if let Ok(mut terminal_error) = self.terminal_error.lock() {
            *terminal_error = Some(error.clone());
        }
        if self.armed.load(Ordering::Acquire) {
            self.retire(error);
        }
    }

    fn arm(&self) -> Option<SerialError> {
        self.armed.store(true, Ordering::Release);
        let error = self
            .terminal_error
            .lock()
            .ok()
            .and_then(|terminal_error| terminal_error.clone());
        if let Some(error) = error.clone() {
            self.retire(error);
        }
        error
    }

    fn retire(&self, error: SerialError) {
        let removed = self.lifecycle.lock().ok().is_some_and(|mut lifecycle| {
            let matches = lifecycle
                .sessions
                .get(&self.endpoint_id)
                .is_some_and(|session| session.session_id == self.session_id);
            if matches {
                lifecycle.sessions.remove(&self.endpoint_id);
            }
            matches
        });
        if !removed {
            return;
        }
        emit_status_to_sink(
            self.transport_sink.as_ref(),
            &self.endpoint_id,
            &self.operation_id,
            &self.session_id,
            &self.transport,
            SerialStatus::Error,
            Some(error.clone()),
        );
        emit_status_to_sink(
            self.transport_sink.as_ref(),
            &self.endpoint_id,
            &self.operation_id,
            &self.session_id,
            &self.transport,
            SerialStatus::Closed,
            Some(error),
        );
    }
}

#[derive(Clone)]
struct ServerService {
    endpoint_id: String,
    session_id: String,
    unit_id: u8,
    data: Arc<Mutex<DataStore>>,
    sink: Arc<dyn ModbusEventSink>,
    transport: String,
    tcp_capture: Option<Arc<Mutex<TcpFrameCapture>>>,
    rtu_capture: Option<Arc<Mutex<RtuFrameCapture>>>,
}

#[derive(Debug)]
struct CapturedTcpRequest {
    transaction_id: u16,
    unit_id: u8,
    function_code: u8,
    frame: Vec<u8>,
    started_at: u64,
}

#[derive(Debug, Default)]
struct TcpFrameCapture {
    receive_buffer: Vec<u8>,
    send_buffer: Vec<u8>,
    requests: VecDeque<CapturedTcpRequest>,
    pending: VecDeque<(u16, ModbusTransaction)>,
}

#[derive(Debug)]
struct CapturedRtuRequest {
    unit_id: u8,
    function_code: u8,
    frame: Vec<u8>,
    started_at: u64,
}

#[derive(Debug, Default)]
struct RtuFrameCapture {
    requests: VecDeque<CapturedRtuRequest>,
    pending: VecDeque<ModbusTransaction>,
}

impl RtuFrameCapture {
    fn ingest_request(&mut self, frame: Vec<u8>) {
        if frame.len() < 4 || !valid_rtu_crc(&frame) {
            return;
        }
        self.requests.push_back(CapturedRtuRequest {
            unit_id: frame[0],
            function_code: frame[1],
            frame,
            started_at: now_millis(),
        });
    }

    fn take_request(&mut self, unit_id: u8, function_code: u8) -> Option<CapturedRtuRequest> {
        let position = self.requests.iter().position(|candidate| {
            candidate.unit_id == unit_id && candidate.function_code == function_code
        })?;
        self.requests.remove(position)
    }

    fn discard_request(&mut self, unit_id: u8) {
        if let Some(position) = self
            .requests
            .iter()
            .position(|candidate| candidate.unit_id == unit_id)
        {
            self.requests.remove(position);
        }
    }

    fn queue_transaction(&mut self, transaction: ModbusTransaction) {
        self.pending.push_back(transaction);
    }

    fn complete_response(&mut self, response_frame: Vec<u8>) -> Option<ModbusTransaction> {
        let mut transaction = self.pending.pop_front()?;
        transaction.response_frame = response_frame;
        let completed_at = now_millis();
        transaction.duration_ms = completed_at.saturating_sub(transaction.created_at);
        transaction.created_at = completed_at;
        Some(transaction)
    }
}

impl TcpFrameCapture {
    fn ingest_received(&mut self, bytes: &[u8]) {
        self.receive_buffer.extend_from_slice(bytes);
        for frame in take_tcp_frames(&mut self.receive_buffer) {
            if frame[2..4] != [0, 0] {
                continue;
            }
            self.requests.push_back(CapturedTcpRequest {
                transaction_id: u16::from_be_bytes([frame[0], frame[1]]),
                unit_id: frame[6],
                function_code: frame[7],
                frame,
                started_at: now_millis(),
            });
        }
    }

    fn take_request(&mut self, unit_id: u8, function_code: u8) -> Option<CapturedTcpRequest> {
        let position = self.requests.iter().position(|candidate| {
            candidate.unit_id == unit_id && candidate.function_code == function_code
        })?;
        self.requests.remove(position)
    }

    fn discard_request(&mut self, unit_id: u8) {
        if let Some(position) = self
            .requests
            .iter()
            .position(|candidate| candidate.unit_id == unit_id)
        {
            self.requests.remove(position);
        }
    }

    fn queue_transaction(&mut self, transaction_id: u16, transaction: ModbusTransaction) {
        self.pending.push_back((transaction_id, transaction));
    }

    fn ingest_sent(&mut self, bytes: &[u8]) -> Vec<ModbusTransaction> {
        self.send_buffer.extend_from_slice(bytes);
        let mut emitted = Vec::new();
        for frame in take_tcp_frames(&mut self.send_buffer) {
            let transaction_id = u16::from_be_bytes([frame[0], frame[1]]);
            let Some(position) = self
                .pending
                .iter()
                .position(|(candidate, _)| *candidate == transaction_id)
            else {
                continue;
            };
            let Some((_, mut transaction)) = self.pending.remove(position) else {
                continue;
            };
            transaction.response_frame = frame;
            let completed_at = now_millis();
            transaction.duration_ms = completed_at.saturating_sub(transaction.created_at);
            transaction.created_at = completed_at;
            emitted.push(transaction);
        }
        emitted
    }
}

struct CapturedTcpStream {
    inner: tokio::net::TcpStream,
    capture: Arc<Mutex<TcpFrameCapture>>,
    sink: Arc<dyn ModbusEventSink>,
}

impl CapturedTcpStream {
    fn new(
        inner: tokio::net::TcpStream,
        capture: Arc<Mutex<TcpFrameCapture>>,
        sink: Arc<dyn ModbusEventSink>,
    ) -> Self {
        Self {
            inner,
            capture,
            sink,
        }
    }
}

impl AsyncRead for CapturedTcpStream {
    fn poll_read(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        let before = buffer.filled().len();
        let result = Pin::new(&mut self.inner).poll_read(cx, buffer);
        if let Poll::Ready(Ok(())) = &result {
            if let Ok(mut capture) = self.capture.lock() {
                capture.ingest_received(&buffer.filled()[before..]);
            }
        }
        result
    }
}

impl AsyncWrite for CapturedTcpStream {
    fn poll_write(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
        buffer: &[u8],
    ) -> Poll<Result<usize, io::Error>> {
        let result = Pin::new(&mut self.inner).poll_write(cx, buffer);
        if let Poll::Ready(Ok(written)) = &result {
            let emitted = self
                .capture
                .lock()
                .map(|mut capture| capture.ingest_sent(&buffer[..*written]))
                .unwrap_or_default();
            for transaction in emitted {
                self.sink.emit(transaction);
            }
        }
        result
    }

    fn poll_flush(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.inner).poll_flush(cx)
    }

    fn poll_shutdown(
        mut self: Pin<&mut Self>,
        cx: &mut TaskContext<'_>,
    ) -> Poll<Result<(), io::Error>> {
        Pin::new(&mut self.inner).poll_shutdown(cx)
    }
}

#[derive(Clone)]
struct DataArea<T> {
    start: u16,
    values: Vec<T>,
}

struct DataStore {
    coils: DataArea<bool>,
    discrete_inputs: DataArea<bool>,
    holding_registers: DataArea<u16>,
    input_registers: DataArea<u16>,
}

#[derive(Clone)]
struct Config {
    unit_id: u8,
    timeout: Duration,
    host: String,
    port: u16,
    listen_host: String,
    listen_port: u16,
    path: String,
    baud_rate: u32,
    data_bits: u8,
    parity: String,
    stop_bits: f64,
    flow_control: String,
    data_areas: Value,
}

impl ModbusService {
    pub(crate) fn new(
        transport_sink: Arc<dyn SerialEventSink>,
        modbus_sink: Arc<dyn ModbusEventSink>,
    ) -> Self {
        Self {
            transport_sink,
            modbus_sink,
            lifecycle: Arc::new(Mutex::new(Lifecycle {
                stopped: false,
                next_session_id: 1,
                sessions: HashMap::new(),
                opening: HashMap::new(),
            })),
            opening_changed: Condvar::new(),
            #[cfg(test)]
            before_open_commit: Mutex::new(None),
        }
    }

    pub(crate) fn open(
        &self,
        endpoint: ModbusEndpoint,
        operation_id: &str,
    ) -> Result<OpenAcknowledgement, SerialError> {
        require_text(&endpoint.endpoint_id, "endpointId")?;
        require_text(operation_id, "operationId")?;
        if !matches!(
            endpoint.transport.as_str(),
            "modbus-tcp-master" | "modbus-tcp-slave" | "modbus-rtu-master" | "modbus-rtu-slave"
        ) {
            return Err(config_error("unsupported Modbus transport"));
        }
        let config = Config::from_value(&endpoint.config)?;
        let cancel = CancellationToken::new();
        let session_id = {
            let mut lifecycle = lock(&self.lifecycle)?;
            if lifecycle.stopped {
                return Err(config_error("Modbus service is shut down"));
            }
            if lifecycle.sessions.contains_key(&endpoint.endpoint_id)
                || lifecycle.opening.contains_key(&endpoint.endpoint_id)
            {
                return Err(SerialError::new(
                    SerialErrorCode::PortBusy,
                    format!("Endpoint {} is already active", endpoint.endpoint_id),
                ));
            }
            let session_id = format!("modbus-{}", lifecycle.next_session_id);
            lifecycle.next_session_id += 1;
            lifecycle.opening.insert(
                endpoint.endpoint_id.clone(),
                OpeningOperation {
                    operation_id: operation_id.to_owned(),
                    cancel: cancel.clone(),
                },
            );
            session_id
        };
        self.emit_status_parts(
            &endpoint.endpoint_id,
            operation_id,
            &session_id,
            &endpoint.transport,
            SerialStatus::Opening,
            None,
        );
        let slave_termination = endpoint.transport.ends_with("-slave").then(|| {
            SlaveTermination::for_open(
                self.lifecycle.clone(),
                self.transport_sink.clone(),
                &endpoint.endpoint_id,
                operation_id,
                &session_id,
                &endpoint.transport,
            )
        });
        let kind = match (|| -> Result<SessionKind, SerialError> {
            Ok(match endpoint.transport.as_str() {
                "modbus-tcp-master" => {
                    SessionKind::Master(Mutex::new(open_tcp_master(&config, &cancel)?))
                }
                "modbus-rtu-master" => {
                    SessionKind::Master(Mutex::new(open_rtu_master(&config, &cancel)?))
                }
                "modbus-tcp-slave" | "modbus-rtu-slave" => {
                    let data = Arc::new(Mutex::new(DataStore::from_value(&config.data_areas)?));
                    let service = ServerService {
                        endpoint_id: endpoint.endpoint_id.clone(),
                        session_id: session_id.clone(),
                        unit_id: config.unit_id,
                        data: data.clone(),
                        sink: self.modbus_sink.clone(),
                        transport: endpoint.transport.clone(),
                        tcp_capture: None,
                        rtu_capture: None,
                    };
                    let (cancel, worker) = if endpoint.transport == "modbus-tcp-slave" {
                        start_tcp_slave(
                            &config,
                            service,
                            slave_termination.as_ref().unwrap().clone(),
                        )?
                    } else {
                        start_rtu_slave(
                            &config,
                            service,
                            slave_termination.as_ref().unwrap().clone(),
                        )?
                    };
                    SessionKind::Slave {
                        data,
                        cancel,
                        worker: Mutex::new(Some(worker)),
                    }
                }
                _ => unreachable!(),
            })
        })() {
            Ok(kind) => kind,
            Err(error) => {
                self.finish_opening(&endpoint.endpoint_id);
                self.emit_status_parts(
                    &endpoint.endpoint_id,
                    operation_id,
                    &session_id,
                    &endpoint.transport,
                    SerialStatus::Error,
                    Some(error.clone()),
                );
                self.emit_status_parts(
                    &endpoint.endpoint_id,
                    operation_id,
                    &session_id,
                    &endpoint.transport,
                    SerialStatus::Closed,
                    Some(error.clone()),
                );
                return Err(error);
            }
        };
        let session = Arc::new(Session {
            endpoint_id: endpoint.endpoint_id.clone(),
            operation_id: operation_id.to_owned(),
            session_id: session_id.clone(),
            transport: endpoint.transport.clone(),
            unit_id: config.unit_id,
            kind,
        });
        #[cfg(test)]
        if let Some(hook) = lock(&self.before_open_commit)?.clone() {
            hook();
        }
        let commit = match self.lifecycle.lock() {
            Ok(mut lifecycle) => {
                let result = if lifecycle.stopped || cancel.is_cancelled() {
                    Err(SerialError::new(
                        SerialErrorCode::OpenCancelled,
                        "Modbus open cancelled during shutdown",
                    ))
                } else {
                    lifecycle
                        .sessions
                        .insert(endpoint.endpoint_id.clone(), session.clone());
                    Ok(())
                };
                self.opening_changed.notify_all();
                result
            }
            Err(_) => Err(config_error("Modbus service mutex poisoned")),
        };
        if let Err(error) = commit {
            let _ = cleanup_kind(&session.kind);
            self.finish_opening(&endpoint.endpoint_id);
            self.emit_status(&session, SerialStatus::Error, Some(error.clone()));
            self.emit_status(&session, SerialStatus::Closed, Some(error.clone()));
            return Err(error);
        }
        // Serialize status publication with cancellation, including the narrow
        // race after resource creation and before the open acknowledgement.
        let terminal_error = slave_termination.as_deref().and_then(SlaveTermination::arm);
        let published = {
            let lifecycle = lock(&self.lifecycle)?;
            if cancel.is_cancelled()
                || !lifecycle
                    .sessions
                    .get(&endpoint.endpoint_id)
                    .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                Err(SerialError::new(
                    SerialErrorCode::OpenCancelled,
                    "Modbus open cancelled",
                ))
            } else if let Some(error) = terminal_error {
                Err(error)
            } else {
                self.publish_open_status(&session, None)
            }
        };
        if let Err(error) = published {
            lock(&self.lifecycle)?
                .sessions
                .remove(&endpoint.endpoint_id);
            let _ = cleanup_kind(&session.kind);
            self.finish_opening(&endpoint.endpoint_id);
            return Err(error);
        }
        self.finish_opening(&endpoint.endpoint_id);
        Ok(OpenAcknowledgement {
            endpoint_id: endpoint.endpoint_id,
            operation_id: operation_id.to_owned(),
            session_id,
        })
    }

    fn publish_open_status(
        &self,
        session: &Session,
        slave_termination: Option<&SlaveTermination>,
    ) -> Result<(), SerialError> {
        if let Some(error) = slave_termination.and_then(SlaveTermination::arm) {
            return Err(error);
        }
        self.emit_status(
            session,
            if session.transport.ends_with("-slave") {
                SerialStatus::Listening
            } else {
                SerialStatus::Open
            },
            None,
        );
        Ok(())
    }

    fn finish_opening(&self, endpoint_id: &str) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.opening.remove(endpoint_id);
            self.opening_changed.notify_all();
        }
    }

    pub(crate) fn execute(
        &self,
        request: ModbusExecuteRequest,
    ) -> Result<ModbusTransaction, SerialError> {
        validate_execute(&request)?;
        let session = self.session(&request.endpoint_id)?;
        if request
            .expected_session_id
            .as_ref()
            .is_some_and(|id| id != &session.session_id)
        {
            return Err(SerialError::new(
                SerialErrorCode::OpenCancelled,
                "Modbus request belongs to an inactive session",
            ));
        }
        let SessionKind::Master(client) = &session.kind else {
            return Err(config_error("only a Modbus master can execute requests"));
        };
        let started_at = now_millis();
        let operation = request_to_protocol(&request)?;
        let response = {
            let mut client = lock(client)?;
            if !lock(&self.lifecycle)?
                .sessions
                .get(&request.endpoint_id)
                .is_some_and(|current| Arc::ptr_eq(current, &session))
            {
                return Err(SerialError::new(
                    SerialErrorCode::OpenCancelled,
                    "Modbus request belongs to an inactive session",
                ));
            }
            client.set_slave(Slave(request.unit_id));
            let default_timeout = client.timeout();
            if let Some(timeout_ms) = request.timeout_ms {
                client.set_timeout(Duration::from_millis(timeout_ms));
            }
            let response = client.call(operation);
            client.set_timeout(default_timeout);
            response
        };
        match response {
            Ok(Ok(response)) => {
                let values = response_values(&response, &request);
                let transaction =
                    transaction(&session, "master", &request, values, started_at, None);
                self.modbus_sink.emit(transaction.clone());
                Ok(transaction)
            }
            Ok(Err(exception)) => {
                let code = u8::from(exception);
                let message = format!("Modbus exception 0x{code:02X}");
                let transaction = transaction(
                    &session,
                    "master",
                    &request,
                    Vec::new(),
                    started_at,
                    Some((Some(code), message.clone())),
                );
                self.modbus_sink.emit(transaction);
                Err(SerialError::new(SerialErrorCode::ModbusException, message))
            }
            Err(error) => {
                let message = error.to_string();
                let transaction = transaction(
                    &session,
                    "master",
                    &request,
                    Vec::new(),
                    started_at,
                    Some((None, message.clone())),
                );
                self.modbus_sink.emit(transaction);
                let error = map_io_message(message);
                self.retire_failed_master(&session, &error);
                Err(error)
            }
        }
    }

    pub(crate) fn read_map(&self, endpoint_id: &str) -> Result<Value, SerialError> {
        let session = self.session(endpoint_id)?;
        let SessionKind::Slave { data, .. } = &session.kind else {
            return Err(config_error("only a Modbus slave has a data map"));
        };
        let snapshot = map_snapshot(&session, &*lock(data)?);
        Ok(snapshot)
    }

    pub(crate) fn write_map(&self, request: ModbusMapWriteRequest) -> Result<Value, SerialError> {
        if request.values.is_empty() {
            return Err(config_error("values must be a nonempty array"));
        }
        let session = self.session(&request.endpoint_id)?;
        if let Some(expected) = &request.expected_session_id {
            require_text(expected, "expectedSessionId")?;
            if expected != &session.session_id {
                return Err(SerialError::new(
                    SerialErrorCode::OpenCancelled,
                    "Modbus slave session has changed",
                ));
            }
        }
        let SessionKind::Slave { data, .. } = &session.kind else {
            return Err(config_error("only a Modbus slave has a data map"));
        };
        let mut data = lock(data)?;
        match request.area.as_str() {
            "coils" => write_bool_values(&mut data.coils, request.address, &request.values)?,
            "discreteInputs" => {
                write_bool_values(&mut data.discrete_inputs, request.address, &request.values)?
            }
            "holdingRegisters" => write_word_values(
                &mut data.holding_registers,
                request.address,
                &request.values,
            )?,
            "inputRegisters" => {
                write_word_values(&mut data.input_registers, request.address, &request.values)?
            }
            _ => return Err(config_error("unknown Modbus data area")),
        }
        let transaction = ModbusTransaction {
            endpoint_id: session.endpoint_id.clone(),
            session_id: session.session_id.clone(),
            request_group_id: None,
            request_id: None,
            origin: "local",
            unit_id: session.unit_id,
            function_code: 0,
            address: request.address,
            quantity: request.values.len() as u16,
            request_values: request.values.clone(),
            values: request.values,
            success: true,
            exception_code: None,
            message: None,
            transport: session.transport.clone(),
            request_frame: Vec::new(),
            response_frame: Vec::new(),
            created_at: now_millis(),
            duration_ms: 0,
        };
        self.modbus_sink.emit(transaction);
        Ok(map_snapshot(&session, &data))
    }

    pub(crate) fn cancel_open(
        &self,
        endpoint_id: &str,
        operation_id: &str,
    ) -> Result<crate::serial::CancelAcknowledgement, SerialError> {
        require_text(endpoint_id, "endpointId")?;
        require_text(operation_id, "operationId")?;
        let mut lifecycle = lock(&self.lifecycle)?;
        let opening = lifecycle
            .opening
            .get(endpoint_id)
            .is_some_and(|operation| operation.operation_id == operation_id);
        if opening {
            lifecycle.opening.get(endpoint_id).unwrap().cancel.cancel();
            while lifecycle
                .opening
                .get(endpoint_id)
                .is_some_and(|operation| operation.operation_id == operation_id)
            {
                lifecycle = self
                    .opening_changed
                    .wait(lifecycle)
                    .map_err(|_| config_error("Modbus service mutex poisoned"))?;
            }
        }
        let session = if lifecycle
            .sessions
            .get(endpoint_id)
            .is_some_and(|session| session.operation_id == operation_id)
        {
            lifecycle.sessions.remove(endpoint_id)
        } else {
            None
        };
        drop(lifecycle);
        let cancelled = opening || session.is_some();
        if let Some(session) = session {
            cleanup_kind(&session.kind)?;
            self.emit_status(&session, SerialStatus::Closed, None);
        }
        Ok(crate::serial::CancelAcknowledgement {
            endpoint_id: endpoint_id.into(),
            operation_id: operation_id.into(),
            cancelled,
        })
    }

    pub(crate) fn close(&self, endpoint_id: &str) -> Result<CloseAcknowledgement, SerialError> {
        let operation_id = lock(&self.lifecycle)?
            .opening
            .get(endpoint_id)
            .map(|operation| operation.operation_id.clone());
        if let Some(operation_id) = operation_id {
            self.cancel_open(endpoint_id, &operation_id)?;
        }
        let session = lock(&self.lifecycle)?.sessions.remove(endpoint_id);
        if let Some(session) = session {
            self.emit_status(&session, SerialStatus::Closing, None);
            cleanup_kind(&session.kind)?;
            self.emit_status(&session, SerialStatus::Closed, None);
        }
        Ok(CloseAcknowledgement {
            endpoint_id: endpoint_id.to_owned(),
            closed: true,
        })
    }

    pub(crate) fn close_all(&self) -> Result<(), SerialError> {
        let ids = {
            let lifecycle = lock(&self.lifecycle)?;
            lifecycle
                .sessions
                .keys()
                .chain(lifecycle.opening.keys())
                .cloned()
                .collect::<Vec<_>>()
        };
        let mut first_error = None;
        for id in ids {
            if let Err(error) = self.close(&id) {
                first_error.get_or_insert(error);
            }
        }
        first_error.map_or(Ok(()), Err)
    }

    pub(crate) fn shutdown(&self) -> Result<(), SerialError> {
        let mut lifecycle = lock(&self.lifecycle)?;
        lifecycle.stopped = true;
        for operation in lifecycle.opening.values() {
            operation.cancel.cancel();
        }
        while !lifecycle.opening.is_empty() {
            lifecycle = self
                .opening_changed
                .wait(lifecycle)
                .map_err(|_| config_error("Modbus service mutex poisoned"))?;
        }
        drop(lifecycle);
        self.close_all()
    }

    pub(crate) fn force_shutdown(&self) -> Vec<String> {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.stopped = true;
            for operation in lifecycle.opening.values() {
                operation.cancel.cancel();
            }
            for session in lifecycle.sessions.values() {
                if let SessionKind::Slave { cancel, .. } = &session.kind {
                    cancel.cancel();
                }
            }
            lifecycle.sessions.clear();
        }
        Vec::new()
    }

    fn session(&self, endpoint_id: &str) -> Result<Arc<Session>, SerialError> {
        lock(&self.lifecycle)?
            .sessions
            .get(endpoint_id)
            .cloned()
            .ok_or_else(|| config_error(format!("Endpoint {endpoint_id} is not open")))
    }

    fn retire_failed_master(&self, session: &Arc<Session>, error: &SerialError) {
        let removed = self.lifecycle.lock().ok().is_some_and(|mut lifecycle| {
            let current = lifecycle
                .sessions
                .get(&session.endpoint_id)
                .is_some_and(|current| Arc::ptr_eq(current, session));
            if current {
                lifecycle.sessions.remove(&session.endpoint_id);
            }
            current
        });
        if !removed {
            return;
        }
        let _ = cleanup_kind(&session.kind);
        self.emit_status(session, SerialStatus::Error, Some(error.clone()));
        self.emit_status(session, SerialStatus::Closed, Some(error.clone()));
    }

    fn emit_status(&self, session: &Session, status: SerialStatus, error: Option<SerialError>) {
        self.emit_status_parts(
            &session.endpoint_id,
            &session.operation_id,
            &session.session_id,
            &session.transport,
            status,
            error,
        );
    }

    fn emit_status_parts(
        &self,
        endpoint_id: &str,
        operation_id: &str,
        session_id: &str,
        transport: &str,
        status: SerialStatus,
        error: Option<SerialError>,
    ) {
        emit_status_to_sink(
            self.transport_sink.as_ref(),
            endpoint_id,
            operation_id,
            session_id,
            transport,
            status,
            error,
        );
    }
}

fn emit_status_to_sink(
    sink: &dyn SerialEventSink,
    endpoint_id: &str,
    operation_id: &str,
    session_id: &str,
    transport: &str,
    status: SerialStatus,
    error: Option<SerialError>,
) {
    let created_at = now_millis();
    let retained_session = !matches!(status, SerialStatus::Opening | SerialStatus::Closed);
    let level = if status == SerialStatus::Error {
        "error"
    } else if matches!(status, SerialStatus::Opening | SerialStatus::Closing) {
        "debug"
    } else {
        "info"
    };
    let log = if status == SerialStatus::Closed && error.is_some() {
        None
    } else {
        Some(StatusLog {
            level,
            source: "modbus",
            peer_id: None,
            code: error
                .as_ref()
                .map(|error| error_code_name(error.code).into()),
            message: format!("Modbus {}", status_name(status)),
            details: Some(json!({ "transport": transport })),
            created_at,
        })
    };
    sink.emit(SerialEvent::Status(StatusEvent {
        endpoint_id: endpoint_id.to_owned(),
        operation_id: operation_id.to_owned(),
        session_id: retained_session.then(|| session_id.to_owned()),
        status,
        error,
        created_at,
        log,
    }));
}

impl Service for ServerService {
    type Request = SlaveRequest<'static>;
    type Response = Option<Response>;
    type Exception = ExceptionCode;
    type Future = future::Ready<Result<Self::Response, Self::Exception>>;

    fn call(&self, request: Self::Request) -> Self::Future {
        if request.slave != self.unit_id {
            if let Some(capture) = &self.tcp_capture {
                if let Ok(mut capture) = capture.lock() {
                    capture.discard_request(request.slave);
                }
            }
            if let Some(capture) = &self.rtu_capture {
                if let Ok(mut capture) = capture.lock() {
                    capture.discard_request(request.slave);
                }
            }
            return future::ready(Ok(None));
        }
        let started_at = now_millis();
        let (function_code, address, quantity, values, outcome) = match lock(&self.data) {
            Err(_) => (0, 0, 0, Vec::new(), Err(ExceptionCode::ServerDeviceFailure)),
            Ok(mut data) => handle_server_request(&mut data, request.request),
        };
        let captured_request = self.tcp_capture.as_ref().and_then(|capture| {
            capture
                .lock()
                .ok()?
                .take_request(self.unit_id, function_code)
        });
        let captured_rtu_request = self.rtu_capture.as_ref().and_then(|capture| {
            capture
                .lock()
                .ok()?
                .take_request(self.unit_id, function_code)
        });
        let (success, exception_code, message) = match &outcome {
            Ok(_) => (true, None, None),
            Err(exception) => {
                let code = u8::from(*exception);
                (
                    false,
                    Some(code),
                    Some(format!("Modbus exception 0x{code:02X}")),
                )
            }
        };
        let request_values = if function_code <= 4 {
            Vec::new()
        } else {
            values.clone()
        };
        let (request_frame, started_at) = if self.transport == "modbus-tcp-slave" {
            (
                captured_request
                    .as_ref()
                    .map(|request| request.frame.clone())
                    .unwrap_or_default(),
                captured_request
                    .as_ref()
                    .map_or(started_at, |request| request.started_at),
            )
        } else {
            (
                captured_rtu_request
                    .as_ref()
                    .map(|request| request.frame.clone())
                    .unwrap_or_default(),
                captured_rtu_request
                    .as_ref()
                    .map_or(started_at, |request| request.started_at),
            )
        };
        let transaction = ModbusTransaction {
            endpoint_id: self.endpoint_id.clone(),
            session_id: self.session_id.clone(),
            request_group_id: None,
            request_id: None,
            origin: "slave",
            unit_id: self.unit_id,
            function_code,
            address,
            quantity,
            request_values,
            values,
            success,
            exception_code,
            message,
            transport: self.transport.clone(),
            request_frame,
            response_frame: Vec::new(),
            created_at: now_millis(),
            duration_ms: now_millis().saturating_sub(started_at),
        };
        if let (Some(capture), Some(request)) = (&self.tcp_capture, captured_request) {
            if let Ok(mut capture) = capture.lock() {
                capture.queue_transaction(request.transaction_id, transaction);
            }
        } else if let (Some(capture), Some(_request)) = (&self.rtu_capture, captured_rtu_request) {
            if let Ok(mut capture) = capture.lock() {
                capture.queue_transaction(transaction);
            }
        } else {
            self.sink.emit(transaction);
        }
        future::ready(outcome.map(Some))
    }
}

fn cleanup_kind(kind: &SessionKind) -> Result<(), SerialError> {
    match kind {
        SessionKind::Master(client) => {
            lock(client)?.context.take();
        }
        SessionKind::Slave { cancel, worker, .. } => {
            cancel.cancel();
            if let Some(worker) = lock(worker)?.take() {
                let _ = worker.join();
            }
        }
    }
    Ok(())
}

type ServerOutcome = (u8, u16, u16, Vec<Value>, Result<Response, ExceptionCode>);

fn handle_server_request(data: &mut DataStore, request: Request<'static>) -> ServerOutcome {
    match request {
        Request::ReadCoils(address, quantity) => {
            let result = read_area(&data.coils, address, quantity)
                .map(|values| Response::ReadCoils(values.clone()));
            let values = result
                .as_ref()
                .ok()
                .map(response_json_values)
                .unwrap_or_default();
            (1, address, quantity, values, result)
        }
        Request::ReadDiscreteInputs(address, quantity) => {
            let result = read_area(&data.discrete_inputs, address, quantity)
                .map(|values| Response::ReadDiscreteInputs(values.clone()));
            let values = result
                .as_ref()
                .ok()
                .map(response_json_values)
                .unwrap_or_default();
            (2, address, quantity, values, result)
        }
        Request::ReadHoldingRegisters(address, quantity) => {
            let result = read_area(&data.holding_registers, address, quantity)
                .map(|values| Response::ReadHoldingRegisters(values.clone()));
            let values = result
                .as_ref()
                .ok()
                .map(response_json_values)
                .unwrap_or_default();
            (3, address, quantity, values, result)
        }
        Request::ReadInputRegisters(address, quantity) => {
            let result = read_area(&data.input_registers, address, quantity)
                .map(|values| Response::ReadInputRegisters(values.clone()));
            let values = result
                .as_ref()
                .ok()
                .map(response_json_values)
                .unwrap_or_default();
            (4, address, quantity, values, result)
        }
        Request::WriteSingleCoil(address, value) => {
            let result = write_slice(&mut data.coils, address, &[value])
                .map(|()| Response::WriteSingleCoil(address, value));
            (5, address, 1, vec![Value::Bool(value)], result)
        }
        Request::WriteSingleRegister(address, value) => {
            let result = write_slice(&mut data.holding_registers, address, &[value])
                .map(|()| Response::WriteSingleRegister(address, value));
            (6, address, 1, vec![Value::from(value)], result)
        }
        Request::WriteMultipleCoils(address, values) => {
            let quantity = values.len() as u16;
            let json_values = values.iter().copied().map(Value::Bool).collect();
            let result = write_slice(&mut data.coils, address, &values)
                .map(|()| Response::WriteMultipleCoils(address, quantity));
            (15, address, quantity, json_values, result)
        }
        Request::WriteMultipleRegisters(address, values) => {
            let quantity = values.len() as u16;
            let json_values = values.iter().copied().map(Value::from).collect();
            let result = write_slice(&mut data.holding_registers, address, &values)
                .map(|()| Response::WriteMultipleRegisters(address, quantity));
            (16, address, quantity, json_values, result)
        }
        _ => (0, 0, 0, Vec::new(), Err(ExceptionCode::IllegalFunction)),
    }
}

fn start_tcp_slave(
    config: &Config,
    service: ServerService,
    termination: Arc<SlaveTermination>,
) -> Result<(CancellationToken, JoinHandle<()>), SerialError> {
    let address = resolve_address(&config.listen_host, config.listen_port)?;
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
        };
        runtime.block_on(async move {
            let listener = match tokio::net::TcpListener::bind(address).await {
                Ok(listener) => listener,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            let _ = ready_tx.send(Ok(()));
            let server = tokio_modbus::server::tcp::Server::new(listener);
            let on_connected = move |stream, _socket_addr| {
                let capture = Arc::new(Mutex::new(TcpFrameCapture::default()));
                let mut service = service.clone();
                service.tcp_capture = Some(capture.clone());
                let sink = service.sink.clone();
                async move {
                    Ok(Some((
                        service,
                        CapturedTcpStream::new(stream, capture, sink),
                    )))
                }
            };
            let cancelled = task_cancel.clone();
            let result = server
                .serve_until(&on_connected, |_error| {}, task_cancel.cancelled_owned())
                .await;
            finish_slave_runtime(result, cancelled.is_cancelled(), &termination);
        });
    });
    await_ready(ready_rx)?;
    Ok((cancel, worker))
}

fn start_rtu_slave(
    config: &Config,
    mut service: ServerService,
    termination: Arc<SlaveTermination>,
) -> Result<(CancellationToken, JoinHandle<()>), SerialError> {
    let builder = serial_builder(config)?;
    let frame_silence = rtu_frame_silence(config);
    let cancel = CancellationToken::new();
    let task_cancel = cancel.clone();
    let (ready_tx, ready_rx) = mpsc::sync_channel(1);
    let worker = thread::spawn(move || {
        let runtime = match tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let _ = ready_tx.send(Err(error.to_string()));
                return;
            }
        };
        runtime.block_on(async move {
            let serial = match SerialStream::open(&builder) {
                Ok(serial) => serial,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };
            let capture = Arc::new(Mutex::new(RtuFrameCapture::default()));
            service.rtu_capture = Some(capture);
            let _ = ready_tx.send(Ok(()));
            let cancelled = task_cancel.clone();
            let result = serve_rtu_until(serial, service, task_cancel, frame_silence).await;
            finish_slave_runtime(result, cancelled.is_cancelled(), &termination);
        });
    });
    await_ready(ready_rx)?;
    Ok((cancel, worker))
}

fn finish_slave_runtime<T, E>(result: Result<T, E>, cancelled: bool, termination: &SlaveTermination)
where
    E: std::fmt::Display,
{
    if let Err(error) = result {
        if !cancelled {
            termination.fail(map_io_message(error.to_string()));
        }
    }
}

async fn serve_rtu_until<T>(
    mut serial: T,
    service: ServerService,
    cancel: CancellationToken,
    frame_silence: Duration,
) -> io::Result<()>
where
    T: AsyncRead + AsyncWrite + Unpin,
{
    let capture = service
        .rtu_capture
        .clone()
        .ok_or_else(|| io::Error::other("missing Modbus RTU frame capture"))?;
    let mut receive_buffer = Vec::new();
    let mut chunk = [0_u8; 256];
    loop {
        let received = tokio::select! {
            biased;
            () = cancel.cancelled() => return Ok(()),
            () = tokio::time::sleep(frame_silence), if !receive_buffer.is_empty() => {
                // RTU silence ends an incomplete ADU. Never search inside its
                // payload for another apparent frame before that boundary.
                receive_buffer.clear();
                continue;
            },
            result = serial.read(&mut chunk) => result?,
        };
        if received == 0 {
            return Ok(());
        }
        receive_buffer.extend_from_slice(&chunk[..received]);
        while let Some(request_frame) = take_rtu_request_frame(&mut receive_buffer) {
            if cancel.is_cancelled() {
                return Ok(());
            }
            let request = match parse_rtu_request(&request_frame) {
                Ok(request) => request,
                Err(_) => continue,
            };
            let unit_id = request_frame[0];
            let function_code = request_frame[1];
            if let Ok(mut capture) = capture.lock() {
                capture.ingest_request(request_frame);
            }
            let response_pdu = match service.call(request).await {
                Ok(Some(response)) => response_to_rtu_pdu(response)?,
                Ok(None) => continue,
                Err(exception) => vec![function_code | 0x80, u8::from(exception)],
            };
            let response_frame = rtu_frame(unit_id, &response_pdu);
            tokio::select! {
                biased;
                () = cancel.cancelled() => return Ok(()),
                result = serial.write_all(&response_frame) => result?,
            }
            let completed = capture
                .lock()
                .ok()
                .and_then(|mut capture| capture.complete_response(response_frame));
            if let Some(transaction) = completed {
                service.sink.emit(transaction);
            }
        }
    }
}

fn rtu_frame_silence(config: &Config) -> Duration {
    // Modbus Serial Line V1.02: t3.5 is fixed at 1.75ms above 19200 baud;
    // otherwise account for start, data, optional parity and stop bits.
    if config.baud_rate > 19_200 {
        Duration::from_micros(1750)
    } else {
        let parity_bits = if config.parity == "none" { 0.0 } else { 1.0 };
        let character_bits = 1.0 + f64::from(config.data_bits) + parity_bits + config.stop_bits;
        Duration::from_secs_f64(3.5 * character_bits / f64::from(config.baud_rate))
    }
}

fn master_runtime() -> Result<tokio::runtime::Runtime, SerialError> {
    tokio::runtime::Builder::new_current_thread()
        .enable_io()
        .enable_time()
        .build()
        .map_err(|error| map_io_message(error.to_string()))
}

async fn connect_master<T>(
    cancel: &CancellationToken,
    timeout: Duration,
    connect: impl std::future::Future<Output = io::Result<T>>,
) -> Result<T, SerialError> {
    tokio::select! {
        biased;
        _ = cancel.cancelled() => Err(SerialError::new(SerialErrorCode::OpenCancelled, "Modbus open cancelled")),
        result = tokio::time::timeout(timeout, connect) => result
            .map_err(|error| map_io_message(error.to_string()))?
            .map_err(|error| map_io_message(error.to_string())),
    }
}

fn open_tcp_master(
    config: &Config,
    cancel: &CancellationToken,
) -> Result<MasterContext, SerialError> {
    let runtime = master_runtime()?;
    let context = runtime.block_on(connect_master(cancel, config.timeout, async {
        let stream = tokio::net::TcpStream::connect((config.host.as_str(), config.port)).await?;
        Ok(tokio_modbus::client::tcp::attach_slave(
            stream,
            Slave(config.unit_id),
        ))
    }))?;
    Ok(MasterContext {
        runtime,
        context: Some(context),
        timeout: Some(config.timeout),
    })
}

fn open_rtu_master(
    config: &Config,
    cancel: &CancellationToken,
) -> Result<MasterContext, SerialError> {
    let builder = serial_builder(config)?;
    let runtime = master_runtime()?;
    let context = runtime.block_on(connect_master(cancel, config.timeout, async {
        let serial = SerialStream::open(&builder)?;
        Ok(tokio_modbus::client::rtu::attach_slave(
            serial,
            Slave(config.unit_id),
        ))
    }))?;
    Ok(MasterContext {
        runtime,
        context: Some(context),
        timeout: Some(config.timeout),
    })
}

fn serial_builder(config: &Config) -> Result<tokio_serial::SerialPortBuilder, SerialError> {
    if config.path.trim().is_empty() {
        return Err(SerialError::new(
            SerialErrorCode::PortNotFound,
            "serial path is required",
        ));
    }
    let data_bits = match config.data_bits {
        5 => DataBits::Five,
        6 => DataBits::Six,
        7 => DataBits::Seven,
        8 => DataBits::Eight,
        _ => return Err(config_error("dataBits must be 5, 6, 7, or 8")),
    };
    let parity = match config.parity.as_str() {
        "none" => Parity::None,
        "odd" => Parity::Odd,
        "even" => Parity::Even,
        _ => {
            return Err(config_error(
                "Rust runtime supports none, odd, or even parity",
            ))
        }
    };
    let stop_bits = match config.stop_bits {
        1.0 => StopBits::One,
        2.0 => StopBits::Two,
        _ => return Err(config_error("Rust runtime supports one or two stop bits")),
    };
    let flow_control = match config.flow_control.as_str() {
        "none" => FlowControl::None,
        "software" => FlowControl::Software,
        "hardware" => FlowControl::Hardware,
        _ => return Err(config_error("invalid flow control")),
    };
    Ok(
        tokio_serial::new(&config.path, effective_modbus_baud_rate(config))
            .data_bits(data_bits)
            .parity(parity)
            .stop_bits(stop_bits)
            .flow_control(flow_control),
    )
}

#[cfg(target_os = "macos")]
fn effective_modbus_baud_rate(config: &Config) -> u32 {
    if config.path.strip_prefix("/dev/ttys").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        0
    } else {
        config.baud_rate
    }
}

#[cfg(not(target_os = "macos"))]
fn effective_modbus_baud_rate(config: &Config) -> u32 {
    config.baud_rate
}

impl Config {
    fn from_value(value: &Value) -> Result<Self, SerialError> {
        let object = value
            .as_object()
            .ok_or_else(|| config_error("Modbus config must be an object"))?;
        Ok(Self {
            unit_id: u8_field(object, "unitId", 1, 247, 1)?,
            timeout: Duration::from_millis(u64_field(object, "timeoutMs", 50, 60_000, 1000)?),
            host: string_field(object, "host", "127.0.0.1")?,
            port: u16_field(object, "port", 502)?,
            listen_host: string_field(object, "listenHost", "0.0.0.0")?,
            listen_port: u16_field(object, "listenPort", 502)?,
            path: string_field(object, "path", "")?,
            baud_rate: u32_field(object, "baudRate", 9600)?,
            data_bits: u8_field(object, "dataBits", 5, 8, 8)?,
            parity: string_field(object, "parity", "none")?,
            stop_bits: f64_field(object, "stopBits", 1.0)?,
            flow_control: string_field(object, "flowControl", "none")?,
            data_areas: match object.get("dataAreas") {
                None => json!({}),
                Some(value) if value.is_object() => value.clone(),
                Some(_) => return Err(config_error("dataAreas must be an object")),
            },
        })
    }
}

impl DataStore {
    fn from_value(value: &Value) -> Result<Self, SerialError> {
        Ok(Self {
            coils: bool_area(value.get("coils"))?,
            discrete_inputs: bool_area(value.get("discreteInputs"))?,
            holding_registers: word_area(value.get("holdingRegisters"))?,
            input_registers: word_area(value.get("inputRegisters"))?,
        })
    }
}

fn bool_area(value: Option<&Value>) -> Result<DataArea<bool>, SerialError> {
    let (start, count, values) = area_parts(value)?;
    let mut result = values
        .iter()
        .take(count)
        .map(|value| {
            value
                .as_bool()
                .or_else(|| value.as_u64().map(|value| value == 1))
                .ok_or_else(|| config_error("bit area contains an invalid value"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    result.resize(count, false);
    Ok(DataArea {
        start,
        values: result,
    })
}

fn word_area(value: Option<&Value>) -> Result<DataArea<u16>, SerialError> {
    let (start, count, values) = area_parts(value)?;
    let mut result = values
        .iter()
        .take(count)
        .map(|value| {
            value
                .as_u64()
                .filter(|value| *value <= u16::MAX as u64)
                .map(|value| value as u16)
                .ok_or_else(|| config_error("register area contains an invalid value"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    result.resize(count, 0);
    Ok(DataArea {
        start,
        values: result,
    })
}

fn area_parts(value: Option<&Value>) -> Result<(u16, usize, Vec<Value>), SerialError> {
    let object = match value {
        None => None,
        Some(value) => Some(
            value
                .as_object()
                .ok_or_else(|| config_error("Modbus data area must be an object"))?,
        ),
    };
    let start = object.map_or(Ok(0), |value| {
        u64_field(value, "start", 0, u16::MAX.into(), 0)
    })?;
    let count = object.map_or(Ok(100), |value| u64_field(value, "count", 1, 10_000, 100))?;
    if start > u16::MAX as u64 || count == 0 || count > 10_000 || start + count > 65_536 {
        return Err(config_error("Modbus data area range is invalid"));
    }
    let values = match object.and_then(|value| value.get("values")) {
        None => Vec::new(),
        Some(value) => value
            .as_array()
            .cloned()
            .ok_or_else(|| config_error("Modbus data area values must be an array"))?,
    };
    if values.len() > count as usize {
        return Err(config_error(
            "Modbus data area values exceed the configured count",
        ));
    }
    Ok((start as u16, count as usize, values))
}

fn validate_execute(request: &ModbusExecuteRequest) -> Result<(), SerialError> {
    if let Some(id) = &request.expected_session_id {
        require_text(id, "expectedSessionId")?;
    }
    if request
        .request_group_id
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(config_error("requestGroupId must be a nonblank string"));
    }
    if request
        .request_id
        .as_ref()
        .is_some_and(|value| value.trim().is_empty())
    {
        return Err(config_error("requestId must be a nonblank string"));
    }
    if request
        .timeout_ms
        .is_some_and(|value| !(50..=60_000).contains(&value))
    {
        return Err(config_error("timeoutMs must be between 50 and 60000"));
    }
    if !matches!(request.function_code, 1 | 2 | 3 | 4 | 5 | 6 | 15 | 16) {
        return Err(config_error("unsupported Modbus function code"));
    }
    if !(1..=247).contains(&request.unit_id) {
        return Err(config_error("unitId must be between 1 and 247"));
    }
    let maximum = if request.function_code <= 2 {
        2000
    } else if request.function_code <= 4 {
        125
    } else if request.function_code == 15 {
        1968
    } else if request.function_code == 16 {
        123
    } else {
        1
    };
    let quantity = if request.function_code <= 4 {
        request.quantity as usize
    } else {
        request.values.len()
    };
    if quantity == 0 || quantity > maximum || request.address as usize + quantity > 65_536 {
        return Err(config_error("invalid Modbus quantity or address range"));
    }
    Ok(())
}

fn request_to_protocol(request: &ModbusExecuteRequest) -> Result<Request<'static>, SerialError> {
    let address = request.address;
    let quantity = request.quantity;
    Ok(match request.function_code {
        1 => Request::ReadCoils(address, quantity),
        2 => Request::ReadDiscreteInputs(address, quantity),
        3 => Request::ReadHoldingRegisters(address, quantity),
        4 => Request::ReadInputRegisters(address, quantity),
        5 => Request::WriteSingleCoil(address, bool_value(request.values.first())?),
        6 => Request::WriteSingleRegister(address, word_value(request.values.first())?),
        15 => Request::WriteMultipleCoils(
            address,
            Cow::Owned(
                request
                    .values
                    .iter()
                    .map(|value| bool_value(Some(value)))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
        16 => Request::WriteMultipleRegisters(
            address,
            Cow::Owned(
                request
                    .values
                    .iter()
                    .map(|value| word_value(Some(value)))
                    .collect::<Result<Vec<_>, _>>()?,
            ),
        ),
        _ => return Err(config_error("unsupported Modbus function code")),
    })
}

fn response_values(response: &Response, request: &ModbusExecuteRequest) -> Vec<Value> {
    match response {
        Response::ReadCoils(values) | Response::ReadDiscreteInputs(values) => values
            .iter()
            .take(request.quantity as usize)
            .copied()
            .map(Value::Bool)
            .collect(),
        Response::ReadHoldingRegisters(values) | Response::ReadInputRegisters(values) => {
            values.iter().copied().map(Value::from).collect()
        }
        _ => request.values.clone(),
    }
}

fn response_json_values(response: &Response) -> Vec<Value> {
    match response {
        Response::ReadCoils(values) | Response::ReadDiscreteInputs(values) => {
            values.iter().copied().map(Value::Bool).collect()
        }
        Response::ReadHoldingRegisters(values) | Response::ReadInputRegisters(values) => {
            values.iter().copied().map(Value::from).collect()
        }
        _ => Vec::new(),
    }
}

fn transaction(
    session: &Session,
    origin: &'static str,
    request: &ModbusExecuteRequest,
    values: Vec<Value>,
    started_at: u64,
    failure: Option<(Option<u8>, String)>,
) -> ModbusTransaction {
    let created_at = now_millis();
    ModbusTransaction {
        endpoint_id: session.endpoint_id.clone(),
        session_id: session.session_id.clone(),
        request_group_id: request.request_group_id.clone(),
        request_id: request.request_id.clone(),
        origin,
        unit_id: request.unit_id,
        function_code: request.function_code,
        address: request.address,
        quantity: if request.function_code <= 4 {
            request.quantity
        } else {
            request.values.len() as u16
        },
        request_values: request.values.clone(),
        values,
        success: failure.is_none(),
        exception_code: failure.as_ref().and_then(|value| value.0),
        message: failure.map(|value| value.1),
        transport: session.transport.clone(),
        request_frame: Vec::new(),
        response_frame: Vec::new(),
        created_at,
        duration_ms: created_at.saturating_sub(started_at),
    }
}

fn rtu_frame(unit_id: u8, pdu: &[u8]) -> Vec<u8> {
    let mut frame = Vec::with_capacity(3 + pdu.len());
    frame.push(unit_id);
    frame.extend_from_slice(pdu);
    let checksum = modbus_crc16(&frame);
    frame.extend_from_slice(&checksum.to_le_bytes());
    frame
}

fn modbus_crc16(bytes: &[u8]) -> u16 {
    bytes.iter().fold(0xffff, |mut checksum, byte| {
        checksum ^= u16::from(*byte);
        for _ in 0..8 {
            checksum = if checksum & 1 == 1 {
                (checksum >> 1) ^ 0xa001
            } else {
                checksum >> 1
            };
        }
        checksum
    })
}

fn read_area<T: Clone>(
    area: &DataArea<T>,
    address: u16,
    quantity: u16,
) -> Result<Vec<T>, ExceptionCode> {
    let offset = address
        .checked_sub(area.start)
        .map(usize::from)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    let end = offset
        .checked_add(quantity as usize)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    area.values
        .get(offset..end)
        .map(<[T]>::to_vec)
        .ok_or(ExceptionCode::IllegalDataAddress)
}

fn write_slice<T: Clone>(
    area: &mut DataArea<T>,
    address: u16,
    values: &[T],
) -> Result<(), ExceptionCode> {
    let offset = address
        .checked_sub(area.start)
        .map(usize::from)
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    let target = area
        .values
        .get_mut(offset..offset + values.len())
        .ok_or(ExceptionCode::IllegalDataAddress)?;
    target.clone_from_slice(values);
    Ok(())
}

fn write_bool_values(
    area: &mut DataArea<bool>,
    address: u16,
    values: &[Value],
) -> Result<(), SerialError> {
    let values = values
        .iter()
        .map(|value| bool_value(Some(value)))
        .collect::<Result<Vec<_>, _>>()?;
    write_slice(area, address, &values)
        .map_err(|_| config_error("address is outside the configured data area"))
}

fn write_word_values(
    area: &mut DataArea<u16>,
    address: u16,
    values: &[Value],
) -> Result<(), SerialError> {
    let values = values
        .iter()
        .map(|value| word_value(Some(value)))
        .collect::<Result<Vec<_>, _>>()?;
    write_slice(area, address, &values)
        .map_err(|_| config_error("address is outside the configured data area"))
}

fn map_snapshot(session: &Session, data: &DataStore) -> Value {
    json!({
        "endpointId": session.endpoint_id,
        "unitId": session.unit_id,
        "areas": {
            "coils": area_json(&data.coils),
            "discreteInputs": area_json(&data.discrete_inputs),
            "holdingRegisters": area_json(&data.holding_registers),
            "inputRegisters": area_json(&data.input_registers),
        }
    })
}

fn area_json<T: Serialize>(area: &DataArea<T>) -> Value {
    json!({ "start": area.start, "count": area.values.len(), "values": area.values })
}

fn bool_value(value: Option<&Value>) -> Result<bool, SerialError> {
    value
        .and_then(|value| {
            value.as_bool().or_else(|| {
                value
                    .as_u64()
                    .filter(|value| *value <= 1)
                    .map(|value| value == 1)
            })
        })
        .ok_or_else(|| config_error("coil values must be boolean, 0, or 1"))
}

fn word_value(value: Option<&Value>) -> Result<u16, SerialError> {
    value
        .and_then(Value::as_u64)
        .filter(|value| *value <= u16::MAX as u64)
        .map(|value| value as u16)
        .ok_or_else(|| config_error("register values must be integers from 0 to 65535"))
}

fn resolve_address(host: &str, port: u16) -> Result<SocketAddr, SerialError> {
    (host, port)
        .to_socket_addrs()
        .map_err(|error| map_io_message(error.to_string()))?
        .next()
        .ok_or_else(|| config_error("host did not resolve to an address"))
}

fn await_ready(receiver: mpsc::Receiver<Result<(), String>>) -> Result<(), SerialError> {
    receiver
        .recv_timeout(Duration::from_secs(5))
        .map_err(|_| config_error("Modbus server startup timed out"))?
        .map_err(map_io_message)
}

fn lock<T>(mutex: &Mutex<T>) -> Result<MutexGuard<'_, T>, SerialError> {
    mutex
        .lock()
        .map_err(|_| config_error("Modbus service mutex poisoned"))
}

fn require_text(value: &str, field: &str) -> Result<(), SerialError> {
    if value.trim().is_empty() {
        Err(config_error(format!("{field} must be nonblank")))
    } else {
        Ok(())
    }
}

fn string_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    fallback: &str,
) -> Result<String, SerialError> {
    let Some(value) = object.get(key) else {
        return Ok(fallback.to_owned());
    };
    value
        .as_str()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .ok_or_else(|| config_error(format!("{key} must be a nonblank string")))
}

fn u64_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    minimum: u64,
    maximum: u64,
    fallback: u64,
) -> Result<u64, SerialError> {
    let value = match object.get(key) {
        None => fallback,
        Some(value) => value
            .as_u64()
            .ok_or_else(|| config_error(format!("{key} must be an integer")))?,
    };
    (minimum..=maximum)
        .contains(&value)
        .then_some(value)
        .ok_or_else(|| config_error(format!("{key} is outside the allowed range")))
}

fn f64_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    fallback: f64,
) -> Result<f64, SerialError> {
    match object.get(key) {
        None => Ok(fallback),
        Some(value) => value
            .as_f64()
            .ok_or_else(|| config_error(format!("{key} must be a number"))),
    }
}

fn u8_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    minimum: u8,
    maximum: u8,
    fallback: u8,
) -> Result<u8, SerialError> {
    Ok(u64_field(object, key, minimum.into(), maximum.into(), fallback.into())? as u8)
}

fn u16_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    fallback: u16,
) -> Result<u16, SerialError> {
    Ok(u64_field(object, key, 1, u16::MAX.into(), fallback.into())? as u16)
}

fn u32_field(
    object: &serde_json::Map<String, Value>,
    key: &str,
    fallback: u32,
) -> Result<u32, SerialError> {
    Ok(u64_field(object, key, 1, u32::MAX.into(), fallback.into())? as u32)
}

fn config_error(message: impl Into<String>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, message)
}

fn map_io_message(message: String) -> SerialError {
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("permission") {
        SerialErrorCode::PermissionDenied
    } else if lower.contains("busy")
        || lower.contains("in use")
        || lower.contains("address already")
    {
        SerialErrorCode::PortBusy
    } else if lower.contains("not found") || lower.contains("no such file") {
        SerialErrorCode::PortNotFound
    } else {
        SerialErrorCode::IoError
    };
    SerialError::new(code, message)
}

fn status_name(status: SerialStatus) -> &'static str {
    match status {
        SerialStatus::Opening => "opening",
        SerialStatus::Open => "open",
        SerialStatus::Listening => "listening",
        SerialStatus::Closing => "closing",
        SerialStatus::Closed => "closed",
        SerialStatus::Error => "error",
    }
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
        .as_millis() as u64
}

#[tauri::command]
pub(crate) async fn modbus_execute(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbus.execute");
    let request = match one_argument::<ModbusExecuteRequest>(args, "modbus.execute request") {
        Ok(value) => value,
        Err(error) => return Ok(runtime::serial_failure("modbus.execute", error)),
    };
    let service = state.modbus_service.clone();
    Ok(
        match runtime::spawn_blocking(move || Ok(service.execute(request))).await {
            Ok(Ok(value)) => runtime::success(serde_json::to_value(value).unwrap_or(Value::Null)),
            Ok(Err(error)) => runtime::serial_failure("modbus.execute", error),
            Err(error) => runtime::serial_failure(
                "modbus.execute",
                SerialError::new(SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn modbus_read_map(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbus.readMap");
    let endpoint_id = match one_argument::<String>(args, "modbus.readMap endpointId") {
        Ok(value) => value,
        Err(error) => return Ok(runtime::serial_failure("modbus.readMap", error)),
    };
    let service = state.modbus_service.clone();
    Ok(
        match runtime::spawn_blocking(move || Ok(service.read_map(&endpoint_id))).await {
            Ok(Ok(value)) => runtime::success(value),
            Ok(Err(error)) => runtime::serial_failure("modbus.readMap", error),
            Err(error) => runtime::serial_failure(
                "modbus.readMap",
                SerialError::new(SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn modbus_write_map(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbus.writeMap");
    let request = match one_argument::<ModbusMapWriteRequest>(args, "modbus.writeMap request") {
        Ok(value) => value,
        Err(error) => return Ok(runtime::serial_failure("modbus.writeMap", error)),
    };
    let service = state.modbus_service.clone();
    Ok(
        match runtime::spawn_blocking(move || Ok(service.write_map(request))).await {
            Ok(Ok(value)) => runtime::success(value),
            Ok(Err(error)) => runtime::serial_failure("modbus.writeMap", error),
            Err(error) => runtime::serial_failure(
                "modbus.writeMap",
                SerialError::new(SerialErrorCode::IoError, error),
            ),
        },
    )
}

fn one_argument<T: for<'de> Deserialize<'de>>(
    args: Option<Vec<Value>>,
    label: &str,
) -> Result<T, SerialError> {
    let mut values = args.ok_or_else(|| config_error(format!("{label} is required")))?;
    if values.len() != 1 {
        return Err(config_error(format!("{label} requires exactly one value")));
    }
    serde_json::from_value(values.pop().unwrap()).map_err(|error| config_error(error.to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs,
        io::{BufRead, BufReader, Write},
        net::TcpListener,
        path::{Path, PathBuf},
        process::{Child, Command, Stdio},
        time::Instant,
    };

    #[derive(Default)]
    struct TransportSink {
        events: Mutex<Vec<SerialEvent>>,
    }

    impl SerialEventSink for TransportSink {
        fn emit(&self, event: SerialEvent) {
            self.events.lock().unwrap().push(event);
        }
    }

    #[derive(Default)]
    struct TransactionSink {
        events: Mutex<Vec<ModbusTransaction>>,
    }

    impl ModbusEventSink for TransactionSink {
        fn emit(&self, transaction: ModbusTransaction) {
            self.events.lock().unwrap().push(transaction);
        }
    }

    #[test]
    fn cancel_open_releases_a_pending_slave_before_acknowledging() {
        let sink = Arc::new(TransportSink::default());
        let service = Arc::new(ModbusService::new(
            sink.clone(),
            Arc::new(TransactionSink::default()),
        ));
        let (entered_tx, entered_rx) = mpsc::channel();
        let release = Arc::new((Mutex::new(false), Condvar::new()));
        *service.before_open_commit.lock().unwrap() = Some({
            let release = release.clone();
            Arc::new(move || {
                entered_tx.send(()).unwrap();
                let mut ready = release.0.lock().unwrap();
                while !*ready {
                    ready = release.1.wait(ready).unwrap();
                }
            })
        });
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let opening = {
            let service = service.clone();
            thread::spawn(move || {
                service.open(
                    ModbusEndpoint {
                        endpoint_id: "pending-slave".into(),
                        transport: "modbus-tcp-slave".into(),
                        config: json!({"listenHost":"127.0.0.1", "listenPort":port}),
                    },
                    "open-1",
                )
            })
        };
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(
            !service
                .cancel_open("pending-slave", "old-open")
                .unwrap()
                .cancelled
        );
        let cancellation = {
            let service = service.clone();
            thread::spawn(move || service.cancel_open("pending-slave", "open-1"))
        };
        let deadline = Instant::now() + Duration::from_secs(2);
        while !lock(&service.lifecycle)
            .unwrap()
            .opening
            .get("pending-slave")
            .unwrap()
            .cancel
            .is_cancelled()
        {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        *release.0.lock().unwrap() = true;
        release.1.notify_all();
        assert_eq!(
            opening.join().unwrap().unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        assert!(cancellation.join().unwrap().unwrap().cancelled);
        assert!(lock(&service.lifecycle).unwrap().sessions.is_empty());
        assert!(lock(&service.lifecycle).unwrap().opening.is_empty());
        assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
        assert!(!sink.events.lock().unwrap().iter().any(|event| matches!(event, SerialEvent::Status(status) if status.status == SerialStatus::Listening)));
    }

    #[test]
    fn cancelled_master_connect_drops_the_pending_future_without_waiting_for_timeout() {
        let runtime = master_runtime().unwrap();
        let cancel = CancellationToken::new();
        runtime.block_on(async {
            let request = connect_master(
                &cancel,
                Duration::from_secs(60),
                std::future::pending::<io::Result<()>>(),
            );
            let cancellation = async {
                tokio::task::yield_now().await;
                cancel.cancel();
            };
            let (result, _) = tokio::join!(request, cancellation);
            assert_eq!(result.unwrap_err().code, SerialErrorCode::OpenCancelled);
        });
    }

    #[test]
    fn cancel_open_cannot_close_a_replacement_modbus_session() {
        let service = ModbusService::new(
            Arc::new(TransportSink::default()),
            Arc::new(TransactionSink::default()),
        );
        let session = test_slave_session("cancel-slave", "session-2");
        lock(&service.lifecycle)
            .unwrap()
            .sessions
            .insert("cancel-slave".into(), session.clone());
        assert!(
            !service
                .cancel_open("cancel-slave", "old-operation")
                .unwrap()
                .cancelled
        );
        assert!(lock(&service.lifecycle)
            .unwrap()
            .sessions
            .contains_key("cancel-slave"));
        assert!(
            service
                .cancel_open("cancel-slave", &session.operation_id)
                .unwrap()
                .cancelled
        );
        assert!(!lock(&service.lifecycle)
            .unwrap()
            .sessions
            .contains_key("cancel-slave"));
    }

    #[test]
    fn slave_runtime_failure_retires_the_matching_session_and_emits_terminal_statuses() {
        let transport_sink = Arc::new(TransportSink::default());
        let service =
            ModbusService::new(transport_sink.clone(), Arc::new(TransactionSink::default()));
        let session = test_slave_session("slave", "session-1");
        lock(&service.lifecycle)
            .unwrap()
            .sessions
            .insert("slave".into(), session.clone());
        let termination =
            SlaveTermination::new(service.lifecycle.clone(), transport_sink.clone(), &session);
        termination.arm();

        termination.fail(SerialError::new(
            SerialErrorCode::DeviceRemoved,
            "serial device removed",
        ));

        assert!(!lock(&service.lifecycle)
            .unwrap()
            .sessions
            .contains_key("slave"));
        let statuses = transport_sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SerialEvent::Status(status) => Some(status.status),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(statuses, vec![SerialStatus::Error, SerialStatus::Closed]);
    }

    #[test]
    fn slave_failure_before_session_commit_is_retired_when_reporting_is_armed() {
        let transport_sink = Arc::new(TransportSink::default());
        let service =
            ModbusService::new(transport_sink.clone(), Arc::new(TransactionSink::default()));
        let session = test_slave_session("slave", "session-1");
        let termination =
            SlaveTermination::new(service.lifecycle.clone(), transport_sink.clone(), &session);
        termination.fail(SerialError::new(SerialErrorCode::IoError, "worker stopped"));
        lock(&service.lifecycle)
            .unwrap()
            .sessions
            .insert("slave".into(), session.clone());

        let error = service
            .publish_open_status(&session, Some(termination.as_ref()))
            .expect_err("startup failure must be returned");

        assert_eq!(error.message, "worker stopped");
        assert!(!lock(&service.lifecycle)
            .unwrap()
            .sessions
            .contains_key("slave"));
        let statuses = transport_sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SerialEvent::Status(status) => Some(status.status),
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(statuses, vec![SerialStatus::Error, SerialStatus::Closed]);
    }

    fn test_slave_session(endpoint_id: &str, session_id: &str) -> Arc<Session> {
        Arc::new(Session {
            endpoint_id: endpoint_id.into(),
            operation_id: "open-slave".into(),
            session_id: session_id.into(),
            transport: "modbus-rtu-slave".into(),
            unit_id: 1,
            kind: SessionKind::Slave {
                data: Arc::new(Mutex::new(DataStore::from_value(&json!({})).unwrap())),
                cancel: CancellationToken::new(),
                worker: Mutex::new(None),
            },
        })
    }

    struct CancellingTransactionSink {
        events: Mutex<Vec<ModbusTransaction>>,
        cancel: CancellationToken,
    }

    impl ModbusEventSink for CancellingTransactionSink {
        fn emit(&self, transaction: ModbusTransaction) {
            self.events.lock().unwrap().push(transaction);
            self.cancel.cancel();
        }
    }

    #[test]
    fn data_store_and_requests_enforce_ranges_and_value_types() {
        let store = DataStore::from_value(&json!({
            "coils": { "start": 10, "count": 2 },
            "holdingRegisters": { "start": 20, "count": 2, "values": [123] }
        }))
        .unwrap();
        assert_eq!(store.coils.values, vec![false, false]);
        assert_eq!(store.holding_registers.values, vec![123, 0]);
        assert!(DataStore::from_value(&json!({
            "coils": { "start": 65535, "count": 2 }
        }))
        .is_err());
        assert!(DataStore::from_value(&json!({
            "holdingRegisters": { "start": 0, "count": 1, "values": ["1"] }
        }))
        .is_err());

        let mut store = store;
        let (_, _, _, _, response) =
            handle_server_request(&mut store, Request::ReadHoldingRegisters(19, 1));
        assert_eq!(response, Err(ExceptionCode::IllegalDataAddress));
    }

    #[test]
    fn rtu_capture_preserves_exact_wire_bytes_instead_of_rebuilding_the_request() {
        let request_frame = rtu_frame(1, &[15, 0, 5, 0, 3, 1, 0xe5]);
        let response_frame = rtu_frame(1, &[15, 0, 5, 0, 3]);
        let mut buffer = Vec::new();

        buffer.extend_from_slice(&request_frame[..4]);
        assert!(take_rtu_request_frame(&mut buffer).is_none());
        buffer.extend_from_slice(&request_frame[4..]);
        let captured_request = take_rtu_request_frame(&mut buffer).unwrap();
        assert_eq!(captured_request, request_frame);

        let parsed = parse_rtu_request(&captured_request).unwrap();
        assert_eq!(parsed.slave, 1);
        assert_eq!(
            parsed.request,
            Request::WriteMultipleCoils(5, Cow::Owned(vec![true, false, true]))
        );

        let mut capture = RtuFrameCapture::default();
        capture.ingest_request(captured_request.clone());
        let request = capture.take_request(1, 15).unwrap();
        assert_eq!(request.frame, captured_request);
        capture.queue_transaction(captured_test_transaction(request.frame));
        let completed = capture.complete_response(response_frame.clone()).unwrap();
        assert_eq!(completed.request_frame, request_frame);
        assert_eq!(completed.response_frame, response_frame);

        assert!(parse_rtu_request(&rtu_frame(1, &[3, 0, 0, 0, 126])).is_err());
        assert!(parse_rtu_request(&rtu_frame(1, &[15, 0, 5, 0, 3, 2, 0xe5, 0])).is_err());

        let valid_request = rtu_frame(1, &[6, 0, 2, 0, 22]);
        let mut malformed_then_valid = vec![1, 16, 0, 0, 0, 124, 255];
        malformed_then_valid.extend_from_slice(&valid_request);
        assert_eq!(
            take_rtu_request_frame(&mut malformed_then_valid),
            Some(valid_request)
        );
    }

    #[tokio::test]
    async fn rtu_server_recovers_after_a_plausible_truncated_request_and_frame_silence() {
        let sink = Arc::new(TransactionSink::default());
        let service = ServerService {
            endpoint_id: "rtu-slave".into(),
            session_id: "session-1".into(),
            unit_id: 1,
            data: Arc::new(Mutex::new(DataStore::from_value(&json!({})).unwrap())),
            sink: sink.clone(),
            transport: "modbus-rtu-slave".into(),
            tcp_capture: None,
            rtu_capture: Some(Arc::new(Mutex::new(RtuFrameCapture::default()))),
        };
        let (mut client, server) = tokio::io::duplex(512);
        let cancel = CancellationToken::new();
        let frame_silence =
            rtu_frame_silence(&Config::from_value(&json!({ "baudRate": 300 })).unwrap());
        let worker = tokio::spawn(serve_rtu_until(
            server,
            service,
            cancel.clone(),
            frame_silence,
        ));
        // A valid FC16 header announces 246 payload bytes, which never arrive.
        client.write_all(&[1, 16, 0, 0, 0, 123, 246]).await.unwrap();
        // More than 3.5 characters even at the 300 baud used by this fixture.
        tokio::time::sleep(Duration::from_millis(150)).await;
        let request = rtu_frame(1, &[6, 0, 2, 0, 22]);
        client.write_all(&request).await.unwrap();
        let mut response = vec![0; request.len()];
        let received =
            tokio::time::timeout(Duration::from_millis(250), client.read_exact(&mut response))
                .await;
        cancel.cancel();
        worker.await.unwrap().unwrap();
        assert!(
            received.is_ok(),
            "The next complete request must survive a truncated predecessor"
        );
        assert_eq!(response, request);
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }

    #[tokio::test]
    async fn rtu_server_keeps_legal_fragments_and_does_not_scan_crc_frames_inside_payloads() {
        let sink = Arc::new(TransactionSink::default());
        let data = Arc::new(Mutex::new(DataStore::from_value(&json!({})).unwrap()));
        let service = ServerService {
            endpoint_id: "rtu-slave".into(),
            session_id: "session-1".into(),
            unit_id: 1,
            data: data.clone(),
            sink: sink.clone(),
            transport: "modbus-rtu-slave".into(),
            tcp_capture: None,
            rtu_capture: Some(Arc::new(Mutex::new(RtuFrameCapture::default()))),
        };
        let (mut client, server) = tokio::io::duplex(512);
        let cancel = CancellationToken::new();
        let frame_silence =
            rtu_frame_silence(&Config::from_value(&json!({ "baudRate": 300 })).unwrap());
        let worker = tokio::spawn(serve_rtu_until(
            server,
            service,
            cancel.clone(),
            frame_silence,
        ));
        let embedded = rtu_frame(1, &[6, 0, 10, 0, 22]);
        let mut pdu = vec![16, 0, 0, 0, 4, 8];
        pdu.extend_from_slice(&embedded);
        let request = rtu_frame(1, &pdu);
        client.write_all(&request[..15]).await.unwrap();
        // At 300 baud, 20ms is below the 1.5-character intraframe limit.
        tokio::time::sleep(Duration::from_millis(20)).await;
        client.write_all(&request[15..]).await.unwrap();
        let expected = rtu_frame(1, &[16, 0, 0, 0, 4]);
        let mut response = vec![0; expected.len()];
        let received =
            tokio::time::timeout(Duration::from_millis(250), client.read_exact(&mut response))
                .await;
        cancel.cancel();
        worker.await.unwrap().unwrap();
        assert!(received.is_ok());
        assert_eq!(response, expected);
        assert_eq!(data.lock().unwrap().holding_registers.values[10], 0);
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].function_code, 16);
    }

    #[tokio::test]
    async fn rtu_server_publishes_exact_frames_only_after_the_response_is_written() {
        let sink = Arc::new(TransactionSink::default());
        let capture = Arc::new(Mutex::new(RtuFrameCapture::default()));
        let service = ServerService {
            endpoint_id: "rtu-slave".into(),
            session_id: "session-1".into(),
            unit_id: 1,
            data: Arc::new(Mutex::new(
                DataStore::from_value(&json!({
                    "coils": { "start": 0, "count": 16 }
                }))
                .unwrap(),
            )),
            sink: sink.clone(),
            transport: "modbus-rtu-slave".into(),
            tcp_capture: None,
            rtu_capture: Some(capture),
        };
        let (mut client, server) = tokio::io::duplex(256);
        let cancel = CancellationToken::new();
        let frame_silence = rtu_frame_silence(&Config::from_value(&json!({})).unwrap());
        let worker = tokio::spawn(serve_rtu_until(
            server,
            service,
            cancel.clone(),
            frame_silence,
        ));
        let request_frame = rtu_frame(1, &[15, 0, 5, 0, 3, 1, 0xe5]);
        let expected_response = rtu_frame(1, &[15, 0, 5, 0, 3]);

        client.write_all(&request_frame).await.unwrap();
        let mut response_frame = vec![0; expected_response.len()];
        client.read_exact(&mut response_frame).await.unwrap();
        assert_eq!(response_frame, expected_response);

        cancel.cancel();
        worker.await.unwrap().unwrap();
        let events = sink.events.lock().unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].request_frame, request_frame);
        assert_eq!(events[0].response_frame, expected_response);
    }

    #[tokio::test]
    async fn rtu_server_stops_before_processing_another_buffered_frame_after_cancel() {
        let cancel = CancellationToken::new();
        let sink = Arc::new(CancellingTransactionSink {
            events: Mutex::new(Vec::new()),
            cancel: cancel.clone(),
        });
        let capture = Arc::new(Mutex::new(RtuFrameCapture::default()));
        let service = ServerService {
            endpoint_id: "rtu-slave".into(),
            session_id: "session-1".into(),
            unit_id: 1,
            data: Arc::new(Mutex::new(
                DataStore::from_value(&json!({
                    "coils": { "start": 0, "count": 2 }
                }))
                .unwrap(),
            )),
            sink: sink.clone(),
            transport: "modbus-rtu-slave".into(),
            tcp_capture: None,
            rtu_capture: Some(capture),
        };
        let (mut client, server) = tokio::io::duplex(256);
        let frame_silence = rtu_frame_silence(&Config::from_value(&json!({})).unwrap());
        let worker = tokio::spawn(serve_rtu_until(server, service, cancel, frame_silence));
        let first = rtu_frame(1, &[5, 0, 0, 0xff, 0]);
        let second = rtu_frame(1, &[5, 0, 1, 0xff, 0]);

        client
            .write_all(&[first.clone(), second].concat())
            .await
            .unwrap();
        let mut response = vec![0; first.len()];
        client.read_exact(&mut response).await.unwrap();
        assert_eq!(response, first);
        worker.await.unwrap().unwrap();
        assert_eq!(sink.events.lock().unwrap().len(), 1);
    }

    #[test]
    fn tcp_capture_pairs_fragmented_and_coalesced_wire_frames_after_response_write() {
        let request_one = vec![0, 1, 0, 0, 0, 6, 1, 6, 0, 2, 0, 22];
        let request_two = vec![0, 2, 0, 0, 0, 6, 1, 6, 0, 2, 0, 23];
        let response_one = request_one.clone();
        let response_two = request_two.clone();
        let mut capture = TcpFrameCapture::default();

        capture.ingest_received(&request_one[..5]);
        assert!(capture.take_request(1, 6).is_none());
        capture.ingest_received(&[request_one[5..].to_vec(), request_two.clone()].concat());
        let first = capture.take_request(1, 6).unwrap();
        let second = capture.take_request(1, 6).unwrap();
        assert_eq!(first.frame, request_one);
        assert_eq!(second.frame, request_two);

        capture.queue_transaction(first.transaction_id, captured_test_transaction(first.frame));
        capture.queue_transaction(
            second.transaction_id,
            captured_test_transaction(second.frame),
        );
        assert!(capture.ingest_sent(&response_one[..4]).is_empty());
        let emitted =
            capture.ingest_sent(&[response_one[4..].to_vec(), response_two.clone()].concat());

        assert_eq!(emitted.len(), 2);
        assert_eq!(emitted[0].response_frame, response_one);
        assert_eq!(emitted[1].response_frame, response_two);
    }

    fn captured_test_transaction(request_frame: Vec<u8>) -> ModbusTransaction {
        ModbusTransaction {
            endpoint_id: "slave".into(),
            session_id: "session".into(),
            request_group_id: None,
            request_id: None,
            origin: "slave",
            unit_id: 1,
            function_code: 6,
            address: 2,
            quantity: 1,
            request_values: vec![json!(22)],
            values: vec![json!(22)],
            success: true,
            exception_code: None,
            message: None,
            transport: "modbus-tcp-slave".into(),
            request_frame,
            response_frame: Vec::new(),
            created_at: 1,
            duration_ms: 0,
        }
    }

    #[test]
    fn config_rejects_explicit_invalid_values_instead_of_using_defaults() {
        assert!(Config::from_value(&json!({ "unitId": "1" })).is_err());
        assert!(Config::from_value(&json!({ "host": "" })).is_err());
        assert!(Config::from_value(&json!({ "dataAreas": [] })).is_err());
        assert_eq!(Config::from_value(&json!({})).unwrap().unit_id, 1);
    }

    #[test]
    fn execute_request_validates_timeout_and_correlates_transactions_to_groups_and_requests() {
        let request: ModbusExecuteRequest = serde_json::from_value(json!({
            "endpointId": "master",
            "requestGroupId": "boiler",
            "requestId": "holding-fast",
            "timeoutMs": 250,
            "functionCode": 3,
            "unitId": 1,
            "address": 0,
            "quantity": 1,
            "values": []
        }))
        .unwrap();
        validate_execute(&request).unwrap();
        assert_eq!(request.timeout_ms, Some(250));
        assert_eq!(request.request_group_id.as_deref(), Some("boiler"));
        assert_eq!(request.request_id.as_deref(), Some("holding-fast"));

        let correlated = ModbusTransaction {
            endpoint_id: "master".into(),
            session_id: "session-master".into(),
            request_group_id: request.request_group_id.clone(),
            request_id: request.request_id.clone(),
            origin: "master",
            unit_id: 1,
            function_code: 3,
            address: 0,
            quantity: 1,
            request_values: vec![],
            values: vec![json!(321)],
            success: true,
            exception_code: None,
            message: None,
            transport: "modbus-tcp-master".into(),
            request_frame: Vec::new(),
            response_frame: Vec::new(),
            created_at: 1,
            duration_ms: 0,
        };
        let correlated_json = serde_json::to_value(correlated).unwrap();
        assert_eq!(correlated_json["requestGroupId"], "boiler");
        assert_eq!(correlated_json["requestId"], "holding-fast");

        for invalid in [json!(49), json!(60_001)] {
            let invalid_request: ModbusExecuteRequest = serde_json::from_value(json!({
                "endpointId": "master",
                "requestGroupId": "boiler",
                "requestId": "holding-fast",
                "timeoutMs": invalid,
                "functionCode": 3,
                "unitId": 1,
                "address": 0,
                "quantity": 1,
                "values": []
            }))
            .unwrap();
            assert!(validate_execute(&invalid_request).is_err());
        }

        let blank_request_id: ModbusExecuteRequest = serde_json::from_value(json!({
            "endpointId": "master",
            "requestGroupId": "boiler",
            "requestId": "  ",
            "functionCode": 3,
            "unitId": 1,
            "address": 0,
            "quantity": 1,
            "values": []
        }))
        .unwrap();
        assert!(validate_execute(&blank_request_id).is_err());
    }

    #[test]
    fn expected_session_rejects_a_stale_write_before_using_the_current_connection() {
        let sink = Arc::new(TransportSink::default());
        let service = ModbusService::new(sink, Arc::new(TransactionSink::default()));
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let opened = service
            .open(
                endpoint(
                    "master",
                    "modbus-tcp-master",
                    json!({ "host": "127.0.0.1", "port": port, "timeoutMs": 1000 }),
                ),
                "open",
            )
            .unwrap();
        let request: ModbusExecuteRequest = serde_json::from_value(json!({
            "endpointId": "master", "expectedSessionId": "old-session",
            "functionCode": 6, "unitId": 1, "address": 0, "quantity": 1, "values": [42]
        }))
        .unwrap();
        let error = service.execute(request).unwrap_err();
        service.close("master").unwrap();
        assert_ne!(opened.session_id, "old-session");
        assert_eq!(error.code, SerialErrorCode::OpenCancelled);
    }

    #[test]
    fn slave_map_rejects_a_stale_session_after_reopen() {
        let service = ModbusService::new(
            Arc::new(TransportSink::default()),
            Arc::new(TransactionSink::default()),
        );
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let config = json!({"listenHost":"127.0.0.1", "listenPort":port,
            "dataAreas":{"holdingRegisters":{"start":0,"count":2,"values":[12,34]}}});
        let first = service
            .open(
                endpoint("slave", "modbus-tcp-slave", config.clone()),
                "first",
            )
            .unwrap();
        service.close("slave").unwrap();
        let second = service
            .open(endpoint("slave", "modbus-tcp-slave", config), "second")
            .unwrap();
        assert_ne!(first.session_id, second.session_id);
        let request = |session_id: &str| {
            serde_json::from_value::<ModbusMapWriteRequest>(json!({
            "endpointId":"slave", "expectedSessionId":session_id,
            "area":"holdingRegisters", "address":0, "values":[56]}))
            .unwrap()
        };
        assert!(service.write_map(request(&first.session_id)).is_err());
        assert_eq!(
            service.read_map("slave").unwrap()["areas"]["holdingRegisters"]["values"],
            json!([12, 34])
        );
        service.write_map(request(&second.session_id)).unwrap();
        assert_eq!(
            service.read_map("slave").unwrap()["areas"]["holdingRegisters"]["values"],
            json!([56, 34])
        );
        service.close("slave").unwrap();
    }

    #[test]
    fn real_tcp_master_and_slave_execute_saved_fc05_and_fc16_request_shapes() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        drop(listener);
        let transport_sink = Arc::new(TransportSink::default());
        let transaction_sink = Arc::new(TransactionSink::default());
        let service = ModbusService::new(transport_sink.clone(), transaction_sink.clone());

        service
            .open(
                endpoint(
                    "slave",
                    "modbus-tcp-slave",
                    json!({
                        "listenHost": "127.0.0.1",
                        "listenPort": port,
                        "unitId": 1,
                        "dataAreas": {
                            "coils": { "start": 0, "count": 10 },
                            "holdingRegisters": { "start": 0, "count": 10 }
                        }
                    }),
                ),
                "open-slave",
            )
            .unwrap();
        service
            .open(
                endpoint(
                    "master",
                    "modbus-tcp-master",
                    json!({
                        "host": "127.0.0.1",
                        "port": port,
                        "unitId": 1,
                        "timeoutMs": 1000
                    }),
                ),
                "open-master",
            )
            .unwrap();

        let coil_written = service
            .execute(request("master", 5, 5, 1, vec![json!(true)]))
            .unwrap();
        let registers_written = service
            .execute(request("master", 16, 2, 2, vec![json!(123), json!(456)]))
            .unwrap();
        let coil_read = service
            .execute(request("master", 1, 5, 1, Vec::new()))
            .unwrap();
        let mut read_request = request("master", 3, 2, 2, Vec::new());
        read_request.request_group_id = Some("holding-fast".into());
        read_request.timeout_ms = Some(250);
        let read = service.execute(read_request).unwrap();
        let protocol_error = service
            .execute(request("master", 3, 20, 1, Vec::new()))
            .unwrap_err();
        let map = service.read_map("slave").unwrap();

        assert_eq!(protocol_error.code, SerialErrorCode::ModbusException);
        assert!(service.session("master").is_ok());

        let coil_contract = write_transaction_contract(&coil_written);
        assert_eq!(
            coil_contract,
            json!({
                "requestGroupId": null,
                "requestId": null,
                "origin": "master",
                "unitId": 1,
                "functionCode": 5,
                "address": 5,
                "quantity": 1,
                "requestValues": [true],
                "values": [true],
                "success": true,
                "exceptionCode": null,
                "message": null
            })
        );
        assert_eq!(
            write_transaction_contract(&registers_written),
            json!({
                "requestGroupId": null,
                "requestId": null,
                "origin": "master",
                "unitId": 1,
                "functionCode": 16,
                "address": 2,
                "quantity": 2,
                "requestValues": [123, 456],
                "values": [123, 456],
                "success": true,
                "exceptionCode": null,
                "message": null
            })
        );
        assert_eq!(coil_read.values, vec![json!(true)]);
        assert_eq!(read.values, vec![json!(123), json!(456)]);
        assert_eq!(read.request_group_id.as_deref(), Some("holding-fast"));
        let master = service.session("master").unwrap();
        let SessionKind::Master(client) = &master.kind else {
            panic!("expected master session");
        };
        assert_eq!(
            client.lock().unwrap().timeout(),
            Some(Duration::from_millis(1000))
        );
        assert_eq!(
            map["areas"]["holdingRegisters"]["values"]
                .as_array()
                .unwrap()[2..4],
            [json!(123), json!(456)]
        );
        let captured_write = transaction_sink
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|event| event.origin == "slave" && event.function_code == 16)
            .cloned()
            .unwrap();
        let captured_write = serde_json::to_value(captured_write).unwrap();
        assert_eq!(captured_write["transport"], "modbus-tcp-slave");
        assert_eq!(
            captured_write["requestFrame"].as_array().unwrap()[2..],
            [
                json!(0),
                json!(0),
                json!(0),
                json!(11),
                json!(1),
                json!(16),
                json!(0),
                json!(2),
                json!(0),
                json!(2),
                json!(4),
                json!(0),
                json!(123),
                json!(1),
                json!(200)
            ]
        );
        assert_eq!(
            captured_write["responseFrame"].as_array().unwrap()[..2],
            captured_write["requestFrame"].as_array().unwrap()[..2]
        );
        assert_eq!(
            captured_write["responseFrame"].as_array().unwrap()[2..],
            [
                json!(0),
                json!(0),
                json!(0),
                json!(6),
                json!(1),
                json!(16),
                json!(0),
                json!(2),
                json!(0),
                json!(2)
            ]
        );
        assert!(transport_sink
            .events
            .lock()
            .unwrap()
            .iter()
            .any(|event| matches!(event, SerialEvent::Status(status) if status.status == SerialStatus::Listening)));

        let failure = service
            .execute(request("master", 16, 9, 2, vec![json!(300), json!(400)]))
            .unwrap_err();
        assert_eq!(failure.message, "Modbus exception 0x02");
        assert!(service.session("master").is_ok());
        let failed_transaction = transaction_sink
            .events
            .lock()
            .unwrap()
            .iter()
            .find(|event| {
                event.origin == "master"
                    && event.function_code == 16
                    && event.address == 9
                    && !event.success
            })
            .cloned()
            .unwrap();
        assert_eq!(
            write_transaction_contract(&failed_transaction),
            json!({
                "requestGroupId": null,
                "requestId": null,
                "origin": "master",
                "unitId": 1,
                "functionCode": 16,
                "address": 9,
                "quantity": 2,
                "requestValues": [300, 400],
                "values": [],
                "success": false,
                "exceptionCode": 2,
                "message": "Modbus exception 0x02"
            })
        );
        assert_eq!(
            serde_json::to_value(runtime::serial_failure("modbus.execute", failure)).unwrap(),
            json!({
                "ok": false,
                "error": {
                    "name": "SerialError",
                    "method": "modbus.execute",
                    "runtimeName": "tauri",
                    "code": "MODBUS_EXCEPTION",
                    "message": "Modbus exception 0x02"
                }
            })
        );

        service.close("slave").unwrap();
        let mut disconnected = request("master", 3, 2, 1, Vec::new());
        disconnected.timeout_ms = Some(100);
        assert!(service.execute(disconnected).is_err());
        assert!(service.session("master").is_err());
        let master_terminal = transport_sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| match event {
                SerialEvent::Status(status) if status.endpoint_id == "master" => {
                    Some(status.status)
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert!(master_terminal.ends_with(&[SerialStatus::Error, SerialStatus::Closed]));

        service.shutdown().unwrap();
    }

    #[test]
    #[ignore = "requires Node.js, modbus-serial, and socat; run explicitly for cross-runtime verification"]
    fn electron_and_rust_cross_runtime_tcp_and_rtu() {
        cross_runtime_tcp();
        let ptys = PtyPair::new();
        cross_runtime_rtu(&ptys);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_numeric_ptys_skip_unsupported_baud_ioctl() {
        let mut config = Config::from_value(&serial_config(Path::new("/dev/ttys019"))).unwrap();
        assert_eq!(effective_modbus_baud_rate(&config), 0);
        for physical_or_symlink in [
            "/tmp/ttys019",
            "/dev/tty.usbserial-DEV",
            "/dev/ttyUSB0",
            "/dev/ttys019-extra",
        ] {
            config.path = physical_or_symlink.into();
            assert_eq!(
                effective_modbus_baud_rate(&config),
                9600,
                "{physical_or_symlink}"
            );
        }
    }

    fn cross_runtime_tcp() {
        let first_port = reserve_tcp_port();
        let rust_slave = service();
        rust_slave
            .open(
                endpoint(
                    "rust-slave",
                    "modbus-tcp-slave",
                    slave_config(json!({
                        "listenHost": "127.0.0.1",
                        "listenPort": first_port
                    })),
                ),
                "rust-slave-open",
            )
            .unwrap();
        run_electron_master("tcp", &first_port.to_string());
        assert_map_values(&rust_slave, "rust-slave", [321, 654]);
        rust_slave.shutdown().unwrap();

        let second_port = reserve_tcp_port();
        let (mut electron_slave, mut output) =
            start_electron_slave("tcp", &second_port.to_string());
        let rust_master = service();
        rust_master
            .open(
                endpoint(
                    "rust-master",
                    "modbus-tcp-master",
                    json!({
                        "host": "127.0.0.1",
                        "port": second_port,
                        "unitId": 1,
                        "timeoutMs": 2000
                    }),
                ),
                "rust-master-open",
            )
            .unwrap();
        assert_master_exchange(&rust_master);
        rust_master.shutdown().unwrap();
        finish_electron_slave(&mut electron_slave, &mut output);
    }

    fn cross_runtime_rtu(ptys: &PtyPair) {
        let rust_slave = service();
        rust_slave
            .open(
                endpoint(
                    "rust-slave",
                    "modbus-rtu-slave",
                    slave_config(serial_config(&ptys.first)),
                ),
                "rust-slave-open",
            )
            .unwrap();
        run_electron_master("rtu", ptys.second.to_str().unwrap());
        assert_map_values(&rust_slave, "rust-slave", [321, 654]);
        rust_slave.shutdown().unwrap();

        let (mut electron_slave, mut output) =
            start_electron_slave("rtu", ptys.first.to_str().unwrap());
        let rust_master = service();
        rust_master
            .open(
                endpoint(
                    "rust-master",
                    "modbus-rtu-master",
                    serial_config(&ptys.second),
                ),
                "rust-master-open",
            )
            .unwrap();
        assert_master_exchange(&rust_master);
        rust_master.shutdown().unwrap();
        finish_electron_slave(&mut electron_slave, &mut output);
    }

    fn service() -> ModbusService {
        ModbusService::new(
            Arc::new(TransportSink::default()),
            Arc::new(TransactionSink::default()),
        )
    }

    fn assert_master_exchange(service: &ModbusService) {
        service
            .execute(request(
                "rust-master",
                16,
                2,
                2,
                vec![json!(321), json!(654)],
            ))
            .unwrap();
        let read = service
            .execute(request("rust-master", 3, 2, 2, Vec::new()))
            .unwrap();
        assert_eq!(read.values, vec![json!(321), json!(654)]);
    }

    fn assert_map_values(service: &ModbusService, endpoint_id: &str, expected: [u16; 2]) {
        let map = service.read_map(endpoint_id).unwrap();
        assert_eq!(
            map["areas"]["holdingRegisters"]["values"]
                .as_array()
                .unwrap()[2..4],
            [json!(expected[0]), json!(expected[1])]
        );
    }

    fn slave_config(connection: Value) -> Value {
        let mut config = connection.as_object().unwrap().clone();
        config.insert("unitId".into(), json!(1));
        config.insert(
            "dataAreas".into(),
            json!({ "holdingRegisters": { "start": 0, "count": 10 } }),
        );
        Value::Object(config)
    }

    fn serial_config(path: &Path) -> Value {
        json!({
            "path": path,
            "baudRate": 9600,
            "dataBits": 8,
            "parity": "none",
            "stopBits": 1,
            "flowControl": "none",
            "unitId": 1,
            "timeoutMs": 2000
        })
    }

    fn reserve_tcp_port() -> u16 {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        listener.local_addr().unwrap().port()
    }

    fn run_electron_master(transport: &str, target: &str) {
        let output = Command::new("node")
            .arg(electron_peer())
            .args(["master", transport, target])
            .output()
            .expect("run Electron Modbus master peer");
        assert!(
            output.status.success(),
            "Electron master failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
        assert!(String::from_utf8_lossy(&output.stdout)
            .contains("RESULT {\"written\":true,\"values\":[321,654]}"));
    }

    fn start_electron_slave(
        transport: &str,
        target: &str,
    ) -> (Child, BufReader<std::process::ChildStdout>) {
        let mut child = Command::new("node")
            .arg(electron_peer())
            .args(["slave", transport, target])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("start Electron Modbus slave peer");
        let mut output = BufReader::new(child.stdout.take().unwrap());
        let mut ready = String::new();
        output.read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "READY");
        (child, output)
    }

    fn finish_electron_slave(child: &mut Child, output: &mut BufReader<std::process::ChildStdout>) {
        child.stdin.as_mut().unwrap().write_all(b"\n").unwrap();
        let mut result = String::new();
        output.read_line(&mut result).unwrap();
        assert!(result.contains("RESULT {\"values\":[321,654]}"), "{result}");
        assert!(child.wait().unwrap().success());
    }

    fn electron_peer() -> PathBuf {
        Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../tooling/modbus-test/electron-peer.cjs")
    }

    struct PtyPair {
        directory: PathBuf,
        first: PathBuf,
        second: PathBuf,
        socat: Child,
    }

    impl PtyPair {
        fn new() -> Self {
            let directory = std::env::temp_dir().join(format!(
                "ineed-modbus-cross-{}-{}",
                std::process::id(),
                now_millis()
            ));
            fs::create_dir_all(&directory).unwrap();
            let first = directory.join("first.pty");
            let second = directory.join("second.pty");
            let socat = Command::new("socat")
                .args(["-d", "-d"])
                .arg(format!("pty,raw,echo=0,link={}", first.display()))
                .arg(format!("pty,raw,echo=0,link={}", second.display()))
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()
                .expect("start socat PTY pair");
            let deadline = Instant::now() + Duration::from_secs(5);
            while (!first.exists() || !second.exists()) && Instant::now() < deadline {
                thread::sleep(Duration::from_millis(10));
            }
            assert!(
                first.exists() && second.exists(),
                "socat PTYs were not created"
            );
            let first = fs::canonicalize(first).expect("resolve first socat PTY");
            let second = fs::canonicalize(second).expect("resolve second socat PTY");
            Self {
                directory,
                first,
                second,
                socat,
            }
        }
    }

    impl Drop for PtyPair {
        fn drop(&mut self) {
            let _ = self.socat.kill();
            let _ = self.socat.wait();
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn endpoint(id: &str, transport: &str, config: Value) -> ModbusEndpoint {
        ModbusEndpoint {
            endpoint_id: id.into(),
            transport: transport.into(),
            config,
        }
    }

    fn request(
        endpoint_id: &str,
        function_code: u8,
        address: u16,
        quantity: u16,
        values: Vec<Value>,
    ) -> ModbusExecuteRequest {
        ModbusExecuteRequest {
            endpoint_id: endpoint_id.into(),
            expected_session_id: None,
            request_group_id: None,
            request_id: None,
            timeout_ms: None,
            function_code,
            unit_id: 1,
            address,
            quantity,
            values,
        }
    }

    fn write_transaction_contract(transaction: &ModbusTransaction) -> Value {
        json!({
            "requestGroupId": transaction.request_group_id,
            "requestId": transaction.request_id,
            "origin": transaction.origin,
            "unitId": transaction.unit_id,
            "functionCode": transaction.function_code,
            "address": transaction.address,
            "quantity": transaction.quantity,
            "requestValues": transaction.request_values,
            "values": transaction.values,
            "success": transaction.success,
            "exceptionCode": transaction.exception_code,
            "message": transaction.message
        })
    }
}
