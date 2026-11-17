mod config;
mod framing;
pub(crate) use config::{DataBits, FlowControl, Parity, ReceiveFraming, SerialConfig, StopBits};
use framing::{FrameBatcher, Framer};

use std::{
    collections::HashMap,
    io::{self, Read, Write},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Condvar, Mutex, MutexGuard,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(target_os = "macos")]
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde_json::Value;

const READ_TIMEOUT: Duration = Duration::from_millis(50);
const FORCE_OWNER_GRACE: Duration = Duration::from_millis(50);
const FORCE_OWNER_POLL: Duration = Duration::from_millis(2);
const FRAME_BATCH_MILLIS: u64 = 200;
const FRAME_BATCH_LIMIT: usize = 200;
pub(crate) const MAX_PENDING_FRAME_BYTES: usize = 1024 * 1024;

pub(crate) type SerialResult<T> = Result<T, SerialError>;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub(crate) enum SerialErrorCode {
    PortNotFound,
    PortBusy,
    PermissionDenied,
    OpenCancelled,
    DeviceRemoved,
    ModbusException,
    IoError,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub(crate) struct SerialError {
    pub(crate) code: SerialErrorCode,
    pub(crate) message: String,
}

impl SerialError {
    pub(crate) fn new(code: SerialErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl std::fmt::Display for SerialError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(formatter, "{}", self.message)
    }
}

impl std::error::Error for SerialError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SerialPortRecord {
    pub(crate) path: String,
    pub(crate) manufacturer: Option<String>,
    pub(crate) serial_number: Option<String>,
    pub(crate) vendor_id: Option<String>,
    pub(crate) product_id: Option<String>,
}

fn config_error(message: impl Into<String>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, message)
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SerialEndpoint {
    pub(crate) endpoint_id: String,
    pub(crate) config: SerialConfig,
}

pub(crate) trait SerialConnection: Send + Sync + 'static {
    fn read(&self, bytes: &mut [u8]) -> io::Result<usize>;
    fn write_all(&self, bytes: &[u8]) -> io::Result<()>;
    fn close(&self) -> io::Result<()>;
    fn force_close(&self) -> bool;
}

pub(crate) trait SerialBackend: Send + Sync + 'static {
    fn scan(&self) -> SerialResult<Vec<SerialPortRecord>>;
    fn open(&self, config: &SerialConfig) -> SerialResult<Arc<dyn SerialConnection>>;
}

pub(crate) struct RealSerialBackend;

impl SerialBackend for RealSerialBackend {
    fn scan(&self) -> SerialResult<Vec<SerialPortRecord>> {
        serialport::available_ports()
            .map_err(map_serialport_error)
            .map(|ports| {
                ports
                    .into_iter()
                    .map(|port| {
                        let (manufacturer, serial_number, vendor_id, product_id) =
                            match port.port_type {
                                serialport::SerialPortType::UsbPort(info) => (
                                    clean_optional(info.manufacturer),
                                    clean_optional(info.serial_number),
                                    Some(format!("{:04x}", info.vid)),
                                    Some(format!("{:04x}", info.pid)),
                                ),
                                _ => (None, None, None, None),
                            };
                        SerialPortRecord {
                            path: port.port_name,
                            manufacturer,
                            serial_number,
                            vendor_id,
                            product_id,
                        }
                    })
                    .collect()
            })
    }

    fn open(&self, config: &SerialConfig) -> SerialResult<Arc<dyn SerialConnection>> {
        let port = serialport::new(&config.path, effective_baud_rate(config))
            .data_bits(match config.data_bits {
                DataBits::Five => serialport::DataBits::Five,
                DataBits::Six => serialport::DataBits::Six,
                DataBits::Seven => serialport::DataBits::Seven,
                DataBits::Eight => serialport::DataBits::Eight,
            })
            .parity(match config.parity {
                Parity::None => serialport::Parity::None,
                Parity::Odd => serialport::Parity::Odd,
                Parity::Even => serialport::Parity::Even,
            })
            .stop_bits(match config.stop_bits {
                StopBits::One => serialport::StopBits::One,
                StopBits::Two => serialport::StopBits::Two,
            })
            .flow_control(match config.flow_control {
                FlowControl::None => serialport::FlowControl::None,
                FlowControl::Software => serialport::FlowControl::Software,
                FlowControl::Hardware => serialport::FlowControl::Hardware,
            })
            .timeout(READ_TIMEOUT)
            .open()
            .map_err(map_serialport_error)?;
        // Give the reader its own native handle. Holding a shared port mutex
        // during every timed read can repeatedly overtake a waiting writer.
        let read_port = port.try_clone().map_err(map_serialport_error)?;
        Ok(Arc::new(NativeSerialConnection {
            read_port: Mutex::new(Some(read_port)),
            port: Mutex::new(Some(port)),
            write_owner: Mutex::new(()),
        }))
    }
}

#[cfg(target_os = "macos")]
fn effective_baud_rate(config: &SerialConfig) -> u32 {
    let configured_path = Path::new(&config.path);
    let device_path = resolve_device_path(configured_path);
    let device_path = device_path.to_string_lossy();
    if device_path.strip_prefix("/dev/ttys").is_some_and(|suffix| {
        !suffix.is_empty() && suffix.bytes().all(|byte| byte.is_ascii_digit())
    }) {
        0
    } else {
        config.baud_rate
    }
}

