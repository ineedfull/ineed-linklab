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

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum DataBits {
    Five,
    Six,
    Seven,
    Eight,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum Parity {
    None,
    Odd,
    Even,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum StopBits {
    One,
    Two,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum FlowControl {
    None,
    Software,
    Hardware,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum ReceiveFraming {
    Raw,
    Delimiter(Vec<u8>),
    Fixed(usize),
    Idle(Duration),
}

impl ReceiveFraming {
    pub(crate) fn from_config(value: Option<&Value>) -> SerialResult<Self> {
        let Some(value) = value else {
            return Ok(Self::Raw);
        };
        let object = value
            .as_object()
            .ok_or_else(|| config_error("receiveFraming must be an object"))?;
        let mode = object
            .get("mode")
            .and_then(Value::as_str)
            .ok_or_else(|| config_error("receiveFraming.mode must be a string"))?;
        match mode {
            "raw" if object.len() == 1 => Ok(Self::Raw),
            "delimiter" if object.len() == 2 => {
                let values = object
                    .get("delimiterBytes")
                    .and_then(Value::as_array)
                    .ok_or_else(|| {
                        config_error("receiveFraming.delimiterBytes must be an array")
                    })?;
                if values.is_empty() {
                    return Err(config_error(
                        "receiveFraming.delimiterBytes must be nonempty",
                    ));
                }
                let mut bytes = Vec::with_capacity(values.len());
                for value in values {
                    let byte = value.as_u64().filter(|byte| *byte <= 255).ok_or_else(|| {
                        config_error("receiveFraming.delimiterBytes contains an invalid byte")
                    })?;
                    bytes.push(byte as u8);
                }
                Ok(Self::Delimiter(bytes))
            }
            "fixed" if object.len() == 2 => {
                let length = object
                    .get("length")
                    .and_then(Value::as_u64)
                    .filter(|length| *length > 0 && *length <= usize::MAX as u64)
                    .ok_or_else(|| {
                        config_error("receiveFraming.length must be a positive integer")
                    })?;
                Ok(Self::Fixed(length as usize))
            }
            "idle" if object.len() == 2 => {
                let idle_ms = object
                    .get("idleMs")
                    .and_then(Value::as_u64)
                    .filter(|idle_ms| *idle_ms > 0)
                    .ok_or_else(|| {
                        config_error("receiveFraming.idleMs must be a positive integer")
                    })?;
                Ok(Self::Idle(Duration::from_millis(idle_ms)))
            }
            "raw" | "delimiter" | "fixed" | "idle" => {
                Err(config_error("receiveFraming has unknown or missing fields"))
            }
            _ => Err(config_error("receiveFraming.mode is invalid")),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct SerialConfig {
    pub(crate) path: String,
    pub(crate) baud_rate: u32,
    pub(crate) data_bits: DataBits,
    pub(crate) parity: Parity,
    pub(crate) stop_bits: StopBits,
    pub(crate) flow_control: FlowControl,
    pub(crate) receive_framing: ReceiveFraming,
}

impl SerialConfig {
    pub(crate) fn from_value(value: &Value) -> SerialResult<Self> {
        let object = value
            .as_object()
            .ok_or_else(|| config_error("serial config must be an object"))?;
        let path = object
            .get("path")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|path| !path.is_empty())
            .ok_or_else(|| config_error("config.path must be a nonblank string"))?
            .to_owned();
        let baud_rate = object
            .get("baudRate")
            .and_then(Value::as_u64)
            .filter(|rate| *rate > 0 && *rate <= u32::MAX as u64)
            .ok_or_else(|| config_error("config.baudRate must be a positive integer"))?
            as u32;
        let data_bits = match object.get("dataBits").and_then(Value::as_u64) {
            Some(5) => DataBits::Five,
            Some(6) => DataBits::Six,
            Some(7) => DataBits::Seven,
            Some(8) => DataBits::Eight,
            _ => return Err(config_error("config.dataBits must be 5, 6, 7, or 8")),
        };
        let parity = match object.get("parity").and_then(Value::as_str) {
            Some("none") => Parity::None,
            Some("odd") => Parity::Odd,
            Some("even") => Parity::Even,
            Some("mark" | "space") => {
                return Err(config_error(
                    "serialport 4.9 does not support mark or space parity",
                ));
            }
            _ => return Err(config_error("config.parity must be none, odd, or even")),
        };
        let stop_bits = match object.get("stopBits") {
            Some(Value::Number(number)) if number.as_u64() == Some(1) => StopBits::One,
            Some(Value::Number(number)) if number.as_u64() == Some(2) => StopBits::Two,
            Some(Value::Number(number)) if number.as_f64() == Some(1.5) => {
                return Err(config_error(
                    "serialport 4.9 does not support 1.5 stop bits",
                ));
            }
            _ => return Err(config_error("config.stopBits must be 1 or 2")),
        };
        let flow_control = match object.get("flowControl").and_then(Value::as_str) {
            Some("none") => FlowControl::None,
            Some("software") => FlowControl::Software,
            Some("hardware") => FlowControl::Hardware,
            _ => {
                return Err(config_error(
                    "config.flowControl must be none, software, or hardware",
                ));
            }
        };
        Ok(Self {
            path,
            baud_rate,
            data_bits,
            parity,
            stop_bits,
            flow_control,
            receive_framing: ReceiveFraming::from_config(object.get("receiveFraming"))?,
        })
    }
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
            peer_id: None,
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

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}

#[cfg(test)]
mod tests {

    #[test]
    fn pending_frame_overflow_reports_read_error_and_closes_serial() {
        for mode in [
            ReceiveFraming::Delimiter(vec![0]),
            ReceiveFraming::Idle(Duration::from_secs(60)),
        ] {
            let connection = Arc::new(FakeConnection::default());
            let read_gate = Arc::new(OpenGate::default());
            *connection.read_gate.lock().unwrap() = Some(read_gate.clone());
            for _ in 0..128 {
                connection.queue_read(Ok(vec![1; 8192]));
            }
            connection.queue_read(Ok(vec![1]));
            let sink = Arc::new(RecordingSink::default());
            let service = service(
                Arc::new(FakeBackend::new(vec![connection.clone()])),
                sink.clone(),
            );
            service
                .open(endpoint("overflow", mode), "open-overflow")
                .unwrap();
            read_gate.release();
            sink.wait_for(|events| {
                events.iter().any(|event| {
                    matches!(
                        event,
                        SerialEvent::Status(StatusEvent {
                            status: SerialStatus::Closed,
                            ..
                        })
                    )
                })
            });
            let events = sink.events.lock().unwrap();
            let failure = events
                .iter()
                .find_map(|event| match event {
                    SerialEvent::Status(status) if status.status == SerialStatus::Error => {
                        Some(status)
                    }
                    _ => None,
                })
                .unwrap();
            let error = failure.error.as_ref().unwrap();
            assert_eq!(error.code, SerialErrorCode::IoError);
            assert!(error
                .message
                .contains("pending frame exceeds 1048576 bytes"));
            assert_eq!(
                failure.log.as_ref().unwrap().code.as_deref(),
                Some("IO_ERROR")
            );
            assert!(!events
                .iter()
                .any(|event| matches!(event, SerialEvent::Frames(_))));
            assert_eq!(connection.state.lock().unwrap().close_calls, 1);
            drop(events);
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

    use super::*;
    use crate::{database::ConfigurationDatabase, persistence::TransportPersistence};
    use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
    use std::{
        collections::VecDeque,
        io,
        sync::{Arc, Condvar, Mutex},
        thread,
        time::Duration,
    };

    #[derive(Default)]
    struct FakeConnectionState {
        reads: VecDeque<io::Result<Vec<u8>>>,
        writes: Vec<Vec<u8>>,
        write_failures: usize,
        close_calls: usize,
        close_failures: usize,
        force_close_calls: usize,
        force_close_failures: usize,
        active_closes: usize,
        max_active_closes: usize,
        close_during_write: bool,
        read_panics: usize,
        active_writes: usize,
        max_active_writes: usize,
    }

    #[derive(Default)]
    struct FakeConnection {
        state: Mutex<FakeConnectionState>,
        read_gate: Mutex<Option<Arc<OpenGate>>>,
        close_gate: Mutex<Option<Arc<OpenGate>>>,
    }

    impl FakeConnection {
        fn queue_read(&self, value: io::Result<Vec<u8>>) {
            self.state.lock().unwrap().reads.push_back(value);
        }
    }

    impl SerialConnection for FakeConnection {
        fn read(&self, bytes: &mut [u8]) -> io::Result<usize> {
            if let Some(gate) = self.read_gate.lock().unwrap().clone() {
                gate.wait();
            }
            let (should_panic, next) = {
                let mut state = self.state.lock().unwrap();
                let should_panic = state.read_panics > 0;
                state.read_panics = state.read_panics.saturating_sub(1);
                (should_panic, state.reads.pop_front())
            };
            assert!(!should_panic, "fake serial reader panic");
            match next {
                Some(Ok(value)) => {
                    bytes[..value.len()].copy_from_slice(&value);
                    Ok(value.len())
                }
                Some(Err(error)) => Err(error),
                None => {
                    thread::sleep(Duration::from_millis(5));
                    Err(io::Error::from(io::ErrorKind::TimedOut))
                }
            }
        }

        fn write_all(&self, bytes: &[u8]) -> io::Result<()> {
            {
                let mut state = self.state.lock().unwrap();
                state.active_writes += 1;
                state.max_active_writes = state.max_active_writes.max(state.active_writes);
            }
            let mut state = self.state.lock().unwrap();
            state.writes.push(bytes.to_vec());
            state.active_writes -= 1;
            if state.write_failures > 0 {
                state.write_failures -= 1;
                return Err(io::Error::other("write failed"));
            }
            Ok(())
        }

        fn close(&self) -> io::Result<()> {
            let gate = {
                let mut state = self.state.lock().unwrap();
                state.close_calls += 1;
                state.close_during_write |= state.active_writes > 0;
                state.active_closes += 1;
                state.max_active_closes = state.max_active_closes.max(state.active_closes);
                self.close_gate.lock().unwrap().clone()
            };
            if let Some(gate) = gate {
                gate.wait();
            }
            let mut state = self.state.lock().unwrap();
            state.active_closes -= 1;
            if state.close_failures > 0 {
                state.close_failures -= 1;
                return Err(io::Error::other("close failed"));
            }
            Ok(())
        }

        fn force_close(&self) -> bool {
            let mut state = self.state.lock().unwrap();
            state.close_calls += 1;
            state.force_close_calls += 1;
            state.active_closes += 1;
            state.max_active_closes = state.max_active_closes.max(state.active_closes);
            state.close_failures = 0;
            state.active_closes -= 1;
            if state.force_close_failures > 0 {
                state.force_close_failures -= 1;
                return false;
            }
            true
        }
    }

    #[derive(Default)]
    struct GateState {
        entered: bool,
        released: bool,
    }

    #[derive(Default)]
    struct OpenGate {
        state: Mutex<GateState>,
        changed: Condvar,
    }

    impl OpenGate {
        fn wait(&self) {
            let mut state = self.state.lock().unwrap();
            state.entered = true;
            self.changed.notify_all();
            while !state.released {
                state = self.changed.wait(state).unwrap();
            }
        }

        fn release(&self) {
            self.state.lock().unwrap().released = true;
            self.changed.notify_all();
        }

        fn wait_until_entered(&self) {
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            let mut state = self.state.lock().unwrap();
            while !state.entered {
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .expect("timed out waiting for gate entry");
                let (next, timeout) = self.changed.wait_timeout(state, remaining).unwrap();
                state = next;
                assert!(!timeout.timed_out(), "timed out waiting for gate entry");
            }
        }
    }

    struct FakeBackend {
        ports: Mutex<Vec<SerialPortRecord>>,
        connections: Mutex<VecDeque<Arc<FakeConnection>>>,
        configs: Mutex<Vec<SerialConfig>>,
        gate: Option<Arc<OpenGate>>,
    }

    impl FakeBackend {
        fn new(connections: Vec<Arc<FakeConnection>>) -> Self {
            Self {
                ports: Mutex::new(Vec::new()),
                connections: Mutex::new(connections.into()),
                configs: Mutex::new(Vec::new()),
                gate: None,
            }
        }
    }

    impl SerialBackend for FakeBackend {
        fn scan(&self) -> SerialResult<Vec<SerialPortRecord>> {
            Ok(self.ports.lock().unwrap().clone())
        }

        fn open(&self, config: &SerialConfig) -> SerialResult<Arc<dyn SerialConnection>> {
            self.configs.lock().unwrap().push(config.clone());
            if let Some(gate) = &self.gate {
                gate.wait();
            }
            self.connections
                .lock()
                .unwrap()
                .pop_front()
                .map(|connection| connection as Arc<dyn SerialConnection>)
                .ok_or_else(|| SerialError::new(SerialErrorCode::PortNotFound, "missing port"))
        }
    }

    #[derive(Default)]
    struct RecordingSink {
        events: Mutex<Vec<SerialEvent>>,
        changed: Condvar,
    }

    impl SerialEventSink for RecordingSink {
        fn emit(&self, event: SerialEvent) {
            self.events.lock().unwrap().push(event);
            self.changed.notify_all();
        }
    }

    impl RecordingSink {
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

        fn wait_for(&self, predicate: impl Fn(&[SerialEvent]) -> bool) {
            let deadline = std::time::Instant::now() + Duration::from_secs(1);
            let mut events = self.events.lock().unwrap();
            while !predicate(&events) {
                let remaining = deadline
                    .checked_duration_since(std::time::Instant::now())
                    .expect("timed out waiting for serial event");
                let (next, timeout) = self.changed.wait_timeout(events, remaining).unwrap();
                events = next;
                assert!(!timeout.timed_out(), "timed out waiting for serial event");
            }
        }
    }

    struct PersistingRecordingSink {
        endpoint_id: String,
        persistence: Arc<TransportPersistence>,
        observed: Arc<RecordingSink>,
    }

    impl SerialEventSink for PersistingRecordingSink {
        fn emit(&self, event: SerialEvent) {
            let endpoint_id = match &event {
                SerialEvent::Status(status) => &status.endpoint_id,
                SerialEvent::Frames(batch) => &batch.endpoint_id,
                SerialEvent::Peers(peers) => &peers.endpoint_id,
            };
            if endpoint_id == &self.endpoint_id {
                self.persistence.handle(event.clone());
            }
            self.observed.emit(event);
        }
    }

    struct PtyHistoryCleanup {
        directory: std::path::PathBuf,
        service: Option<Arc<SerialService>>,
        persistence: Option<Arc<TransportPersistence>>,
        sink: Option<Arc<PersistingRecordingSink>>,
        database: Option<Arc<ConfigurationDatabase>>,
    }

    impl Drop for PtyHistoryCleanup {
        fn drop(&mut self) {
            if let Some(service) = self.service.take() {
                let _ = service.force_shutdown();
            }
            if let Some(persistence) = self.persistence.take() {
                let _ = persistence.shutdown();
            }
            self.sink.take();
            self.database.take();
            let _ = std::fs::remove_dir_all(&self.directory);
        }
    }

    fn endpoint(id: &str, framing: ReceiveFraming) -> SerialEndpoint {
        SerialEndpoint {
            endpoint_id: id.to_owned(),
            config: SerialConfig {
                path: format!("/dev/{id}"),
                baud_rate: 115_200,
                data_bits: DataBits::Eight,
                parity: Parity::None,
                stop_bits: StopBits::One,
                flow_control: FlowControl::None,
                receive_framing: framing,
            },
        }
    }

    fn raw_endpoint(id: &str) -> SerialEndpoint {
        endpoint(id, ReceiveFraming::Raw)
    }

    fn service(backend: Arc<FakeBackend>, sink: Arc<RecordingSink>) -> Arc<SerialService> {
        Arc::new(SerialService::new(backend, sink))
    }

    fn spawn_result<T: Send + 'static>(
        work: impl FnOnce() -> T + Send + 'static,
    ) -> (JoinHandle<()>, std::sync::mpsc::Receiver<T>) {
        let (started_tx, started_rx) = std::sync::mpsc::sync_channel(1);
        let (result_tx, result_rx) = std::sync::mpsc::sync_channel(1);
        let worker = thread::spawn(move || {
            let _ = started_tx.send(());
            let _ = result_tx.send(work());
        });
        started_rx
            .recv_timeout(Duration::from_secs(1))
            .expect("worker did not start before deadline");
        (worker, result_rx)
    }

    fn finish_worker<T>(worker: JoinHandle<()>, results: std::sync::mpsc::Receiver<T>) -> T {
        let result = results
            .recv_timeout(Duration::from_secs(1))
            .expect("worker did not finish before deadline");
        worker.join().expect("worker panicked");
        result
    }

    #[test]
    fn scan_preserves_strict_nullable_metadata() {
        let backend = Arc::new(FakeBackend::new(Vec::new()));
        *backend.ports.lock().unwrap() = vec![SerialPortRecord {
            path: "/dev/ttyUSB0".into(),
            manufacturer: Some("Maker".into()),
            serial_number: Some("SN-1".into()),
            vendor_id: Some("1209".into()),
            product_id: Some("0001".into()),
        }];
        let service = service(backend, Arc::new(RecordingSink::default()));

        assert_eq!(
            service.scan().unwrap()[0].serial_number.as_deref(),
            Some("SN-1")
        );
    }

    #[test]
    fn config_maps_all_supported_values_and_rejects_unsupported_mark_and_one_point_five() {
        let value = serde_json::json!({
            "path": "COM3", "baudRate": 57600, "dataBits": 5,
            "parity": "odd", "stopBits": 2, "flowControl": "software"
        });
        let config = SerialConfig::from_value(&value).unwrap();
        assert_eq!(config.data_bits, DataBits::Five);
        assert_eq!(config.parity, Parity::Odd);
        assert_eq!(config.stop_bits, StopBits::Two);
        assert_eq!(config.flow_control, FlowControl::Software);

        for unsupported in [
            serde_json::json!({"path":"COM3","baudRate":9600,"dataBits":8,"parity":"mark","stopBits":1,"flowControl":"none"}),
            serde_json::json!({"path":"COM3","baudRate":9600,"dataBits":8,"parity":"none","stopBits":1.5,"flowControl":"none"}),
        ] {
            assert_eq!(
                SerialConfig::from_value(&unsupported).unwrap_err().code,
                SerialErrorCode::IoError
            );
        }
    }

    #[test]
    fn posix_eio_maps_to_device_removed_after_open() {
        assert_eq!(
            map_io_error(io::Error::from_raw_os_error(5), false).code,
            SerialErrorCode::DeviceRemoved
        );
        assert_eq!(
            map_io_error(io::Error::from_raw_os_error(5), true).code,
            SerialErrorCode::IoError
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn macos_numeric_ptys_skip_unsupported_baud_ioctl() {
        let mut config = raw_endpoint("baud").config;
        config.path = "/dev/ttys019".into();
        assert_eq!(effective_baud_rate(&config), 0);
        for physical_or_plain_path in [
            "/tmp/ttys019",
            "/dev/tty.usbserial-DEV",
            "/dev/ttyUSB0",
            "/dev/ttys019-extra",
        ] {
            config.path = physical_or_plain_path.into();
            assert_eq!(
                effective_baud_rate(&config),
                115_200,
                "{physical_or_plain_path}"
            );
        }

        let directory = std::env::temp_dir().join(format!(
            "ineed-linklab-pty-symlink-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let link = directory.join("slave.pty");
        std::os::unix::fs::symlink("/dev/ttys019", &link).unwrap();
        config.path = link.to_string_lossy().into_owned();
        assert_eq!(effective_baud_rate(&config), 0);
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir(directory).unwrap();
    }

    #[test]
    fn multiple_sessions_are_independent_and_writes_serialize_per_session() {
        let first = Arc::new(FakeConnection::default());
        let second = Arc::new(FakeConnection::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![first.clone(), second.clone()])),
            Arc::new(RecordingSink::default()),
        );
        service.open(raw_endpoint("one"), "open-one").unwrap();
        service.open(raw_endpoint("two"), "open-two").unwrap();

        let mut workers = Vec::new();
        for value in 0..4_u8 {
            let service = service.clone();
            workers.push(spawn_result(move || service.send("one", &[value])));
        }
        for (worker, results) in workers {
            finish_worker(worker, results).unwrap();
        }

        assert_eq!(first.state.lock().unwrap().max_active_writes, 1);
        assert!(second.state.lock().unwrap().writes.is_empty());
        service.shutdown().unwrap();
        assert_eq!(first.state.lock().unwrap().close_calls, 1);
        assert_eq!(second.state.lock().unwrap().close_calls, 1);
    }

    #[test]
    fn lifecycle_status_logs_match_the_electron_contract() {
        let connection = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(FakeBackend::new(vec![connection])), sink.clone());
        service
            .open(raw_endpoint("status-wire"), "open-status-wire")
            .unwrap();
        service.close("status-wire").unwrap();

        let statuses = sink.statuses("status-wire");
        assert_eq!(
            statuses
                .iter()
                .map(|status| status.status)
                .collect::<Vec<_>>(),
            vec![
                SerialStatus::Opening,
                SerialStatus::Open,
                SerialStatus::Closing,
                SerialStatus::Closed,
            ]
        );
        for (status, (expected_status, level, message)) in statuses.iter().zip([
            (
                SerialStatus::Opening,
                "debug",
                "正在打开串口: /dev/status-wire",
            ),
            (SerialStatus::Open, "info", "串口已打开: /dev/status-wire"),
            (
                SerialStatus::Closing,
                "debug",
                "正在关闭串口: /dev/status-wire",
            ),
            (SerialStatus::Closed, "info", "串口已关闭: /dev/status-wire"),
        ]) {
            assert_eq!(status.status, expected_status);
            assert!(status.created_at >= 1_000_000_000_000);
            assert_eq!(status.log.as_ref().unwrap().created_at, status.created_at);
            assert_eq!(
                serde_json::to_value(status.log.as_ref().expect("lifecycle log")).unwrap(),
                serde_json::json!({
                    "level": level,
                    "source": "serial",
                    "code": null,
                    "message": message,
                    "details": { "path": "/dev/status-wire" },
                    "createdAt": status.created_at,
                })
            );
        }
    }

    #[test]
    fn failure_status_logs_match_electron_intent_and_suppress_closed_info() {
        let open_sink = Arc::new(RecordingSink::default());
        let open_service = service(Arc::new(FakeBackend::new(vec![])), open_sink.clone());
        assert_eq!(
            open_service
                .open(raw_endpoint("open-log"), "open-log")
                .unwrap_err()
                .code,
            SerialErrorCode::PortNotFound
        );
        assert_failure_log(
            &open_sink,
            "open-log",
            "error",
            "PORT_NOT_FOUND",
            "打开串口失败: /dev/open-log",
        );

        let read_connection = Arc::new(FakeConnection::default());
        read_connection.queue_read(Err(io::Error::other("read failed")));
        let read_sink = Arc::new(RecordingSink::default());
        let read_service = service(
            Arc::new(FakeBackend::new(vec![read_connection])),
            read_sink.clone(),
        );
        read_service
            .open(raw_endpoint("read-log"), "read-log")
            .unwrap();
        read_sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(event, SerialEvent::Status(status) if status.endpoint_id == "read-log" && status.status == SerialStatus::Closed)
            })
        });
        assert_failure_log(
            &read_sink,
            "read-log",
            "error",
            "IO_ERROR",
            "读取串口失败: /dev/read-log",
        );

        let write_connection = Arc::new(FakeConnection::default());
        write_connection.state.lock().unwrap().write_failures = 1;
        let write_sink = Arc::new(RecordingSink::default());
        let write_service = service(
            Arc::new(FakeBackend::new(vec![write_connection])),
            write_sink.clone(),
        );
        write_service
            .open(raw_endpoint("write-log"), "write-log")
            .unwrap();
        assert_eq!(
            write_service.send("write-log", &[1]).unwrap_err().code,
            SerialErrorCode::IoError
        );
        assert_failure_log(
            &write_sink,
            "write-log",
            "error",
            "IO_ERROR",
            "写入串口失败: /dev/write-log",
        );

        let removed_connection = Arc::new(FakeConnection::default());
        removed_connection.queue_read(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        let removed_sink = Arc::new(RecordingSink::default());
        let removed_service = service(
            Arc::new(FakeBackend::new(vec![removed_connection])),
            removed_sink.clone(),
        );
        removed_service
            .open(raw_endpoint("removed-log"), "removed-log")
            .unwrap();
        removed_sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(event, SerialEvent::Status(status) if status.endpoint_id == "removed-log" && status.status == SerialStatus::Closed)
            })
        });
        assert_failure_log(
            &removed_sink,
            "removed-log",
            "warn",
            "DEVICE_REMOVED",
            "串口意外断开: /dev/removed-log",
        );
    }

    fn assert_failure_log(
        sink: &RecordingSink,
        endpoint_id: &str,
        level: &str,
        code: &str,
        message: &str,
    ) {
        let statuses = sink.statuses(endpoint_id);
        let failure = statuses
            .iter()
            .find(|status| status.status == SerialStatus::Error)
            .expect("error status");
        assert_eq!(
            serde_json::to_value(failure.log.as_ref().expect("failure log")).unwrap(),
            serde_json::json!({
                "level": level,
                "source": "serial",
                "code": code,
                "message": message,
                "details": { "path": format!("/dev/{endpoint_id}") },
                "createdAt": failure.created_at,
            })
        );
        let closed = statuses
            .iter()
            .find(|status| status.status == SerialStatus::Closed)
            .expect("terminal closed status");
        assert_eq!(closed.log, None);
    }

    #[test]
    fn simulator_send_rejects_an_inactive_expected_session() {
        let connection = Arc::new(FakeConnection::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        let opened = service.open(raw_endpoint("simulator"), "open-new").unwrap();
        let error = service
            .send_for_session("simulator", &[0x68], Some("serial-old"))
            .unwrap_err();
        assert_eq!(error.code, SerialErrorCode::OpenCancelled);
        assert_eq!(
            service
                .send_for_session("simulator", &[0x68], Some(&opened.session_id))
                .unwrap()
                .sent,
            1
        );
        service.close("simulator").unwrap();
    }

    #[test]
    fn send_publishes_strict_outbound_frame_and_close_flushes_it() {
        let connection = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(FakeBackend::new(vec![connection])), sink.clone());
        service.open(raw_endpoint("send"), "open-send").unwrap();
        assert_eq!(service.send("send", &[0, 127, 255]).unwrap().sent, 3);
        service.close("send").unwrap();

        let frames = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .find_map(|event| {
                if let SerialEvent::Frames(batch) = event {
                    Some(batch.frames.clone())
                } else {
                    None
                }
            })
            .unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(frames[0].direction, "out");
        assert_eq!(frames[0].bytes, vec![0, 127, 255]);
    }

    #[test]
    fn close_waits_for_the_active_session_write_owner() {
        let connection = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            sink.clone(),
        );
        let send_commit_gate = Arc::new(OpenGate::default());
        let send_commit_release = send_commit_gate.clone();
        service.set_after_send_write(Arc::new(move || send_commit_release.wait()));
        service.open(raw_endpoint("race"), "open-race").unwrap();
        let send_service = service.clone();
        let (sending, send_results) = spawn_result(move || send_service.send("race", &[1, 2, 3]));
        send_commit_gate.wait_until_entered();
        let close_service = service.clone();
        let (closing, close_results) = spawn_result(move || close_service.close("race"));
        assert!(matches!(
            close_results.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        send_commit_gate.release();
        assert_eq!(finish_worker(sending, send_results).unwrap().sent, 3);
        finish_worker(closing, close_results).unwrap();
        assert!(!connection.state.lock().unwrap().close_during_write);
        let events = sink.events.lock().unwrap();
        let frame_index = events
            .iter()
            .position(|event| matches!(event, SerialEvent::Frames(_)))
            .unwrap();
        let closed_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Closed,
                        ..
                    })
                )
            })
            .unwrap();
        assert!(frame_index < closed_index);
        assert_eq!(closed_index, events.len() - 1);
    }

    #[test]
    fn cancel_acknowledges_before_late_open_and_shutdown_waits_for_terminal_cleanup() {
        let connection = Arc::new(FakeConnection::default());
        let gate = Arc::new(OpenGate::default());
        let mut backend = FakeBackend::new(vec![connection.clone()]);
        backend.gate = Some(gate.clone());
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(backend), sink);
        let opening_service = service.clone();
        let (opening, open_results) =
            spawn_result(move || opening_service.open(raw_endpoint("late"), "open-late"));
        gate.wait_until_entered();

        assert!(service.cancel_open("late", "open-late").unwrap().cancelled);
        let shutdown_service = service.clone();
        let (shutdown, shutdown_results) = spawn_result(move || shutdown_service.shutdown());
        service.wait_until_stopped();
        assert!(matches!(
            shutdown_results.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));
        gate.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        finish_worker(shutdown, shutdown_results).unwrap();
        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
    }

    #[test]
    fn cancelled_late_open_success_emits_terminal_without_normal_close_log() {
        let connection = Arc::new(FakeConnection::default());
        let gate = Arc::new(OpenGate::default());
        let mut backend = FakeBackend::new(vec![connection.clone()]);
        backend.gate = Some(gate.clone());
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(backend), sink.clone());
        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("cancel-logless"), "open-cancel-logless")
        });
        gate.wait_until_entered();

        assert!(
            service
                .cancel_open("cancel-logless", "open-cancel-logless")
                .unwrap()
                .cancelled
        );
        gate.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
        let terminal = sink
            .statuses("cancel-logless")
            .into_iter()
            .find(|status| status.status == SerialStatus::Closed)
            .expect("terminal close status");
        assert_eq!(
            terminal.error.as_ref().map(|error| error.code),
            Some(SerialErrorCode::OpenCancelled)
        );
        assert_eq!(terminal.log, None);
    }

    #[test]
    fn cancelled_late_open_close_failure_stays_retryable_without_closed_status() {
        let failed = Arc::new(FakeConnection::default());
        failed.state.lock().unwrap().close_failures = 1;
        let replacement = Arc::new(FakeConnection::default());
        let gate = Arc::new(OpenGate::default());
        let mut backend = FakeBackend::new(vec![failed.clone(), replacement]);
        backend.gate = Some(gate.clone());
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(backend), sink.clone());
        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("cancel-close-retry"), "open-cancelled")
        });
        gate.wait_until_entered();
        service
            .cancel_open("cancel-close-retry", "open-cancelled")
            .unwrap();
        gate.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        assert_eq!(failed.state.lock().unwrap().close_calls, 1);
        let statuses = sink.statuses("cancel-close-retry");
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            0
        );
        assert_eq!(
            statuses
                .iter()
                .find(|status| status.status == SerialStatus::Error)
                .and_then(|status| status.error.as_ref())
                .map(|error| error.code),
            Some(SerialErrorCode::IoError)
        );
        service.close("cancel-close-retry").unwrap();
        assert_eq!(failed.state.lock().unwrap().close_calls, 2);
        assert_eq!(
            sink.statuses("cancel-close-retry")
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            1
        );
        service
            .open(raw_endpoint("cancel-close-retry"), "open-replacement")
            .unwrap();
        service.close("cancel-close-retry").unwrap();
    }

    #[test]
    fn framers_support_raw_delimiter_fixed_idle_and_default_raw() {
        assert_eq!(
            ReceiveFraming::from_config(None).unwrap(),
            ReceiveFraming::Raw
        );
        let mut delimiter = Framer::new(ReceiveFraming::Delimiter(vec![b'\n']));
        assert_eq!(
            delimiter.push(b"one\ntwo\n", 1),
            vec![b"one".to_vec(), b"two".to_vec()]
        );
        let mut fixed = Framer::new(ReceiveFraming::Fixed(2));
        assert_eq!(fixed.push(&[1, 2, 3, 4], 2), vec![vec![1, 2], vec![3, 4]]);
        let mut idle = Framer::new(ReceiveFraming::Idle(Duration::from_millis(5)));
        assert!(idle.push(&[7, 8], 10).is_empty());
        assert_eq!(idle.flush_idle(15), vec![vec![7, 8]]);
        assert_eq!(
            Framer::new(ReceiveFraming::Raw).push(&[9], 1),
            vec![vec![9]]
        );
    }

    #[test]
    fn batching_flushes_at_two_hundred_frames() {
        let mut batcher = FrameBatcher::new(0);
        for index in 0..199 {
            assert!(batcher.push("in", vec![index as u8], index).is_none());
        }
        assert_eq!(batcher.push("in", vec![199], 199).unwrap().len(), 200);
        assert!(batcher.push("in", vec![1], 1_000).is_none());
        assert!(batcher.flush_due(1_199).is_none());
        assert_eq!(batcher.flush_due(1_200).unwrap().len(), 1);
    }

    #[test]
    fn open_rejects_a_reader_failure_that_terminalizes_the_session_before_commit() {
        let connection = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(FakeBackend::new(vec![connection])), sink.clone());
        let weak_service = Arc::downgrade(&service);
        service.set_before_open_completion(Arc::new(move || {
            let service = weak_service.upgrade().unwrap();
            let session = service.session("ghost-open").unwrap().unwrap();
            service.report_failure(
                &session,
                SerialError::new(
                    SerialErrorCode::DeviceRemoved,
                    "reader failed before commit",
                ),
                true,
                FailureOperation::Read,
            );
        }));

        let error = service
            .open(raw_endpoint("ghost-open"), "open-ghost")
            .unwrap_err();

        assert_eq!(error.code, SerialErrorCode::DeviceRemoved);
        assert!(service.session("ghost-open").unwrap().is_none());
        assert!(!sink
            .statuses("ghost-open")
            .iter()
            .any(|status| status.status == SerialStatus::Open));
    }

    #[test]
    fn read_failure_flushes_residual_frames_before_error_and_closed() {
        let connection = Arc::new(FakeConnection::default());
        let read_gate = Arc::new(OpenGate::default());
        *connection.read_gate.lock().unwrap() = Some(read_gate.clone());
        connection.queue_read(Ok(vec![1, 2]));
        connection.queue_read(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(FakeBackend::new(vec![connection])), sink.clone());
        service
            .open(
                endpoint("ordered-failure", ReceiveFraming::Delimiter(vec![b'\n'])),
                "open-ordered-failure",
            )
            .unwrap();

        read_gate.release();
        sink.wait_for(|events| {
            events
                .iter()
                .any(|event| matches!(event, SerialEvent::Frames(_)))
                && events.iter().any(|event| {
                    matches!(
                        event,
                        SerialEvent::Status(StatusEvent {
                            status: SerialStatus::Closed,
                            ..
                        })
                    )
                })
        });

        let events = sink.events.lock().unwrap();
        let frame_index = events
            .iter()
            .position(|event| matches!(event, SerialEvent::Frames(_)))
            .unwrap();
        let error_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Error,
                        ..
                    })
                )
            })
            .unwrap();
        let closed_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Closed,
                        ..
                    })
                )
            })
            .unwrap();
        assert!(frame_index < error_index);
        assert!(error_index < closed_index);
        assert_eq!(closed_index, events.len() - 1);
    }

    #[test]
    fn successful_send_commits_outbound_frame_before_failure_closed_terminal() {
        let connection = Arc::new(FakeConnection::default());
        let read_gate = Arc::new(OpenGate::default());
        *connection.read_gate.lock().unwrap() = Some(read_gate.clone());
        connection.queue_read(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(FakeBackend::new(vec![connection])), sink.clone());
        let send_commit_gate = Arc::new(OpenGate::default());
        let send_commit_release = send_commit_gate.clone();
        service.set_after_send_write(Arc::new(move || send_commit_release.wait()));
        let (failure_flush_tx, failure_flush_rx) = std::sync::mpsc::sync_channel(1);
        service.set_after_failure_flush(Arc::new(move || {
            let _ = failure_flush_tx.send(());
        }));
        service
            .open(
                raw_endpoint("send-terminal-order"),
                "open-send-terminal-order",
            )
            .unwrap();

        let send_service = service.clone();
        let (sending, send_results) =
            spawn_result(move || send_service.send("send-terminal-order", &[1, 2, 3]));
        send_commit_gate.wait_until_entered();
        read_gate.release();
        let failure_flushed_while_send_was_active = failure_flush_rx
            .recv_timeout(Duration::from_millis(30))
            .is_ok();
        send_commit_gate.release();

        let send_result = finish_worker(sending, send_results);
        sink.wait_for(|events| {
            events
                .iter()
                .any(|event| matches!(event, SerialEvent::Frames(_)))
                && events.iter().any(|event| {
                    matches!(
                        event,
                        SerialEvent::Status(StatusEvent {
                            status: SerialStatus::Closed,
                            ..
                        })
                    )
                })
        });
        let events = sink.events.lock().unwrap();
        let frame_index = events
            .iter()
            .position(|event| matches!(event, SerialEvent::Frames(_)))
            .unwrap();
        let error_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Error,
                        ..
                    })
                )
            })
            .unwrap();
        let closed_index = events
            .iter()
            .position(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Closed,
                        ..
                    })
                )
            })
            .unwrap();

        assert!(!failure_flushed_while_send_was_active);
        assert_eq!(send_result.unwrap().sent, 3);
        assert!(frame_index < error_index);
        assert!(error_index < closed_index);
        assert_eq!(closed_index, events.len() - 1);
    }

    #[test]
    fn disconnect_event_sink_releases_service_owned_sink() {
        let sink = Arc::new(RecordingSink::default());
        let weak_sink = Arc::downgrade(&sink);
        let service = service(Arc::new(FakeBackend::new(Vec::new())), sink.clone());
        drop(sink);
        assert!(weak_sink.upgrade().is_some());

        service.disconnect_event_sink();

        assert!(weak_sink.upgrade().is_none());
    }

    #[test]
    fn device_removal_emits_one_error_closed_cycle_and_read_loop_exits() {
        let connection = Arc::new(FakeConnection::default());
        connection.queue_read(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        let sink = Arc::new(RecordingSink::default());
        let service = service(Arc::new(FakeBackend::new(vec![connection])), sink.clone());
        service
            .open(raw_endpoint("removed"), "open-removed")
            .unwrap();
        sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Closed,
                        ..
                    })
                )
            })
        });
        service.close("removed").unwrap();

        let statuses: Vec<_> = sink
            .events
            .lock()
            .unwrap()
            .iter()
            .filter_map(|event| {
                if let SerialEvent::Status(status) = event {
                    Some(status.status)
                } else {
                    None
                }
            })
            .collect();
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == SerialStatus::Error)
                .count(),
            1
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| **status == SerialStatus::Closed)
                .count(),
            1
        );
    }

    #[test]
    fn automatic_failure_close_success_removes_session_and_allows_immediate_reopen() {
        let failed = Arc::new(FakeConnection::default());
        failed.queue_read(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        let replacement = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![failed.clone(), replacement])),
            sink.clone(),
        );
        service
            .open(raw_endpoint("automatic-reopen"), "open-failed")
            .unwrap();
        sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Closed,
                        ..
                    })
                )
            })
        });

        let statuses = sink.statuses("automatic-reopen");
        let terminal: Vec<_> = statuses
            .iter()
            .filter(|status| matches!(status.status, SerialStatus::Error | SerialStatus::Closed))
            .collect();
        assert_eq!(terminal.len(), 2);
        assert_eq!(terminal[0].status, SerialStatus::Error);
        assert_eq!(
            terminal[0].error.as_ref().map(|error| error.code),
            Some(SerialErrorCode::DeviceRemoved)
        );
        assert_eq!(terminal[1].status, SerialStatus::Closed);
        assert_eq!(terminal[1].error, None);
        assert_eq!(failed.state.lock().unwrap().close_calls, 1);

        service
            .open(raw_endpoint("automatic-reopen"), "open-replacement")
            .unwrap();
        service.close("automatic-reopen").unwrap();
    }

    #[test]
    fn automatic_io_failure_close_failure_stays_open_for_retry_without_closed_status() {
        let failed = Arc::new(FakeConnection::default());
        {
            let mut state = failed.state.lock().unwrap();
            state.close_failures = 1;
            state.reads.push_back(Err(io::Error::other("read failed")));
        }
        let replacement = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![failed.clone(), replacement])),
            sink.clone(),
        );
        service
            .open(raw_endpoint("automatic-retry"), "open-failed")
            .unwrap();
        sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Error,
                        ..
                    })
                )
            })
        });

        let statuses = sink.statuses("automatic-retry");
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Error)
                .count(),
            1
        );
        assert_eq!(
            statuses
                .iter()
                .find(|status| status.status == SerialStatus::Error)
                .and_then(|status| status.error.as_ref())
                .map(|error| error.code),
            Some(SerialErrorCode::IoError)
        );
        assert_eq!(
            statuses
                .iter()
                .find(|status| status.status == SerialStatus::Error)
                .and_then(|status| status.error.as_ref())
                .map(|error| error.message.as_str()),
            Some("read failed; automatic close failed: close failed")
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            0
        );
        assert_eq!(
            service
                .open(raw_endpoint("automatic-retry"), "open-too-early")
                .unwrap_err()
                .code,
            SerialErrorCode::PortBusy
        );

        service.close("automatic-retry").unwrap();
        assert_eq!(failed.state.lock().unwrap().close_calls, 2);
        assert_eq!(
            sink.statuses("automatic-retry")
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            1
        );
        service
            .open(raw_endpoint("automatic-retry"), "open-replacement")
            .unwrap();
        service.close("automatic-retry").unwrap();
    }

    #[test]
    fn device_removed_remains_primary_when_automatic_close_fails() {
        let failed = Arc::new(FakeConnection::default());
        {
            let mut state = failed.state.lock().unwrap();
            state.close_failures = 1;
            state
                .reads
                .push_back(Err(io::Error::from(io::ErrorKind::BrokenPipe)));
        }
        let sink = Arc::new(RecordingSink::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![failed.clone()])),
            sink.clone(),
        );
        service
            .open(
                raw_endpoint("removed-close-retry"),
                "open-removed-close-retry",
            )
            .unwrap();
        sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Error,
                        ..
                    })
                )
            })
        });

        let statuses = sink.statuses("removed-close-retry");
        let failure = statuses
            .iter()
            .find(|status| status.status == SerialStatus::Error)
            .expect("device removal error status");
        assert_eq!(
            failure.error.as_ref().map(|error| error.code),
            Some(SerialErrorCode::DeviceRemoved)
        );
        assert!(failure.error.as_ref().is_some_and(|error| error
            .message
            .contains("automatic close failed: close failed")));
        assert_eq!(
            failure
                .log
                .as_ref()
                .map(|log| (log.level, log.code.as_deref())),
            Some(("warn", Some("DEVICE_REMOVED")))
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            0
        );

        service.close("removed-close-retry").unwrap();
        let terminal = sink.statuses("removed-close-retry");
        assert_eq!(
            terminal
                .iter()
                .filter(|status| status.status == SerialStatus::Error)
                .count(),
            1
        );
        let closed: Vec<_> = terminal
            .iter()
            .filter(|status| status.status == SerialStatus::Closed)
            .collect();
        assert_eq!(closed.len(), 1);
        assert_eq!(closed[0].log, None);
        assert_eq!(failed.state.lock().unwrap().close_calls, 2);
    }

    #[test]
    fn failed_close_is_retained_and_retry_has_single_close_owner() {
        let connection = Arc::new(FakeConnection::default());
        connection.state.lock().unwrap().close_failures = 1;
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        service.open(raw_endpoint("retry"), "open-retry").unwrap();
        assert_eq!(
            service.close("retry").unwrap_err().code,
            SerialErrorCode::IoError
        );
        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
        service.close("retry").unwrap();
        assert_eq!(connection.state.lock().unwrap().close_calls, 2);
        service.shutdown().unwrap();
    }

    #[test]
    fn reader_join_failure_reports_error_without_closed_and_remains_retryable() {
        let failed = Arc::new(FakeConnection::default());
        failed.state.lock().unwrap().read_panics = 1;
        let read_gate = Arc::new(OpenGate::default());
        *failed.read_gate.lock().unwrap() = Some(read_gate.clone());
        let replacement = Arc::new(FakeConnection::default());
        let sink = Arc::new(RecordingSink::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![failed.clone(), replacement])),
            sink.clone(),
        );
        service
            .open(raw_endpoint("reader-panic"), "open-reader-panic")
            .unwrap();
        read_gate.wait_until_entered();
        read_gate.release();

        assert_eq!(
            service.close("reader-panic").unwrap_err().code,
            SerialErrorCode::IoError
        );
        let statuses = sink.statuses("reader-panic");
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Error)
                .count(),
            1
        );
        assert_eq!(
            statuses
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            0
        );
        assert_eq!(failed.state.lock().unwrap().close_calls, 0);

        service.close("reader-panic").unwrap();
        assert_eq!(failed.state.lock().unwrap().close_calls, 1);
        assert_eq!(
            sink.statuses("reader-panic")
                .iter()
                .filter(|status| status.status == SerialStatus::Closed)
                .count(),
            1
        );
        service
            .open(raw_endpoint("reader-panic"), "open-replacement")
            .unwrap();
        service.close("reader-panic").unwrap();
    }

    #[test]
    fn shutdown_retries_a_retained_close_failure_before_returning() {
        let connection = Arc::new(FakeConnection::default());
        connection.state.lock().unwrap().close_failures = 1;
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        service
            .open(raw_endpoint("shutdown-retry"), "open-shutdown-retry")
            .unwrap();
        service.shutdown().unwrap();
        assert_eq!(connection.state.lock().unwrap().close_calls, 2);
    }

    #[test]
    fn shutdown_cannot_pass_an_open_inside_the_reservation_boundary() {
        let connection = Arc::new(FakeConnection::default());
        let backend_open = Arc::new(OpenGate::default());
        let mut backend = FakeBackend::new(vec![connection.clone()]);
        backend.gate = Some(backend_open.clone());
        let service = service(Arc::new(backend), Arc::new(RecordingSink::default()));
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let reservation_release = Arc::new(OpenGate::default());
        let hook_release = reservation_release.clone();
        service.set_before_open_reservation(Arc::new(move || {
            entered_tx.send(()).unwrap();
            hook_release.wait();
        }));

        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("reservation-race"), "open-race")
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let shutdown_service = service.clone();
        let (shutdown, shutdown_results) = spawn_result(move || shutdown_service.shutdown());
        assert!(matches!(
            shutdown_results.try_recv(),
            Err(std::sync::mpsc::TryRecvError::Empty)
        ));

        reservation_release.release();
        service.wait_until_stopped();
        backend_open.release();
        let _ = finish_worker(opening, open_results);
        finish_worker(shutdown, shutdown_results).unwrap();

        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
        assert_eq!(
            service
                .open(raw_endpoint("after-shutdown"), "open-after-shutdown")
                .unwrap_err()
                .code,
            SerialErrorCode::IoError
        );
    }

    #[test]
    fn shutdown_during_open_completion_cannot_return_a_closed_session_as_open() {
        let connection = Arc::new(FakeConnection::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let completion_release = Arc::new(OpenGate::default());
        let hook_release = completion_release.clone();
        service.set_before_open_completion(Arc::new(move || {
            entered_tx.send(()).unwrap();
            hook_release.wait();
        }));
        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("completion-race"), "open-completion-race")
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        let shutdown_service = service.clone();
        let (shutdown, shutdown_results) = spawn_result(move || shutdown_service.shutdown());
        service.wait_until_stopped();
        completion_release.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        finish_worker(shutdown, shutdown_results).unwrap();
        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
    }

    #[test]
    fn shutdown_wakes_and_retries_when_late_open_cleanup_close_fails() {
        let connection = Arc::new(FakeConnection::default());
        connection.state.lock().unwrap().close_failures = 1;
        let backend_open = Arc::new(OpenGate::default());
        let mut backend = FakeBackend::new(vec![connection.clone()]);
        backend.gate = Some(backend_open.clone());
        let service = service(Arc::new(backend), Arc::new(RecordingSink::default()));
        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("late-close-retry"), "open-late-close-retry")
        });
        backend_open.wait_until_entered();

        let shutdown_service = service.clone();
        let (shutdown, shutdown_results) = spawn_result(move || shutdown_service.shutdown());
        service.wait_until_stopped();
        backend_open.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        finish_worker(shutdown, shutdown_results).unwrap();
        assert_eq!(connection.state.lock().unwrap().close_calls, 2);
        assert!(service.session("late-close-retry").unwrap().is_none());
    }

    #[test]
    fn force_shutdown_calls_force_close_after_close_owner_deadline() {
        let connection = Arc::new(FakeConnection::default());
        connection.queue_read(Err(io::Error::other("read failed")));
        let close_gate = Arc::new(OpenGate::default());
        *connection.close_gate.lock().unwrap() = Some(close_gate.clone());
        let sink = Arc::new(RecordingSink::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            sink.clone(),
        );
        service
            .open(raw_endpoint("force-close-owner"), "open-force-close-owner")
            .unwrap();
        close_gate.wait_until_entered();

        let started = std::time::Instant::now();
        let process_exit_fallback = service.force_shutdown();

        assert!(process_exit_fallback.is_empty());
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(connection.state.lock().unwrap().max_active_closes, 2);
        assert_eq!(connection.state.lock().unwrap().force_close_calls, 1);
        assert!(service.session("force-close-owner").unwrap().is_none());
        close_gate.release();
        sink.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        status: SerialStatus::Error,
                        ..
                    })
                )
            })
        });
        assert_eq!(connection.state.lock().unwrap().close_calls, 2);
    }

    #[test]
    fn force_shutdown_calls_force_close_after_write_owner_deadline() {
        let connection = Arc::new(FakeConnection::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        service
            .open(raw_endpoint("force-write-owner"), "open-force-write-owner")
            .unwrap();
        let session = service.session("force-write-owner").unwrap().unwrap();
        let _write_owner = session.write_owner.lock().unwrap();

        let started = std::time::Instant::now();
        let process_exit_fallback = service.force_shutdown();

        assert!(process_exit_fallback.is_empty());
        assert!(started.elapsed() < Duration::from_millis(500));
        assert_eq!(connection.state.lock().unwrap().force_close_calls, 1);
        assert!(service.session("force-write-owner").unwrap().is_none());
    }

    #[test]
    fn force_shutdown_reports_handles_left_for_process_exit_fallback() {
        let connection = Arc::new(FakeConnection::default());
        connection.state.lock().unwrap().force_close_failures = 1;
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        service
            .open(raw_endpoint("force-fallback"), "open-force-fallback")
            .unwrap();

        let process_exit_fallback = service.force_shutdown();

        assert_eq!(connection.state.lock().unwrap().force_close_calls, 1);
        assert_eq!(process_exit_fallback.len(), 1);
        assert!(process_exit_fallback[0].contains("force-fallback"));
        assert!(service.session("force-fallback").unwrap().is_some());
    }

    #[test]
    fn force_shutdown_removes_and_force_closes_known_sessions() {
        let connection = Arc::new(FakeConnection::default());
        connection.state.lock().unwrap().close_failures = 10;
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        service.open(raw_endpoint("forced"), "open-forced").unwrap();

        service.force_shutdown();

        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
        assert!(service.session("forced").unwrap().is_none());
        assert_eq!(
            service
                .open(raw_endpoint("forced-new"), "open-after-force")
                .unwrap_err()
                .code,
            SerialErrorCode::IoError
        );
    }

    #[test]
    fn force_shutdown_makes_a_late_open_force_close_its_returned_connection() {
        let connection = Arc::new(FakeConnection::default());
        connection.state.lock().unwrap().close_failures = 10;
        let backend_open = Arc::new(OpenGate::default());
        let mut backend = FakeBackend::new(vec![connection.clone()]);
        backend.gate = Some(backend_open.clone());
        let backend = Arc::new(backend);
        let service = service(backend.clone(), Arc::new(RecordingSink::default()));
        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("forced-late"), "open-forced-late")
        });
        backend_open.wait_until_entered();

        let process_exit_fallback = service.force_shutdown();
        assert_eq!(process_exit_fallback.len(), 1);
        assert!(process_exit_fallback[0].contains("forced-late"));
        assert!(service.session("forced-late").unwrap().is_some());
        backend_open.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
        assert!(service.session("forced-late").unwrap().is_none());
    }

    #[test]
    fn force_shutdown_during_open_completion_has_one_close_owner() {
        let connection = Arc::new(FakeConnection::default());
        let service = service(
            Arc::new(FakeBackend::new(vec![connection.clone()])),
            Arc::new(RecordingSink::default()),
        );
        let (entered_tx, entered_rx) = std::sync::mpsc::sync_channel(1);
        let completion_release = Arc::new(OpenGate::default());
        let hook_release = completion_release.clone();
        service.set_before_open_completion(Arc::new(move || {
            entered_tx.send(()).unwrap();
            hook_release.wait();
        }));
        let opening_service = service.clone();
        let (opening, open_results) = spawn_result(move || {
            opening_service.open(raw_endpoint("force-completion"), "open-force-completion")
        });
        entered_rx.recv_timeout(Duration::from_secs(1)).unwrap();

        service.force_shutdown();
        completion_release.release();

        assert_eq!(
            finish_worker(opening, open_results).unwrap_err().code,
            SerialErrorCode::OpenCancelled
        );
        assert_eq!(connection.state.lock().unwrap().close_calls, 1);
        assert!(service.session("force-completion").unwrap().is_none());
    }

    #[test]
    #[ignore = "requires INEED_PHASE03_SERVICE_PTY from an isolated socat pair"]
    fn idle_native_serial_reads_do_not_starve_outbound_writes() {
        let path = std::env::var("INEED_PHASE03_SERVICE_PTY").unwrap();
        let config = real_endpoint("idle-reader", &path, ReceiveFraming::Raw).config;
        let connection = RealSerialBackend.open(&config).unwrap();
        let stop = Arc::new(AtomicBool::new(false));
        let reader_connection = connection.clone();
        let reader_stop = stop.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let reader = std::thread::spawn(move || {
            ready_tx.send(()).unwrap();
            let mut buffer = [0; 256];
            while !reader_stop.load(Ordering::SeqCst) {
                let _ = reader_connection.read(&mut buffer);
            }
        });
        ready_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        std::thread::sleep(Duration::from_millis(10));
        let mut durations = Vec::new();
        for _ in 0..20 {
            let started = Instant::now();
            connection.write_all(&[0x42]).unwrap();
            durations.push(started.elapsed().as_millis());
            if durations.last().copied().unwrap() > 500 {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        stop.store(true, Ordering::SeqCst);
        reader.join().unwrap();
        connection.close().unwrap();
        assert_eq!(
            connection.read(&mut [0; 1]).unwrap_err().kind(),
            io::ErrorKind::NotConnected
        );
        assert_eq!(
            connection.write_all(&[0x42]).unwrap_err().kind(),
            io::ErrorKind::NotConnected
        );
        connection.close().unwrap();
        assert!(connection.force_close());
        println!("IDLE_SERIAL_WRITE_LATENCIES_MS={durations:?}");
        assert!(
            durations.iter().all(|duration| *duration <= 500),
            "An idle serial reader starved a ready writer: {durations:?}"
        );
    }

    #[test]
    #[ignore = "requires env-provided socat PTYs; run through tooling/serial-test/pty-loopback.mjs"]
    fn real_pty_transport_contract() {
        let service_path = std::env::var("INEED_PHASE03_SERVICE_PTY")
            .expect("INEED_PHASE03_SERVICE_PTY must name the production service PTY");
        let peer_path = std::env::var("INEED_PHASE03_PEER_PTY")
            .expect("INEED_PHASE03_PEER_PTY must name the peer PTY");
        let socat_pid = std::env::var("INEED_PHASE03_SOCAT_PID")
            .expect("INEED_PHASE03_SOCAT_PID must identify the owning socat process");
        let started_at = Instant::now();
        let database_directory = std::env::temp_dir().join(format!(
            "ineed-phase03-tauri-history-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&database_directory).unwrap();
        let database = Arc::new(
            ConfigurationDatabase::open(database_directory.join("history.sqlite")).unwrap(),
        );
        database
            .insert_serial_endpoint_for_test("pty-history-01")
            .unwrap();
        let persistence = Arc::new(TransportPersistence::new(database.clone()));
        let observed = Arc::new(RecordingSink::default());
        let sink = Arc::new(PersistingRecordingSink {
            endpoint_id: "pty-history-01".into(),
            persistence: persistence.clone(),
            observed: observed.clone(),
        });
        let service = Arc::new(SerialService::new(
            Arc::new(RealSerialBackend),
            sink.clone(),
        ));
        let _cleanup = PtyHistoryCleanup {
            directory: database_directory,
            service: Some(service.clone()),
            persistence: Some(persistence.clone()),
            sink: Some(sink.clone()),
            database: Some(database.clone()),
        };
        let mut peer = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(&peer_path)
            .expect("open real peer PTY file descriptor");
        let mut tx_bytes = 0_usize;
        let mut rx_bytes = 0_usize;

        let raw = real_endpoint("pty-raw", &service_path, ReceiveFraming::Raw);
        let opened = service.open(raw, "open-pty-raw").unwrap();
        assert_eq!(
            service
                .send_for_session("pty-raw", &[0x68], Some("expired-simulator-session"))
                .unwrap_err()
                .code,
            SerialErrorCode::OpenCancelled
        );
        let text_bytes = "TEXT:你好\n".as_bytes().to_vec();
        let hex_bytes = vec![0x00, 0x10, 0x7f, 0x80, 0xff];
        let json_bytes = br#"{"phase":3,"runtime":"tauri"}"#.to_vec();
        let outbound = [text_bytes, hex_bytes, json_bytes];
        let expected_outbound = outbound.concat();
        let batch_started_at = Instant::now();
        for bytes in &outbound {
            assert_eq!(
                service
                    .send_for_session("pty-raw", bytes, Some(&opened.session_id))
                    .unwrap()
                    .sent,
                bytes.len()
            );
            tx_bytes += bytes.len();
        }
        let mut peer_received = vec![0_u8; expected_outbound.len()];
        peer.read_exact(&mut peer_received).unwrap();
        assert_eq!(peer_received, expected_outbound);
        wait_for_frame_count(&observed, "pty-raw", "out", 3);
        let batch_delay_ms = batch_started_at.elapsed().as_millis() as u64;
        assert!(
            (150..2_000).contains(&batch_delay_ms),
            "Tauri frame batch delay was {batch_delay_ms} ms"
        );
        assert_eq!(frames_for(&observed, "pty-raw", "out"), outbound);

        peer.write_all(&expected_outbound).unwrap();
        peer.flush().unwrap();
        rx_bytes += expected_outbound.len();
        wait_for_frame_bytes(&observed, "pty-raw", "in", expected_outbound.len());
        assert_eq!(
            frames_for(&observed, "pty-raw", "in").concat(),
            expected_outbound
        );
        let raw_frames = frames_for(&observed, "pty-raw", "in").len();
        service.close("pty-raw").unwrap();
        assert!(service.session("pty-raw").unwrap().is_none());

        let history_outbound = vec![vec![0x10, 0x11], vec![0x20, 0x21, 0x22]];
        let history_inbound = vec![vec![1, 2, 3, 4], vec![5, 6, 7, 8]];
        service
            .open(
                real_endpoint("pty-history-01", &service_path, ReceiveFraming::Fixed(4)),
                "open-pty-history-01",
            )
            .unwrap();
        for bytes in &history_outbound {
            assert_eq!(
                service.send("pty-history-01", bytes).unwrap().sent,
                bytes.len()
            );
        }
        let expected_history_outbound = history_outbound.concat();
        let mut peer_received = vec![0_u8; expected_history_outbound.len()];
        peer.read_exact(&mut peer_received).unwrap();
        assert_eq!(peer_received, expected_history_outbound);
        wait_for_frame_count(&observed, "pty-history-01", "out", history_outbound.len());
        peer.write_all(&history_inbound.concat()).unwrap();
        peer.flush().unwrap();
        wait_for_frame_count(&observed, "pty-history-01", "in", history_inbound.len());
        service.close("pty-history-01").unwrap();
        persistence.flush().unwrap();
        let history = assert_tauri_persisted_history(
            database.as_ref(),
            observed.as_ref(),
            &history_outbound,
            &history_inbound,
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_millis() as i64
                + 60_000,
        );

        service
            .open(
                real_endpoint(
                    "pty-delimiter",
                    &service_path,
                    ReceiveFraming::Delimiter(vec![b'\r', b'\n']),
                ),
                "open-pty-delimiter",
            )
            .unwrap();
        peer.write_all(b"alpha\r").unwrap();
        peer.flush().unwrap();
        thread::sleep(Duration::from_millis(30));
        peer.write_all(b"\nbeta\r\n").unwrap();
        peer.flush().unwrap();
        rx_bytes += 13;
        wait_for_frame_count(&observed, "pty-delimiter", "in", 2);
        assert_eq!(
            frames_for(&observed, "pty-delimiter", "in"),
            vec![b"alpha".to_vec(), b"beta".to_vec()]
        );
        service.close("pty-delimiter").unwrap();
        assert!(service.session("pty-delimiter").unwrap().is_none());

        service
            .open(
                real_endpoint("pty-fixed", &service_path, ReceiveFraming::Fixed(4)),
                "open-pty-fixed",
            )
            .unwrap();
        let fixed = (1_u8..=12).collect::<Vec<_>>();
        peer.write_all(&fixed).unwrap();
        peer.flush().unwrap();
        rx_bytes += fixed.len();
        wait_for_frame_count(&observed, "pty-fixed", "in", 3);
        assert_eq!(
            frames_for(&observed, "pty-fixed", "in"),
            vec![
                fixed[0..4].to_vec(),
                fixed[4..8].to_vec(),
                fixed[8..12].to_vec()
            ]
        );
        service.close("pty-fixed").unwrap();
        assert!(service.session("pty-fixed").unwrap().is_none());

        service
            .open(
                real_endpoint(
                    "pty-idle",
                    &service_path,
                    ReceiveFraming::Idle(Duration::from_millis(90)),
                ),
                "open-pty-idle",
            )
            .unwrap();
        peer.write_all(b"AB").unwrap();
        peer.flush().unwrap();
        thread::sleep(Duration::from_millis(40));
        assert!(frames_for(&observed, "pty-idle", "in").is_empty());
        let idle_started_at = Instant::now();
        peer.write_all(b"CD").unwrap();
        peer.flush().unwrap();
        rx_bytes += 4;
        wait_for_frame_count(&observed, "pty-idle", "in", 1);
        let idle_delay_ms = idle_started_at.elapsed().as_millis() as u64;
        assert!(
            idle_delay_ms >= 70,
            "Tauri idle frame emitted after only {idle_delay_ms} ms"
        );
        assert_eq!(
            frames_for(&observed, "pty-idle", "in"),
            vec![b"ABCD".to_vec()]
        );
        service.close("pty-idle").unwrap();
        assert!(service.session("pty-idle").unwrap().is_none());

        service
            .open(
                real_endpoint("pty-removed", &service_path, ReceiveFraming::Raw),
                "open-pty-removed",
            )
            .unwrap();
        let killed = std::process::Command::new("kill")
            .args(["-TERM", &socat_pid])
            .status()
            .expect("terminate socat for device-removal verification");
        assert!(killed.success());
        observed.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        endpoint_id,
                        status: SerialStatus::Error,
                        ..
                    }) if endpoint_id == "pty-removed"
                )
            })
        });
        let removal_error = observed
            .statuses("pty-removed")
            .into_iter()
            .find(|event| event.status == SerialStatus::Error)
            .and_then(|event| event.error)
            .expect("device removal must include an error");
        assert_eq!(
            removal_error.code,
            SerialErrorCode::DeviceRemoved,
            "Tauri removal mapped to {removal_error:?}"
        );
        observed.wait_for(|events| {
            events.iter().any(|event| {
                matches!(
                    event,
                    SerialEvent::Status(StatusEvent {
                        endpoint_id,
                        status: SerialStatus::Closed,
                        ..
                    }) if endpoint_id == "pty-removed"
                )
            })
        });
        thread::sleep(Duration::from_millis(100));
        let terminal = observed
            .statuses("pty-removed")
            .into_iter()
            .filter(|event| matches!(event.status, SerialStatus::Error | SerialStatus::Closed))
            .collect::<Vec<_>>();
        assert_eq!(
            terminal
                .iter()
                .filter(|event| event.status == SerialStatus::Error)
                .count(),
            1
        );
        assert_eq!(
            terminal
                .iter()
                .filter(|event| event.status == SerialStatus::Closed)
                .count(),
            1
        );
        assert_eq!(
            terminal
                .iter()
                .map(|event| (event.status, event.error.as_ref().map(|error| error.code)))
                .collect::<Vec<_>>(),
            vec![
                (SerialStatus::Error, Some(SerialErrorCode::DeviceRemoved)),
                (SerialStatus::Closed, None)
            ]
        );
        assert!(service.session("pty-removed").unwrap().is_none());
        service.shutdown().unwrap();
        persistence.shutdown().unwrap();

        println!(
            "PHASE03_TAURI_RESULT={}",
            serde_json::json!({
                "runtime": "tauri",
                "servicePort": service_path,
                "peerPort": peer_path,
                "txBytes": tx_bytes,
                "rxBytes": rx_bytes,
                "framing": {
                    "raw": { "frames": raw_frames, "bytes": expected_outbound.len() },
                    "delimiter": { "frames": 2, "bytes": 13, "crossChunk": true },
                    "fixed": { "frames": 3, "bytes": fixed.len() },
                    "idle": { "frames": 1, "bytes": 4, "idleDelayMs": idle_delay_ms }
                },
                "batchDelayMs": batch_delay_ms,
                "removalError": "DEVICE_REMOVED",
                "terminalErrors": 1,
                "terminalClosed": 1,
                "closedAfterRemoval": true,
                "resourcesClean": true,
                "history": history,
                "durationMs": started_at.elapsed().as_millis() as u64
            })
        );
    }

    fn assert_tauri_persisted_history(
        database: &ConfigurationDatabase,
        observed: &RecordingSink,
        outbound: &[Vec<u8>],
        inbound: &[Vec<u8>],
        latest_epoch_millis: i64,
    ) -> serde_json::Value {
        const MIN_RUNTIME_HISTORY_TIMESTAMP: i64 = 1_000_000_000_000;
        let query: crate::database::HistoryQuery =
            serde_json::from_value(serde_json::json!({ "page": 1, "pageSize": 200 })).unwrap();
        let frame_page =
            serde_json::to_value(database.query_frames(query.clone()).unwrap()).unwrap();
        let log_page = serde_json::to_value(database.query_logs(query).unwrap()).unwrap();
        let input_frames = outbound
            .iter()
            .map(|bytes| ("out", bytes))
            .chain(inbound.iter().map(|bytes| ("in", bytes)))
            .collect::<Vec<_>>();
        let events = observed.events.lock().unwrap().clone();
        let event_frames = events
            .iter()
            .filter_map(|event| match event {
                SerialEvent::Frames(batch) if batch.endpoint_id == "pty-history-01" => Some(
                    batch
                        .frames
                        .iter()
                        .map(|frame| (frame.direction, &frame.bytes, frame.created_at)),
                ),
                _ => None,
            })
            .flatten()
            .collect::<Vec<_>>();
        assert_eq!(event_frames.len(), input_frames.len());
        for ((direction, bytes, _), (expected_direction, expected_bytes)) in
            event_frames.iter().zip(input_frames.iter())
        {
            assert_eq!(direction, expected_direction);
            assert_eq!(bytes, expected_bytes);
        }
        let event_logs = events
            .iter()
            .filter_map(|event| match event {
                SerialEvent::Status(status) if status.endpoint_id == "pty-history-01" => {
                    let log = status.log.as_ref()?;
                    assert_eq!(
                        log.created_at, status.created_at,
                        "serial status log timestamp must match its owning status event timestamp"
                    );
                    Some((
                        log.level,
                        log.source,
                        &log.message,
                        log.created_at,
                        status.created_at,
                    ))
                }
                _ => None,
            })
            .collect::<Vec<_>>();
        assert_eq!(frame_page["total"], serde_json::json!(input_frames.len()));
        let frames = frame_page["rows"].as_array().unwrap();
        assert_eq!(frames.len(), input_frames.len());
        for ((frame, (direction, bytes)), (_, _, created_at)) in frames
            .iter()
            .rev()
            .zip(input_frames.iter())
            .zip(event_frames.iter())
        {
            assert_eq!(frame["direction"], *direction);
            assert_eq!(
                BASE64
                    .decode(frame["payloadBase64"].as_str().unwrap())
                    .unwrap(),
                **bytes
            );
            assert_eq!(frame["byteCount"], serde_json::json!(bytes.len()));
            assert_eq!(frame["createdAt"], serde_json::json!(created_at));
            assert!(frame["createdAt"].as_i64().is_some_and(|value| {
                (MIN_RUNTIME_HISTORY_TIMESTAMP..=latest_epoch_millis).contains(&value)
            }));
        }
        assert_eq!(log_page["total"], serde_json::json!(4));
        let logs = log_page["rows"].as_array().unwrap();
        assert_eq!(logs.len(), 4);
        assert_eq!(event_logs.len(), logs.len());
        assert!(logs
            .iter()
            .any(|log| log["level"] == "info" && log["source"] == "serial"));
        assert!(logs.iter().any(|log| log["message"]
            .as_str()
            .is_some_and(|message| message.starts_with("串口已关闭:"))));
        for ((log, (level, source, message, log_created_at, status_created_at)), expected_level) in
            logs.iter()
                .rev()
                .zip(event_logs.iter())
                .zip(["debug", "info", "debug", "info"])
        {
            assert_eq!(log["level"], *level);
            assert_eq!(log["level"], expected_level);
            assert_eq!(log["source"], *source);
            assert_eq!(log["message"].as_str(), Some(message.as_str()));
            assert_eq!(log_created_at, status_created_at);
            assert_eq!(log["createdAt"], serde_json::json!(log_created_at));
            assert!(log["createdAt"]
                .as_i64()
                .is_some_and(
                    |value| (MIN_RUNTIME_HISTORY_TIMESTAMP..=latest_epoch_millis).contains(&value)
                ));
        }
        let actual_frames = frames
            .iter()
            .rev()
            .map(|frame| {
                serde_json::json!({
                    "direction": frame["direction"],
                    "bytes": BASE64.decode(frame["payloadBase64"].as_str().unwrap()).unwrap(),
                })
            })
            .collect::<Vec<_>>();
        serde_json::json!({
            "frames": { "total": frames.len(),
                "inbound": frames.iter().filter(|frame| frame["direction"] == "in").count(),
                "outbound": frames.iter().filter(|frame| frame["direction"] == "out").count(),
                "createdAt": frames.iter().rev().map(|frame| frame["createdAt"].clone()).collect::<Vec<_>>(),
                "payloads": actual_frames },
            "logs": { "total": logs.len(),
                "infoSerial": logs.iter().filter(|log| log["level"] == "info" && log["source"] == "serial").count(),
                "createdAt": logs.iter().rev().map(|log| log["createdAt"].clone()).collect::<Vec<_>>() }
        })
    }

    #[test]
    fn pty_history_cleanup_removes_temp_directory_during_unwind() {
        let directory = std::env::temp_dir().join(format!(
            "ineed-phase03-cleanup-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos(),
        ));
        std::fs::create_dir_all(&directory).unwrap();
        let result = std::panic::catch_unwind({
            let directory = directory.clone();
            move || {
                let _cleanup = PtyHistoryCleanup {
                    directory,
                    service: None,
                    persistence: None,
                    sink: None,
                    database: None,
                };
                panic!("injected PTY history failure");
            }
        });
        assert!(result.is_err());
        assert!(!directory.exists());
    }

    fn real_endpoint(id: &str, path: &str, framing: ReceiveFraming) -> SerialEndpoint {
        SerialEndpoint {
            endpoint_id: id.to_owned(),
            config: SerialConfig {
                path: path.to_owned(),
                baud_rate: 115_200,
                data_bits: DataBits::Eight,
                parity: Parity::None,
                stop_bits: StopBits::One,
                flow_control: FlowControl::None,
                receive_framing: framing,
            },
        }
    }

    fn frames_for(sink: &RecordingSink, endpoint_id: &str, direction: &str) -> Vec<Vec<u8>> {
        frames_from_events(&sink.events.lock().unwrap(), endpoint_id, direction)
    }

    fn frames_from_events(
        events: &[SerialEvent],
        endpoint_id: &str,
        direction: &str,
    ) -> Vec<Vec<u8>> {
        events
            .iter()
            .filter_map(|event| match event {
                SerialEvent::Frames(batch) if batch.endpoint_id == endpoint_id => {
                    Some(batch.frames.iter())
                }
                _ => None,
            })
            .flatten()
            .filter(|frame| frame.direction == direction)
            .map(|frame| frame.bytes.clone())
            .collect()
    }

    fn wait_for_frame_count(
        sink: &RecordingSink,
        endpoint_id: &str,
        direction: &str,
        expected: usize,
    ) {
        sink.wait_for(|events| {
            frames_from_events(events, endpoint_id, direction).len() == expected
        });
    }

    fn wait_for_frame_bytes(
        sink: &RecordingSink,
        endpoint_id: &str,
        direction: &str,
        expected: usize,
    ) {
        sink.wait_for(|events| {
            frames_from_events(events, endpoint_id, direction)
                .iter()
                .map(Vec::len)
                .sum::<usize>()
                == expected
        });
    }
}