#[cfg(target_os = "macos")]
fn resolve_device_path(path: &Path) -> PathBuf {
    std::fs::canonicalize(path)
        .or_else(|_| {
            std::fs::read_link(path).map(|target| {
                if target.is_absolute() {
                    target
                } else {
                    path.parent().unwrap_or_else(|| Path::new("")).join(target)
                }
            })
        })
        .unwrap_or_else(|_| path.to_owned())
}

#[cfg(not(target_os = "macos"))]
fn effective_baud_rate(config: &SerialConfig) -> u32 {
    config.baud_rate
}

struct NativeSerialConnection {
    read_port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    port: Mutex<Option<Box<dyn serialport::SerialPort>>>,
    write_owner: Mutex<()>,
}

impl SerialConnection for NativeSerialConnection {
    fn read(&self, bytes: &mut [u8]) -> io::Result<usize> {
        let mut port = lock(&self.read_port)?;
        let port = port
            .as_mut()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotConnected))?;
        Read::read(port, bytes)
    }

    fn write_all(&self, bytes: &[u8]) -> io::Result<()> {
        let _owner = lock(&self.write_owner)?;
        let mut port = lock(&self.port)?;
        let port = port
            .as_mut()
            .ok_or_else(|| io::Error::from(io::ErrorKind::NotConnected))?;
        Write::write_all(port, bytes)?;
        Write::flush(port)
    }

    fn close(&self) -> io::Result<()> {
        let _owner = lock(&self.write_owner)?;
        let mut port = lock(&self.port)?;
        let mut read_port = lock(&self.read_port)?;
        drop(read_port.take());
        drop(port.take());
        Ok(())
    }

    fn force_close(&self) -> bool {
        // Acquire both handles before dropping either one; a retry must not see
        // a partly closed native connection.
        match (self.port.try_lock(), self.read_port.try_lock()) {
            (Ok(mut port), Ok(mut read_port)) => {
                drop(read_port.take());
                drop(port.take());
                true
            }
            _ => {
                eprintln!("serial force close could not acquire both native handles");
                false
            }
        }
    }
}

fn lock<T>(mutex: &Mutex<T>) -> io::Result<MutexGuard<'_, T>> {
    mutex
        .lock()
        .map_err(|_| io::Error::other("serial mutex poisoned"))
}

fn clean_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let value = value.trim().to_owned();
        (!value.is_empty()).then_some(value)
    })
}

fn map_serialport_error(error: serialport::Error) -> SerialError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("busy") || lower.contains("in use") {
        SerialErrorCode::PortBusy
    } else {
        match error.kind() {
            serialport::ErrorKind::NoDevice => SerialErrorCode::PortNotFound,
            serialport::ErrorKind::Io(io::ErrorKind::PermissionDenied) => {
                SerialErrorCode::PermissionDenied
            }
            _ => SerialErrorCode::IoError,
        }
    };
    SerialError::new(code, message)
}

fn map_io_error(error: io::Error, opening: bool) -> SerialError {
    let message = error.to_string();
    let lower = message.to_ascii_lowercase();
    let code = if lower.contains("busy") || lower.contains("in use") {
        SerialErrorCode::PortBusy
    } else if !opening && is_device_removed_io(&error) {
        SerialErrorCode::DeviceRemoved
    } else {
        match error.kind() {
            io::ErrorKind::NotFound if opening => SerialErrorCode::PortNotFound,
            io::ErrorKind::PermissionDenied => SerialErrorCode::PermissionDenied,
            _ => SerialErrorCode::IoError,
        }
    };
    SerialError::new(code, message)
}

fn is_device_removed_io(error: &io::Error) -> bool {
    matches!(
        error.kind(),
        io::ErrorKind::BrokenPipe
            | io::ErrorKind::UnexpectedEof
            | io::ErrorKind::ConnectionReset
            | io::ErrorKind::NotConnected
    ) || (cfg!(unix) && error.raw_os_error() == Some(5))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum SerialStatus {
    Opening,
    Open,
    Listening,
    Closing,
    Closed,
    Error,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusLog {
    pub(crate) level: &'static str,
    pub(crate) source: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) peer_id: Option<String>,
    pub(crate) code: Option<String>,
    pub(crate) message: String,
    pub(crate) details: Option<Value>,
    pub(crate) created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StatusEvent {
    pub(crate) endpoint_id: String,
    pub(crate) operation_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) status: SerialStatus,
    pub(crate) error: Option<SerialError>,
    pub(crate) created_at: u64,
    pub(crate) log: Option<StatusLog>,
}

fn status_log(
    session: &Session,
    status: SerialStatus,
    error: Option<&SerialError>,
    created_at: u64,
    operation: Option<FailureOperation>,
) -> Option<StatusLog> {
    if status == SerialStatus::Closed && session.failure_reported.load(Ordering::SeqCst) {
        return None;
    }
    if status == SerialStatus::Closed && error.is_some() {
        return None;
    }
    let details = Some(serde_json::json!({ "path": session.path }));
    let lifecycle = |level, message| StatusLog {
        level,
        source: "serial",
        peer_id: None,
        code: None,
        message,
        details: details.clone(),
        created_at,
    };
    match status {
        SerialStatus::Opening => Some(lifecycle(
            "debug",
            format!("正在打开串口: {}", session.path),
        )),
        SerialStatus::Open => Some(lifecycle("info", format!("串口已打开: {}", session.path))),
        SerialStatus::Listening => {
            Some(lifecycle("info", format!("串口正在监听: {}", session.path)))
        }
        SerialStatus::Closing => Some(lifecycle(
            "debug",
            format!("正在关闭串口: {}", session.path),
        )),
        SerialStatus::Closed => Some(lifecycle("info", format!("串口已关闭: {}", session.path))),
        SerialStatus::Error => {
            let error = error?;
            if error.code == SerialErrorCode::DeviceRemoved {
                Some(StatusLog {
                    level: "warn",
                    source: "serial",
                    peer_id: None,
                    code: Some(error_code_name(error.code).into()),
                    message: format!("串口意外断开: {}", session.path),
                    details,
                    created_at,
                })
            } else {
                let intent = match operation {
                    Some(FailureOperation::Open) => "打开串口失败",
                    Some(FailureOperation::Read) => "读取串口失败",
                    Some(FailureOperation::Write) => "写入串口失败",
                    Some(FailureOperation::Close) => "关闭串口失败",
                    None => "串口操作失败",
                };
                Some(StatusLog {
                    level: "error",
                    source: "serial",
                    peer_id: None,
                    code: Some(error_code_name(error.code).into()),
                    message: format!("{intent}: {}", session.path),
                    details,
                    created_at,
                })
            }
        }
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

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct WireFrame {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) message_type: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) framing: Option<String>,
    pub(crate) direction: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) peer_id: Option<String>,
    pub(crate) bytes: Vec<u8>,
    pub(crate) created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrameBatch {
    pub(crate) endpoint_id: String,
    pub(crate) operation_id: String,
    pub(crate) session_id: String,
    pub(crate) frames: Vec<WireFrame>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerRecord {
    pub(crate) id: String,
    pub(crate) remote_address: String,
    pub(crate) connected_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerEvent {
    pub(crate) endpoint_id: String,
    pub(crate) operation_id: String,
    pub(crate) session_id: String,
    pub(crate) peers: Vec<PeerRecord>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum SerialEvent {
    Status(StatusEvent),
    Frames(FrameBatch),
    Peers(PeerEvent),
}

pub(crate) trait SerialEventSink: Send + Sync + 'static {
    fn emit(&self, event: SerialEvent);
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct OpenAcknowledgement {
    pub(crate) endpoint_id: String,
    pub(crate) operation_id: String,
    pub(crate) session_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CancelAcknowledgement {
    pub(crate) endpoint_id: String,
    pub(crate) operation_id: String,
    pub(crate) cancelled: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CloseAcknowledgement {
    pub(crate) endpoint_id: String,
    pub(crate) closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SendAcknowledgement {
    pub(crate) endpoint_id: String,
    pub(crate) sent: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) peer_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) success_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) failure_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) peer_results: Option<Vec<PeerSendResult>>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct PeerSendResult {
    pub(crate) peer_id: String,
    pub(crate) ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) byte_count: Option<usize>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) error: Option<SerialError>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SessionPhase {
    Opening,
    Open,
    Closing,
    Error,
    Terminal,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum FailureOperation {
    Open,
    Read,
    Write,
    Close,
}

struct SessionState {
    phase: SessionPhase,
    cancelled: bool,
    connection: Option<Arc<dyn SerialConnection>>,
    failure: Option<SerialError>,
    terminal_emitted: bool,
}

struct Session {
    endpoint_id: String,
    path: String,
    operation_id: String,
    session_id: String,
    generation: u64,
    framing: Mutex<Framer>,
    batcher: Mutex<FrameBatcher>,
    state: Mutex<SessionState>,
    terminal_changed: Condvar,
    reader_permitted: Mutex<bool>,
    reader_start_changed: Condvar,
    stop: AtomicBool,
    resource_closed: AtomicBool,
    failure_reported: AtomicBool,
    reader: Mutex<Option<JoinHandle<()>>>,
    send_commit_owner: Mutex<()>,
    write_owner: Mutex<()>,
    close_owner: Mutex<()>,
}

struct ServiceState {
    stopped: bool,
    forced: bool,
    active_opens: usize,
    sessions: HashMap<String, Arc<Session>>,
}

pub(crate) struct SerialService {
    backend: Arc<dyn SerialBackend>,
    sink: Mutex<Option<Arc<dyn SerialEventSink>>>,
    lifecycle: Mutex<ServiceState>,
    lifecycle_changed: Condvar,
    generation: AtomicU64,
    #[cfg(test)]
    before_open_reservation: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    before_open_completion: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    after_send_write: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
    #[cfg(test)]
    after_failure_flush: Mutex<Option<Arc<dyn Fn() + Send + Sync>>>,
}

impl SerialService {
    pub(crate) fn new(backend: Arc<dyn SerialBackend>, sink: Arc<dyn SerialEventSink>) -> Self {
        Self {
            backend,
            sink: Mutex::new(Some(sink)),
            lifecycle: Mutex::new(ServiceState {
                stopped: false,
                forced: false,
                active_opens: 0,
                sessions: HashMap::new(),
            }),
            lifecycle_changed: Condvar::new(),
            generation: AtomicU64::new(0),
            #[cfg(test)]
            before_open_reservation: Mutex::new(None),
            #[cfg(test)]
            before_open_completion: Mutex::new(None),
            #[cfg(test)]
            after_send_write: Mutex::new(None),
            #[cfg(test)]
            after_failure_flush: Mutex::new(None),
        }
    }

    pub(crate) fn scan(&self) -> SerialResult<Vec<SerialPortRecord>> {
        self.backend.scan()
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

    pub(crate) fn open(
        self: &Arc<Self>,
        endpoint: SerialEndpoint,
        operation_id: &str,
    ) -> SerialResult<OpenAcknowledgement> {
        require_id(&endpoint.endpoint_id, "endpointId")?;
        require_id(operation_id, "operationId")?;
        let generation = self.generation.fetch_add(1, Ordering::SeqCst) + 1;
        let session = Arc::new(Session {
            endpoint_id: endpoint.endpoint_id.clone(),
            path: endpoint.config.path.clone(),
            operation_id: operation_id.to_owned(),
            session_id: format!("serial-session-{generation}"),
            generation,
            framing: Mutex::new(Framer::new(endpoint.config.receive_framing.clone())),
            batcher: Mutex::new(FrameBatcher::new(now_millis())),
            state: Mutex::new(SessionState {
                phase: SessionPhase::Opening,
                cancelled: false,
                connection: None,
                failure: None,
                terminal_emitted: false,
            }),
            terminal_changed: Condvar::new(),
            reader_permitted: Mutex::new(false),
            reader_start_changed: Condvar::new(),
            stop: AtomicBool::new(false),
            resource_closed: AtomicBool::new(false),
            failure_reported: AtomicBool::new(false),
            reader: Mutex::new(None),
            send_commit_owner: Mutex::new(()),
            write_owner: Mutex::new(()),
            close_owner: Mutex::new(()),
        });
        {
            let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
            if lifecycle.stopped {
                return Err(SerialError::new(
                    SerialErrorCode::IoError,
                    "Serial service is shutting down",
                ));
            }
            #[cfg(test)]
            if let Some(hook) = self
                .before_open_reservation
                .lock()
                .map_err(poisoned)?
                .clone()
            {
                hook();
            }
            if lifecycle.sessions.contains_key(&endpoint.endpoint_id) {
                return Err(SerialError::new(
                    SerialErrorCode::PortBusy,
                    format!(
                        "Endpoint {} already has a serial session",
                        endpoint.endpoint_id
                    ),
                ));
            }
            lifecycle.active_opens += 1;
            lifecycle
                .sessions
                .insert(endpoint.endpoint_id.clone(), session.clone());
        }
        let _open_guard = ActiveOpen { service: self };
        self.emit_status(&session, SerialStatus::Opening, None, None, None);

        let connection = match self.backend.open(&endpoint.config) {
            Ok(connection) => connection,
            Err(error) => {
                let cancelled =
                    session.state.lock().map_err(poisoned)?.cancelled || self.is_stopped()?;
                let error = if cancelled { cancelled_error() } else { error };
                self.finish_open_failure(&session, error.clone());
                return Err(error);
            }
        };

        let cancelled = {
            let mut state = session.state.lock().map_err(poisoned)?;
            if state.cancelled || self.is_stopped()? {
                state.connection = Some(connection.clone());
                true
            } else {
                state.connection = Some(connection.clone());
                false
            }
        };
        if cancelled {
            let error = cancelled_error();
            self.finish_cancelled_open(&session, &connection, false, &error);
            return Err(error);
        }

        let service = self.clone();
        let reader_session = session.clone();
        let reader_connection = connection.clone();
        let reader = thread::Builder::new()
            .name(format!("serial-read-{}", session.generation))
            .spawn(move || service.read_loop(reader_session, reader_connection));
        let reader = match reader {
            Ok(reader) => reader,
            Err(error) => {
                let error = SerialError::new(SerialErrorCode::IoError, error.to_string());
                self.report_failure(&session, error.clone(), true, FailureOperation::Open);
                return Err(error);
            }
        };
        *session.reader.lock().map_err(poisoned)? = Some(reader);
        #[cfg(test)]
        if let Some(hook) = self
            .before_open_completion
            .lock()
            .map_err(poisoned)?
            .clone()
        {
            hook();
        }
        if let Err(error) = self.commit_open(&session) {
            self.finish_cancelled_open(&session, &connection, true, &error);
            return Err(error);
        }
        Ok(OpenAcknowledgement {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: session.session_id.clone(),
        })
    }

    pub(crate) fn cancel_open(
        &self,
        endpoint_id: &str,
        operation_id: &str,
    ) -> SerialResult<CancelAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        require_id(operation_id, "operationId")?;
        let session = self.session(endpoint_id)?.ok_or_else(|| {
            SerialError::new(
                SerialErrorCode::OpenCancelled,
                "Serial open is no longer active",
            )
        })?;
        let mut state = session.state.lock().map_err(poisoned)?;
        if session.operation_id != operation_id || state.phase != SessionPhase::Opening {
            return Err(SerialError::new(
                SerialErrorCode::OpenCancelled,
                "Serial open operation is no longer active",
            ));
        }
        state.cancelled = true;
        self.stop_session(&session);
        drop(state);
        Ok(CancelAcknowledgement {
            endpoint_id: endpoint_id.to_owned(),
            operation_id: operation_id.to_owned(),
            cancelled: true,
        })
    }

    pub(crate) fn send(
        &self,
        endpoint_id: &str,
        bytes: &[u8],
    ) -> SerialResult<SendAcknowledgement> {
        self.send_for_session(endpoint_id, bytes, None)
    }

    pub(crate) fn send_for_session(
        &self,
        endpoint_id: &str,
        bytes: &[u8],
        expected_session_id: Option<&str>,
    ) -> SerialResult<SendAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        let session = self.session(endpoint_id)?.ok_or_else(|| {
            SerialError::new(
                SerialErrorCode::PortNotFound,
                "Serial session was not found",
            )
        })?;
        if let Some(expected) = expected_session_id {
            require_id(expected, "target.expectedSessionId")?;
            if expected != session.session_id {
                return Err(SerialError::new(
                    SerialErrorCode::OpenCancelled,
                    "Serial response belongs to an inactive session",
                ));
            }
        }
        let connection = {
            let state = session.state.lock().map_err(poisoned)?;
            if state.phase != SessionPhase::Open {
                return Err(SerialError::new(
                    SerialErrorCode::IoError,
                    "Serial session is not open",
                ));
            }
            state.connection.clone().ok_or_else(|| {
                SerialError::new(SerialErrorCode::IoError, "Serial connection is unavailable")
            })?
        };
        let write_result = {
            let _send_commit = session.send_commit_owner.lock().map_err(poisoned)?;
            let _write_owner = session.write_owner.lock().map_err(poisoned)?;
            self.ensure_send_open(&session)?;
            let result = connection.write_all(bytes);
            if result.is_ok() {
                #[cfg(test)]
                if let Some(hook) = self.after_send_write.lock().map_err(poisoned)?.clone() {
                    hook();
                }
                self.ensure_send_open(&session)?;
                self.enqueue_frame(&session, "out", bytes.to_vec());
            }
            result
        };
        if let Err(error) = write_result {
            let error = map_io_error(error, false);
            self.report_failure(&session, error.clone(), true, FailureOperation::Write);
            return Err(error);
        }
        Ok(SendAcknowledgement {
            endpoint_id: endpoint_id.to_owned(),
            sent: bytes.len(),
            peer_count: None,
            success_count: None,
            failure_count: None,
            peer_results: None,
        })
    }

    pub(crate) fn close(&self, endpoint_id: &str) -> SerialResult<CloseAcknowledgement> {
        require_id(endpoint_id, "endpointId")?;
        let Some(session) = self.session(endpoint_id)? else {
            return Ok(CloseAcknowledgement {
                endpoint_id: endpoint_id.to_owned(),
                closed: true,
            });
        };
        {
            let mut state = session.state.lock().map_err(poisoned)?;
            if state.phase == SessionPhase::Opening {
                state.cancelled = true;
                self.stop_session(&session);
                while state.phase == SessionPhase::Opening {
                    state = session.terminal_changed.wait(state).map_err(poisoned)?;
                }
            }
        }
        let _close_owner = session.close_owner.lock().map_err(poisoned)?;
        let (was_open, needs_closed) = {
            let _send_commit = session.send_commit_owner.lock().map_err(poisoned)?;
            let mut state = session.state.lock().map_err(poisoned)?;
            let was_open = state.phase == SessionPhase::Open;
            let needs_closed = !state.terminal_emitted;
            if was_open {
                state.phase = SessionPhase::Closing;
            }
            self.stop_session(&session);
            (was_open, needs_closed)
        };
        if was_open {
            self.emit_status(
                &session,
                SerialStatus::Closing,
                Some(session.session_id.clone()),
                None,
                None,
            );
        }
        if let Err(error) = self.join_reader(&session) {
            self.report_failure(&session, error.clone(), false, FailureOperation::Close);
            return Err(error);
        }
        let _write_owner = session.write_owner.lock().map_err(poisoned)?;
        self.flush_session(&session);
        let connection = session.state.lock().map_err(poisoned)?.connection.clone();
        if !session.resource_closed.load(Ordering::SeqCst) {
            if let Some(connection) = connection {
                if let Err(error) = connection.close() {
                    let error = map_io_error(error, false);
                    self.report_failure(&session, error.clone(), false, FailureOperation::Close);
                    return Err(error);
                }
            }
        }
        session.resource_closed.store(true, Ordering::SeqCst);
        self.finish_terminal(&session, None, needs_closed);
        self.remove_if_current(&session);
        Ok(CloseAcknowledgement {
            endpoint_id: endpoint_id.to_owned(),
            closed: true,
        })
    }

    pub(crate) fn close_all(&self) -> SerialResult<()> {
        let endpoint_ids = {
            let lifecycle = self.lifecycle.lock().map_err(poisoned)?;
            lifecycle.sessions.keys().cloned().collect::<Vec<_>>()
        };
        let mut failed = Vec::new();
        for endpoint_id in endpoint_ids {
            if let Err(error) = self.close(&endpoint_id) {
                failed.push((endpoint_id, error));
            }
        }
        let mut first_error = None;
        for (endpoint_id, prior_error) in failed {
            if let Err(error) = self.close(&endpoint_id) {
                first_error.get_or_insert_with(|| {
                    SerialError::new(
                        error.code,
                        format!("{}; retry failed: {}", prior_error.message, error.message),
                    )
                });
            }
        }
        let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
        while lifecycle.active_opens > 0 {
            lifecycle = self.lifecycle_changed.wait(lifecycle).map_err(poisoned)?;
        }
        if let Some(error) = first_error {
            Err(error)
        } else {
            Ok(())
        }
    }

    pub(crate) fn shutdown(&self) -> SerialResult<()> {
        {
            let mut lifecycle = self.lifecycle.lock().map_err(poisoned)?;
            lifecycle.stopped = true;
            self.lifecycle_changed.notify_all();
        }
        self.close_all()
    }

    pub(crate) fn force_shutdown(&self) -> Vec<String> {
        let sessions = match self.lifecycle.lock() {
            Ok(mut lifecycle) => {
                lifecycle.stopped = true;
                lifecycle.forced = true;
                lifecycle.sessions.values().cloned().collect::<Vec<_>>()
            }
            Err(_) => {
                return vec![
                    "serial service lifecycle unavailable; process exit must reclaim resources"
                        .into(),
                ];
            }
        };
        let deadline = Instant::now() + FORCE_OWNER_GRACE;
        let mut process_exit_fallback = Vec::new();

        for session in sessions {
            self.stop_session(&session);
            let (connection, state_failure) = loop {
                match session.state.try_lock() {
                    Ok(mut state) => {
                        state.cancelled = true;
                        break (state.connection.clone(), None);
                    }
                    Err(_) if Instant::now() < deadline => thread::sleep(FORCE_OWNER_POLL),
                    Err(_) => {
                        break (
                            None,
                            Some(format!(
                                "{}: session state unavailable during forced cleanup",
                                session.endpoint_id
                            )),
                        );
                    }
                }
            };
            if session.resource_closed.load(Ordering::SeqCst) {
                self.remove_if_current(&session);
                continue;
            }
            if let Some(failure) = state_failure {
                process_exit_fallback.push(failure);
                continue;
            }
            let Some(connection) = connection else {
                process_exit_fallback.push(format!(
                    "{}: open has not produced a force-close handle",
                    session.endpoint_id
                ));
                continue;
            };
            if force_close_after_owner_grace(&session, &connection, deadline) {
                session.resource_closed.store(true, Ordering::SeqCst);
                if let Ok(mut state) = session.state.try_lock() {
                    state.phase = SessionPhase::Terminal;
                    state.terminal_emitted = true;
                }
                session.terminal_changed.notify_all();
                self.remove_if_current(&session);
                if let Ok(mut reader) = session.reader.lock() {
                    reader.take();
                }
            } else {
                if let Ok(mut state) = session.state.try_lock() {
                    state.phase = SessionPhase::Error;
                }
                process_exit_fallback.push(format!(
                    "{}: force close could not confirm resource release",
                    session.endpoint_id
                ));
            }
        }
        process_exit_fallback
    }

    fn commit_open(&self, session: &Arc<Session>) -> SerialResult<()> {
        let lifecycle = self.lifecycle.lock().map_err(poisoned)?;
        let registered = lifecycle
            .sessions
            .get(&session.endpoint_id)
            .is_some_and(|current| current.generation == session.generation);
        let mut state = session.state.lock().map_err(poisoned)?;
        let failure = if session.failure_reported.load(Ordering::SeqCst)
            || state.failure.is_some()
            || state.phase == SessionPhase::Error
        {
            Some(state.failure.clone().unwrap_or_else(|| {
                SerialError::new(
                    SerialErrorCode::IoError,
                    "Serial session failed before open committed",
                )
            }))
        } else if state.cancelled || lifecycle.stopped {
            Some(cancelled_error())
        } else if !registered
            || state.phase != SessionPhase::Opening
            || state.connection.is_none()
            || session.resource_closed.load(Ordering::SeqCst)
        {
            Some(SerialError::new(
                SerialErrorCode::IoError,
                "Serial session became invalid before open committed",
            ))
        } else {
            None
        };
        if let Some(failure) = failure {
            return Err(failure);
        }
        state.phase = SessionPhase::Open;
        drop(lifecycle);
        self.emit_status(
            session,
            SerialStatus::Open,
            Some(session.session_id.clone()),
            None,
            None,
        );
        drop(state);
        match session.reader_permitted.lock() {
            Ok(mut permitted) => *permitted = true,
            Err(poisoned) => *poisoned.into_inner() = true,
        }
        session.reader_start_changed.notify_all();
        Ok(())
    }

    fn ensure_send_open(&self, session: &Session) -> SerialResult<()> {
        let state = session.state.lock().map_err(poisoned)?;
        if state.phase != SessionPhase::Open || session.resource_closed.load(Ordering::SeqCst) {
            return Err(SerialError::new(
                SerialErrorCode::IoError,
                "Serial session is no longer open",
            ));
        }
        Ok(())
    }

    fn stop_session(&self, session: &Session) {
        session.stop.store(true, Ordering::SeqCst);
        session.reader_start_changed.notify_all();
    }

    fn wait_for_reader_start(&self, session: &Session) -> bool {
        let mut permitted = match session.reader_permitted.lock() {
            Ok(permitted) => permitted,
            Err(poisoned) => poisoned.into_inner(),
        };
        while !*permitted && !session.stop.load(Ordering::SeqCst) {
            permitted = match session.reader_start_changed.wait(permitted) {
                Ok(permitted) => permitted,
                Err(poisoned) => poisoned.into_inner(),
            };
        }
        *permitted && !session.stop.load(Ordering::SeqCst)
    }

    fn read_loop(self: Arc<Self>, session: Arc<Session>, connection: Arc<dyn SerialConnection>) {
        if !self.wait_for_reader_start(&session) {
            return;
        }
        let mut buffer = [0_u8; 8192];
        while !session.stop.load(Ordering::SeqCst) {
            let read_result = connection.read(&mut buffer);
            if session.stop.load(Ordering::SeqCst) {
                break;
            }
            match read_result {
                Ok(0) => {}
                Ok(length) => {
                    let now = now_millis();
                    let (frames, failure) = session
                        .framing
                        .lock()
                        .map(|mut framer| {
                            let frames = framer.push(&buffer[..length], now);
                            (frames, framer.take_error())
                        })
                        .unwrap_or_default();
                    for frame in frames {
                        self.enqueue_frame(&session, "in", frame);
                    }
                    if let Some(error) = failure {
                        self.report_failure(&session, error, true, FailureOperation::Read);
                        break;
                    }
                }
                Err(error)
                    if matches!(
                        error.kind(),
                        io::ErrorKind::TimedOut | io::ErrorKind::WouldBlock
                    ) => {}
                Err(error) => {
                    self.report_failure(
                        &session,
                        map_io_error(error, false),
                        true,
                        FailureOperation::Read,
                    );
                    break;
                }
            }
            let now = now_millis();
            let idle_frames = session
                .framing
                .lock()
                .map(|mut framer| framer.flush_idle(now))
                .unwrap_or_default();
            for frame in idle_frames {
                self.enqueue_frame(&session, "in", frame);
            }
            self.flush_due(&session, now);
        }
        self.flush_session(&session);
    }

    fn report_failure(
        &self,
        session: &Arc<Session>,
        error: SerialError,
        attempt_close: bool,
        operation: FailureOperation,
    ) {
        if session.failure_reported.swap(true, Ordering::SeqCst) {
            return;
        }
        let _send_commit = match session.send_commit_owner.lock() {
            Ok(owner) => owner,
            Err(poisoned) => poisoned.into_inner(),
        };
        self.stop_session(session);
        let session_id = session.state.lock().ok().and_then(|mut state| {
            let session_id =
                (state.phase != SessionPhase::Opening).then(|| session.session_id.clone());
            state.phase = SessionPhase::Error;
            state.failure = Some(error.clone());
            session_id
        });
        session.terminal_changed.notify_all();
        self.flush_session(session);
        #[cfg(test)]
        if let Ok(Some(hook)) = self.after_failure_flush.lock().map(|hook| hook.clone()) {
            hook();
        }
        let mut reported_error = error;
        let mut resource_closed = false;
        if attempt_close {
            if let Ok(_close_owner) = session.close_owner.try_lock() {
                if let Ok(_write_owner) = session.write_owner.lock() {
                    let connection = (!session.resource_closed.load(Ordering::SeqCst))
                        .then(|| {
                            session
                                .state
                                .lock()
                                .ok()
                                .and_then(|state| state.connection.clone())
                        })
                        .flatten();
                    match connection.map_or(Ok(()), |connection| connection.close()) {
                        Ok(()) => {
                            session.resource_closed.store(true, Ordering::SeqCst);
                            resource_closed = true;
                        }
                        Err(close_error) => {
                            let close_error = map_io_error(close_error, false);
                            reported_error = SerialError::new(
                                reported_error.code,
                                format!(
                                    "{}; automatic close failed: {}",
                                    reported_error.message, close_error.message
                                ),
                            );
                        }
                    }
                }
            }
        }
        if let Ok(mut state) = session.state.lock() {
            state.failure = Some(reported_error.clone());
        }
        self.emit_status(
            session,
            SerialStatus::Error,
            session_id,
            Some(reported_error),
            Some(operation),
        );
        if resource_closed {
            self.finish_terminal(session, None, true);
            self.remove_if_current(session);
        }
    }

    fn finish_cancelled_open(
        &self,
        session: &Arc<Session>,
        connection: &Arc<dyn SerialConnection>,
        reader_started: bool,
        cancellation: &SerialError,
    ) {
        self.stop_session(session);
        let Ok(_close_owner) = session.close_owner.lock() else {
            self.report_failure(
                session,
                SerialError::new(SerialErrorCode::IoError, "Serial close owner is poisoned"),
                false,
                FailureOperation::Close,
            );
            return;
        };
        if session.resource_closed.load(Ordering::SeqCst) {
            self.remove_if_current(session);
            return;
        }
        if reader_started {
            if let Err(error) = self.join_reader(session) {
                self.report_failure(session, error, false, FailureOperation::Close);
            }
        }
        let Ok(_write_owner) = session.write_owner.lock() else {
            self.report_failure(
                session,
                SerialError::new(SerialErrorCode::IoError, "Serial write owner is poisoned"),
                false,
                FailureOperation::Close,
            );
            return;
        };
        let close_result = match self.is_forced() {
            Ok(true) => connection
                .force_close()
                .then_some(())
                .ok_or_else(|| io::Error::other("forced serial close did not acquire port")),
            Ok(false) => connection.close(),
            Err(error) => {
                self.report_failure(session, error, false, FailureOperation::Close);
                return;
            }
        };
        match close_result {
            Ok(()) => {
                session.resource_closed.store(true, Ordering::SeqCst);
                if session.failure_reported.load(Ordering::SeqCst) {
                    self.finish_terminal(session, None, true);
                } else {
                    self.finish_terminal(session, Some(cancellation.clone()), true);
                }
                self.remove_if_current(session);
            }
            Err(error) => self.report_failure(
                session,
                map_io_error(error, false),
                false,
                FailureOperation::Close,
            ),
        }
    }

    fn finish_open_failure(&self, session: &Arc<Session>, error: SerialError) {
        if error.code == SerialErrorCode::OpenCancelled {
            self.finish_terminal(session, Some(error), false);
        } else {
            self.report_failure(session, error, true, FailureOperation::Open);
        }
        self.remove_if_current(session);
    }

    fn finish_terminal(
        &self,
        session: &Arc<Session>,
        error: Option<SerialError>,
        emit_success: bool,
    ) {
        let should_emit = if let Ok(mut state) = session.state.lock() {
            state.phase = SessionPhase::Terminal;
            let should_emit = !state.terminal_emitted;
            state.terminal_emitted = true;
            session.terminal_changed.notify_all();
            should_emit
        } else {
            false
        };
        if should_emit && (emit_success || error.is_some()) {
            self.emit_status(session, SerialStatus::Closed, None, error, None);
        }
    }

    #[cfg(test)]
    fn set_before_open_reservation(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.before_open_reservation.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_before_open_completion(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.before_open_completion.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_after_send_write(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.after_send_write.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn set_after_failure_flush(&self, hook: Arc<dyn Fn() + Send + Sync>) {
        *self.after_failure_flush.lock().unwrap() = Some(hook);
    }

    #[cfg(test)]
    fn wait_until_stopped(&self) {
        let deadline = Instant::now() + Duration::from_secs(1);
        let mut lifecycle = self.lifecycle.lock().unwrap();
        while !lifecycle.stopped {
            let remaining = deadline
                .checked_duration_since(Instant::now())
                .expect("timed out waiting for serial shutdown to start");
            let (next, timeout) = self
                .lifecycle_changed
                .wait_timeout(lifecycle, remaining)
                .unwrap();
            lifecycle = next;
            assert!(
                !timeout.timed_out(),
                "timed out waiting for serial shutdown to start"
            );
        }
    }

    fn end_open(&self) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            lifecycle.active_opens = lifecycle.active_opens.saturating_sub(1);
            self.lifecycle_changed.notify_all();
        }
    }

    fn session(&self, endpoint_id: &str) -> SerialResult<Option<Arc<Session>>> {
        Ok(self
            .lifecycle
            .lock()
            .map_err(poisoned)?
            .sessions
            .get(endpoint_id)
            .cloned())
    }

    fn remove_if_current(&self, session: &Arc<Session>) {
        if let Ok(mut lifecycle) = self.lifecycle.lock() {
            let is_current = lifecycle
                .sessions
                .get(&session.endpoint_id)
                .is_some_and(|current| current.generation == session.generation);
            if is_current {
                lifecycle.sessions.remove(&session.endpoint_id);
            }
        }
    }

    fn is_stopped(&self) -> SerialResult<bool> {
        Ok(self.lifecycle.lock().map_err(poisoned)?.stopped)
    }

    fn is_forced(&self) -> SerialResult<bool> {
        Ok(self.lifecycle.lock().map_err(poisoned)?.forced)
    }

    fn join_reader(&self, session: &Arc<Session>) -> SerialResult<()> {
        let reader = session.reader.lock().map_err(poisoned)?.take();
        if let Some(reader) = reader {
            reader.join().map_err(|_| {
                SerialError::new(SerialErrorCode::IoError, "Serial reader thread panicked")
            })?;
        }
        Ok(())
    }

    fn enqueue_frame(&self, session: &Arc<Session>, direction: &'static str, bytes: Vec<u8>) {
        let now = now_millis();
        let frames = session
            .batcher
            .lock()
            .ok()
            .and_then(|mut batcher| batcher.push(direction, bytes, now));
        if let Some(frames) = frames {
            self.emit_frames(session, frames);
        }
    }

    fn flush_due(&self, session: &Arc<Session>, now: u64) {
        let frames = session
            .batcher
            .lock()
            .ok()
            .and_then(|mut batcher| batcher.flush_due(now));
        if let Some(frames) = frames {
            self.emit_frames(session, frames);
        }
    }

    fn flush_session(&self, session: &Arc<Session>) {
        let final_frames = session
            .framing
            .lock()
            .map(|mut framer| framer.flush())
            .unwrap_or_default();
        for frame in final_frames {
            self.enqueue_frame(session, "in", frame);
        }
        let frames = session
            .batcher
            .lock()
            .ok()
            .and_then(|mut batcher| batcher.flush());
        if let Some(frames) = frames {
            self.emit_frames(session, frames);
        }
    }

    fn emit_status(
        &self,
        session: &Session,
        status: SerialStatus,
        session_id: Option<String>,
        error: Option<SerialError>,
        operation: Option<FailureOperation>,
    ) {
        let created_at = now_millis();
        let log = status_log(session, status, error.as_ref(), created_at, operation);
        self.emit_event(SerialEvent::Status(StatusEvent {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id,
            status,
            error,
            created_at,
            log,
        }));
    }

    fn emit_frames(&self, session: &Session, frames: Vec<WireFrame>) {
        self.emit_event(SerialEvent::Frames(FrameBatch {
            endpoint_id: session.endpoint_id.clone(),
            operation_id: session.operation_id.clone(),
            session_id: session.session_id.clone(),
            frames,
        }));
    }

    fn emit_event(&self, event: SerialEvent) {
        let sink = match self.sink.lock() {
            Ok(sink) => sink.clone(),
            Err(poisoned) => poisoned.into_inner().clone(),
        };
        if let Some(sink) = sink {
            sink.emit(event);
        }
    }
}

struct ActiveOpen<'a> {
    service: &'a SerialService,
}

impl Drop for ActiveOpen<'_> {
    fn drop(&mut self) {
        self.service.end_open();
    }
}

fn force_close_after_owner_grace(
    session: &Session,
    connection: &Arc<dyn SerialConnection>,
    deadline: Instant,
) -> bool {
    loop {
        if let Ok(_close_owner) = session.close_owner.try_lock() {
            if let Ok(_write_owner) = session.write_owner.try_lock() {
                return connection.force_close();
            }
        }
        if Instant::now() >= deadline {
            return connection.force_close();
        }
        thread::sleep(FORCE_OWNER_POLL);
    }
}

fn require_id(value: &str, field: &str) -> SerialResult<()> {
    if value.trim().is_empty() {
        Err(config_error(format!("{field} must be a nonblank string")))
    } else {
        Ok(())
    }
}

fn cancelled_error() -> SerialError {
    SerialError::new(
        SerialErrorCode::OpenCancelled,
        "Serial open operation was cancelled",
    )
}

fn poisoned<T>(_error: std::sync::PoisonError<T>) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, "Serial service mutex poisoned")
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}

#[cfg(test)]
#[path = "serial/tests.rs"]
mod tests;
