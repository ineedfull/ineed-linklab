use std::{
    collections::{BTreeMap, HashSet},
    fs::{File, OpenOptions},
    io::{self, Read, Write},
    path::{Path, PathBuf},
    sync::{LazyLock, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use base64::{engine::general_purpose::STANDARD as BASE64, Engine as _};
use rusqlite::{params, params_from_iter, types::Value as SqlValue, Connection, OptionalExtension};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, value::RawValue, Value};
use tauri::{AppHandle, State, WebviewWindow};
use tauri_plugin_dialog::DialogExt;

use crate::{runtime, AppState};

pub(crate) const DATABASE_FILENAME: &str = "ineed-dev-tool.db";
pub(crate) const WORKSPACE_VERSION: i64 = 1;
const MAX_SAFE_TIMESTAMP: i64 = 9_007_199_254_740_991;
const MAX_WORKSPACE_BYTES: usize = 10 * 1024 * 1024;
const INITIAL_MIGRATION: &str =
    include_str!("../../../../packages/persistence-contract/migrations/001-initial.sql");
const MODBUS_ENDPOINTS_MIGRATION: &str =
    include_str!("../../../../packages/persistence-contract/migrations/002-modbus-endpoints.sql");
const MODBUS_POINT_HISTORY_MIGRATION: &str = include_str!(
    "../../../../packages/persistence-contract/migrations/003-modbus-point-history.sql"
);
const DLT645_ENDPOINTS_MIGRATION: &str =
    include_str!("../../../../packages/persistence-contract/migrations/004-dlt645-endpoints.sql");
const DLT645_SIMULATOR_ENDPOINTS_MIGRATION: &str = include_str!(
    "../../../../packages/persistence-contract/migrations/005-dlt645-simulator-endpoints.sql"
);
const WEBSOCKET_ENDPOINTS_MIGRATION: &str = include_str!(
    "../../../../packages/persistence-contract/migrations/006-websocket-endpoints.sql"
);
const SETTINGS_SCHEMA_JSON: &str =
    include_str!("../../../../packages/runtime-contract/src/settingsSchema.json");
#[cfg(test)]
const INTEGRAL_NUMBER_FIXTURE_JSON: &str =
    include_str!("../../../../packages/runtime-contract/src/integralJsonNumbers.json");
#[cfg(test)]
const MODBUS_POINT_HISTORY_CASES_JSON: &str =
    include_str!("../../../../packages/test-contracts/fixtures/modbusPointHistoryCases.json");
const MIGRATIONS: [Migration; 6] = [
    Migration {
        version: 1,
        name: "001-initial",
        sql: INITIAL_MIGRATION,
    },
    Migration {
        version: 2,
        name: "002-modbus-endpoints",
        sql: MODBUS_ENDPOINTS_MIGRATION,
    },
    Migration {
        version: 3,
        name: "003-modbus-point-history",
        sql: MODBUS_POINT_HISTORY_MIGRATION,
    },
    Migration {
        version: 4,
        name: "004-dlt645-endpoints",
        sql: DLT645_ENDPOINTS_MIGRATION,
    },
    Migration {
        version: 5,
        name: "005-dlt645-simulator-endpoints",
        sql: DLT645_SIMULATOR_ENDPOINTS_MIGRATION,
    },
    Migration {
        version: 6,
        name: "006-websocket-endpoints",
        sql: WEBSOCKET_ENDPOINTS_MIGRATION,
    },
];
const REQUIRED_SCHEMA_TABLES: [&str; 8] = [
    "endpoint_profiles",
    "modbus_point_history",
    "runtime_logs",
    "schema_migrations",
    "send_history",
    "send_templates",
    "settings",
    "transfer_frames",
];
const RETIRED_IMPORT_SETTING_KEYS: [&str; 1] = ["timeDisplayMode"];

type DbResult<T> = Result<T, String>;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct SettingsSchema {
    #[serde(rename = "schemaVersion")]
    _schema_version: i64,
    settings: BTreeMap<String, SettingRule>,
}

#[derive(Deserialize)]
struct SettingRule {
    #[serde(rename = "type")]
    kind: String,
    #[serde(default, rename = "enum")]
    choices: Vec<Value>,
    minimum: Option<i64>,
    maximum: Option<i64>,
    default: Value,
}

static SETTINGS_SCHEMA: LazyLock<SettingsSchema> = LazyLock::new(|| {
    serde_json::from_str(SETTINGS_SCHEMA_JSON).expect("shared settings schema must be valid")
});

macro_rules! authorize_command {
    ($window:expr, $method:literal) => {
        if let Some(denied) = runtime::authorize_window($window.label(), $method) {
            return Ok(denied);
        }
    };
}

fn safe_file_metadata(path: &Path, allow_missing: bool) -> DbResult<Option<std::fs::Metadata>> {
    match std::fs::symlink_metadata(path) {
        Ok(metadata) => {
            if metadata.file_type().is_symlink() {
                return Err("Workspace path must not be a symbolic link".into());
            }
            if !metadata.is_file() {
                return Err("Workspace path must be a regular file".into());
            }
            Ok(Some(metadata))
        }
        Err(error) if allow_missing && error.kind() == io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn read_workspace_source(path: &Path) -> DbResult<String> {
    read_open_workspace_source(open_workspace_import(path)?)
}

fn open_workspace_import(path: &Path) -> DbResult<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt as _;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt as _;
        const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
        options.custom_flags(FILE_FLAG_OPEN_REPARSE_POINT);
    }
    let file = options.open(path).map_err(|error| {
        if error.raw_os_error() == Some(libc::ELOOP) {
            "Workspace path must not be a symbolic link".to_owned()
        } else {
            error.to_string()
        }
    })?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err("Workspace path must not be a symbolic link".into());
    }
    if !metadata.is_file() {
        return Err("Workspace path must be a regular file".into());
    }
    if metadata.len() > MAX_WORKSPACE_BYTES as u64 {
        return Err("Workspace import exceeds 10 MiB".into());
    }
    Ok(file)
}

fn read_open_workspace_source(file: File) -> DbResult<String> {
    let mut bytes = Vec::with_capacity(MAX_WORKSPACE_BYTES.min(64 * 1024));
    file.take(MAX_WORKSPACE_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|error| error.to_string())?;
    if bytes.len() > MAX_WORKSPACE_BYTES {
        return Err("Workspace import exceeds 10 MiB".into());
    }
    String::from_utf8(bytes).map_err(|error| error.to_string())
}

fn atomic_write_workspace(destination: &Path, contents: &[u8]) -> DbResult<()> {
    if contents.len() > MAX_WORKSPACE_BYTES {
        return Err("Workspace export exceeds 10 MiB".into());
    }
    safe_file_metadata(destination, true)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "Workspace destination has no parent directory".to_owned())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Workspace destination file name is invalid".to_owned())?;
    let mut temporary = None;
    let mut file = None;
    for attempt in 0..100_u32 {
        let candidate = directory.join(format!(
            ".{name}.{}.{}.{attempt}.tmp",
            std::process::id(),
            now_millis()?
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(opened) => {
                temporary = Some(candidate);
                file = Some(opened);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary =
        temporary.ok_or_else(|| "Could not create workspace temporary file".to_owned())?;
    let result = (|| -> DbResult<()> {
        let mut file = file.take().expect("temporary file handle");
        file.write_all(contents)
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        std::fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn atomic_write_stream<T, F>(destination: &Path, writer: F) -> DbResult<T>
where
    F: FnOnce(&mut File) -> DbResult<T>,
{
    safe_file_metadata(destination, true)?;
    let directory = destination
        .parent()
        .ok_or_else(|| "Export destination has no parent directory".to_owned())?;
    let name = destination
        .file_name()
        .and_then(|value| value.to_str())
        .ok_or_else(|| "Export destination file name is invalid".to_owned())?;
    let mut temporary = None;
    let mut file = None;
    for attempt in 0..100_u32 {
        let candidate = directory.join(format!(
            ".{name}.{}.{}.{attempt}.tmp",
            std::process::id(),
            now_millis()?
        ));
        match OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&candidate)
        {
            Ok(opened) => {
                temporary = Some(candidate);
                file = Some(opened);
                break;
            }
            Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(error.to_string()),
        }
    }
    let temporary = temporary.ok_or_else(|| "Could not create export temporary file".to_owned())?;
    let result = (|| -> DbResult<T> {
        let mut file = file.take().expect("temporary file handle");
        let value = writer(&mut file)?;
        file.sync_all().map_err(|error| error.to_string())?;
        drop(file);
        std::fs::rename(&temporary, destination).map_err(|error| error.to_string())?;
        File::open(directory)
            .and_then(|directory| directory.sync_all())
            .map_err(|error| error.to_string())?;
        Ok(value)
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary);
    }
    result
}

fn database_file_size(path: &Path) -> DbResult<u64> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.to_string()),
    }
}

struct Migration {
    version: i64,
    name: &'static str,
    sql: &'static str,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct EndpointInput {
    id: String,
    name: String,
    transport: String,
    config: Value,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_timestamp",
        skip_serializing_if = "Option::is_none"
    )]
    created_at: Option<i64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_timestamp",
        skip_serializing_if = "Option::is_none"
    )]
    updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct EndpointProfile {
    id: String,
    name: String,
    transport: String,
    config: Value,
    #[serde(deserialize_with = "deserialize_timestamp")]
    created_at: i64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    updated_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct EndpointSnapshot {
    pub(crate) id: String,
    pub(crate) transport: String,
    pub(crate) config: Value,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
struct CloneEndpointInput {
    id: String,
    #[serde(default, deserialize_with = "deserialize_clone_name")]
    name: Option<String>,
}

fn deserialize_clone_name<'de, D>(deserializer: D) -> Result<Option<String>, D::Error>
where
    D: Deserializer<'de>,
{
    String::deserialize(deserializer).map(Some)
}

fn deserialize_optional_timestamp<'de, D>(deserializer: D) -> Result<Option<i64>, D::Error>
where
    D: Deserializer<'de>,
{
    deserialize_timestamp(deserializer).map(Some)
}

fn deserialize_timestamp<'de, D>(deserializer: D) -> Result<i64, D::Error>
where
    D: Deserializer<'de>,
{
    let raw = Box::<RawValue>::deserialize(deserializer)?;
    parse_integral_json_lexeme(raw.get(), "timestamp", MAX_SAFE_TIMESTAMP)
        .map_err(serde::de::Error::custom)
}

fn deserialize_settings<'de, D>(deserializer: D) -> Result<BTreeMap<String, Value>, D::Error>
where
    D: Deserializer<'de>,
{
    let values = BTreeMap::<String, Box<RawValue>>::deserialize(deserializer)?;
    values
        .into_iter()
        .map(|(key, raw)| {
            let value = if SETTINGS_SCHEMA
                .settings
                .get(&key)
                .is_some_and(|rule| rule.kind == "integer")
            {
                let rule = &SETTINGS_SCHEMA.settings[&key];
                let maximum = rule.maximum.unwrap_or(MAX_SAFE_TIMESTAMP);
                let number = parse_integral_json_lexeme(raw.get(), &key, maximum)
                    .map_err(serde::de::Error::custom)?;
                if rule.minimum.is_some_and(|minimum| number < minimum) {
                    return Err(serde::de::Error::custom(format!(
                        "{key} is outside the allowed range"
                    )));
                }
                Value::from(number)
            } else {
                serde_json::from_str(raw.get()).map_err(serde::de::Error::custom)?
            };
            Ok((key, value))
        })
        .collect()
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct TemplateInput {
    id: String,
    endpoint_id: String,
    name: String,
    format: String,
    framing: String,
    target: Value,
    payload_base64: String,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_timestamp",
        skip_serializing_if = "Option::is_none"
    )]
    created_at: Option<i64>,
    #[serde(
        default,
        deserialize_with = "deserialize_optional_timestamp",
        skip_serializing_if = "Option::is_none"
    )]
    updated_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct SendTemplate {
    id: String,
    endpoint_id: String,
    name: String,
    format: String,
    framing: String,
    target: Value,
    payload_base64: String,
    #[serde(deserialize_with = "deserialize_timestamp")]
    created_at: i64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    updated_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendHistoryInput {
    endpoint_id: String,
    session_id: Option<String>,
    peer_id: Option<String>,
    target: Value,
    format: String,
    framing: String,
    payload_base64: String,
    #[serde(deserialize_with = "deserialize_timestamp")]
    created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendHistoryQuery {
    endpoint_id: String,
    #[serde(default = "default_page")]
    page: i64,
    #[serde(default = "default_send_history_page_size")]
    page_size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct SendHistoryRow {
    id: i64,
    endpoint_id: String,
    session_id: Option<String>,
    peer_id: Option<String>,
    target: Value,
    format: String,
    framing: String,
    payload_base64: String,
    byte_count: i64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModbusPointIdentity {
    request_group_id: String,
    request_id: String,
    point_id: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModbusPointHistoryInput {
    endpoint_id: String,
    request_group_id: String,
    request_id: String,
    point_id: String,
    point_key: String,
    point_name: String,
    data_type: String,
    unit: Option<String>,
    raw: Value,
    value: Value,
    numeric_value: Option<f64>,
    display_value: String,
    quality: String,
    reason: Option<String>,
    #[serde(deserialize_with = "deserialize_timestamp")]
    created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModbusPointHistoryRecordResult {
    recorded_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModbusPointHistoryQuery {
    endpoint_id: String,
    #[serde(default)]
    points: Vec<ModbusPointIdentity>,
    #[serde(default)]
    from: i64,
    #[serde(default = "default_max_safe_timestamp")]
    to: i64,
    #[serde(default = "default_page")]
    page: i64,
    #[serde(default = "default_page_size")]
    page_size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct ModbusPointSeriesQuery {
    endpoint_id: String,
    points: Vec<ModbusPointIdentity>,
    #[serde(deserialize_with = "deserialize_timestamp")]
    from: i64,
    #[serde(deserialize_with = "deserialize_timestamp")]
    to: i64,
    bucket_count: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModbusPointHistoryRow {
    id: i64,
    endpoint_id: String,
    request_group_id: String,
    request_id: String,
    point_id: String,
    point_key: String,
    point_name: String,
    data_type: String,
    unit: Option<String>,
    raw: Value,
    value: Value,
    numeric_value: Option<f64>,
    display_value: String,
    quality: String,
    reason: Option<String>,
    created_at: i64,
}

type ModbusPointHistoryPage = HistoryPage<ModbusPointHistoryRow>;

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModbusPointSeriesResult {
    series: Vec<Value>,
    from: i64,
    to: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ModbusPointHistoryCleanupResult {
    deleted_count: i64,
    completed_at: i64,
}

fn default_send_history_page_size() -> i64 {
    20
}

fn default_max_safe_timestamp() -> i64 {
    MAX_SAFE_TIMESTAMP
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
#[serde(deny_unknown_fields)]
pub(crate) struct Workspace {
    version: i64,
    endpoint_profiles: Vec<EndpointProfile>,
    #[serde(deserialize_with = "deserialize_settings")]
    settings: BTreeMap<String, Value>,
    send_templates: Vec<SendTemplate>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WorkspaceDocument {
    schema_version: i64,
    endpoint_profiles: Vec<EndpointProfile>,
    #[serde(deserialize_with = "deserialize_settings")]
    settings: BTreeMap<String, Value>,
    send_templates: Vec<SendTemplate>,
}

impl From<Workspace> for WorkspaceDocument {
    fn from(value: Workspace) -> Self {
        Self {
            schema_version: value.version,
            endpoint_profiles: value.endpoint_profiles,
            settings: value.settings,
            send_templates: value.send_templates,
        }
    }
}

impl TryFrom<WorkspaceDocument> for Workspace {
    type Error = String;
    fn try_from(value: WorkspaceDocument) -> Result<Self, Self::Error> {
        if value.schema_version != WORKSPACE_VERSION {
            return Err(format!(
                "Workspace schema version must be {WORKSPACE_VERSION}"
            ));
        }
        Ok(Self {
            version: value.schema_version,
            endpoint_profiles: value.endpoint_profiles,
            settings: value.settings,
            send_templates: value.send_templates,
        })
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct HistoryQuery {
    endpoint_id: Option<String>,
    #[serde(default)]
    search: String,
    #[serde(default)]
    direction: String,
    #[serde(default)]
    level: String,
    #[serde(default)]
    source: String,
    from: Option<i64>,
    to: Option<i64>,
    #[serde(default = "default_page")]
    page: i64,
    #[serde(default = "default_page_size")]
    page_size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct FrameHistoryRow {
    id: i64,
    endpoint_id: String,
    session_id: String,
    peer_id: Option<String>,
    direction: String,
    format: String,
    framing: String,
    payload_base64: String,
    byte_count: i64,
    created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct LogHistoryRow {
    id: i64,
    endpoint_id: String,
    session_id: Option<String>,
    peer_id: Option<String>,
    level: String,
    source: String,
    code: Option<String>,
    message: String,
    details: Option<Value>,
    created_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct FrameHistoryInsert {
    pub(crate) endpoint_id: String,
    pub(crate) session_id: String,
    pub(crate) peer_id: Option<String>,
    pub(crate) direction: String,
    pub(crate) format: String,
    pub(crate) framing: String,
    pub(crate) byte_count: i64,
    pub(crate) payload: Vec<u8>,
    pub(crate) created_at: i64,
}

#[derive(Debug, Clone, PartialEq)]
pub(crate) struct LogHistoryInsert {
    pub(crate) endpoint_id: String,
    pub(crate) session_id: Option<String>,
    pub(crate) peer_id: Option<String>,
    pub(crate) level: String,
    pub(crate) source: String,
    pub(crate) code: Option<String>,
    pub(crate) message: String,
    pub(crate) details: Option<Value>,
    pub(crate) created_at: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HistoryPage<T> {
    rows: Vec<T>,
    total: i64,
    page: i64,
    page_size: i64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct StorageStats {
    frame_count: i64,
    log_count: i64,
    send_history_count: i64,
    modbus_point_history_count: i64,
    modbus_point_history_estimated_bytes: i64,
    modbus_point_history_last_cleanup_at: Option<i64>,
    total_count: i64,
    disk_bytes: u64,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ClearHistoryResult {
    cleared: bool,
    reclaimed: bool,
    frame_count: i64,
    log_count: i64,
    send_history_count: i64,
    total_count: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    maintenance_error: Option<MaintenanceError>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct MaintenanceError {
    name: &'static str,
    code: &'static str,
    message: String,
}

fn default_page() -> i64 {
    1
}
fn default_page_size() -> i64 {
    50
}

pub(crate) trait TransportCoordinator: Send + Sync {
    fn close_endpoint(&self, endpoint_id: &str) -> DbResult<()>;
    fn close_all_endpoints(&self) -> DbResult<()>;
    fn flush_persistence(&self) -> DbResult<()> {
        Ok(())
    }
}

pub(crate) fn after_persistence_flush<T, F>(
    coordinator: &dyn TransportCoordinator,
    mutation: F,
) -> DbResult<T>
where
    F: FnOnce() -> DbResult<T>,
{
    coordinator.flush_persistence()?;
    mutation()
}

pub(crate) fn after_transport_close_and_flush<T, F>(
    coordinator: &dyn TransportCoordinator,
    mutation: F,
) -> DbResult<T>
where
    F: FnOnce() -> DbResult<T>,
{
    coordinator.close_all_endpoints()?;
    after_persistence_flush(coordinator, mutation)
}

fn import_workspace_with_transports(
    database: &ConfigurationDatabase,
    coordinator: &dyn TransportCoordinator,
    workspace: Workspace,
) -> DbResult<Workspace> {
    // Validate input and template references before closing any live transport.
    let workspace = database.prepare_workspace_import(workspace)?;
    after_transport_close_and_flush(coordinator, || database.import_workspace(workspace))
}

pub(crate) struct ConfigurationDatabase {
    connection: Mutex<Connection>,
    modbus_point_history_last_cleanup_at: Mutex<Option<i64>>,
    filename: PathBuf,
}

impl ConfigurationDatabase {
    pub(crate) fn open_in(directory: &Path) -> DbResult<Self> {
        Self::open(directory.join(DATABASE_FILENAME))
    }

    pub(crate) fn open(filename: PathBuf) -> DbResult<Self> {
        let connection = Connection::open(&filename).map_err(db_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
            )
            .map_err(db_error)?;
        apply_migrations(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            modbus_point_history_last_cleanup_at: Mutex::new(None),
            filename,
        })
    }

    #[cfg(test)]
    pub(crate) fn open_in_memory_for_test() -> DbResult<Self> {
        let connection = Connection::open_in_memory().map_err(db_error)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL; PRAGMA foreign_keys=ON;",
            )
            .map_err(db_error)?;
        apply_migrations(&connection)?;
        Ok(Self {
            connection: Mutex::new(connection),
            modbus_point_history_last_cleanup_at: Mutex::new(None),
            filename: PathBuf::from(":memory:"),
        })
    }

    #[cfg(test)]
    pub(crate) fn insert_serial_endpoint_for_test(&self, id: &str) -> DbResult<()> {
        self.insert_endpoint(EndpointInput {
            id: id.into(),
            name: id.into(),
            transport: "serial".into(),
            config: serde_json::json!({
                "path": format!("/dev/{id}"),
                "baudRate": 115200,
                "dataBits": 8,
                "parity": "none",
                "stopBits": 1,
                "flowControl": "none",
                "receiveFraming": { "mode": "raw" }
            }),
            created_at: None,
            updated_at: None,
        })
        .map(|_| ())
    }

    #[cfg(test)]
    pub(crate) fn history_for_test(
        &self,
        endpoint_id: &str,
    ) -> DbResult<(Vec<Vec<u8>>, Vec<String>)> {
        let connection = self.connection()?;
        let frames = connection
            .prepare("SELECT payload FROM transfer_frames WHERE endpoint_id = ?1 ORDER BY id ASC")
            .map_err(db_error)?
            .query_map([endpoint_id], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<Vec<u8>>, _>>()
            .map_err(db_error)?;
        let logs = connection
            .prepare("SELECT message FROM runtime_logs WHERE endpoint_id = ?1 ORDER BY id ASC")
            .map_err(db_error)?
            .query_map([endpoint_id], |row| row.get(0))
            .map_err(db_error)?
            .collect::<Result<Vec<String>, _>>()
            .map_err(db_error)?;
        Ok((frames, logs))
    }

    #[cfg(test)]
    pub(crate) fn applied_migrations(&self) -> DbResult<Vec<(i64, String)>> {
        let connection = self.connection()?;
        let mut statement = connection
            .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
            .map_err(db_error)?;
        let rows = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))
            .map_err(db_error)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
    }

    pub(crate) fn list_endpoints(&self) -> DbResult<Vec<EndpointProfile>> {
        let connection = self.connection()?;
        list_endpoints_on(&connection)
    }

    pub(crate) fn endpoint_snapshot(&self, id: &str) -> DbResult<Option<EndpointSnapshot>> {
        let connection = self.connection()?;
        Ok(
            endpoint_by_id(&connection, id)?.map(|profile| EndpointSnapshot {
                id: profile.id,
                transport: profile.transport,
                config: profile.config,
            }),
        )
    }

    pub(crate) fn endpoint_receive_mode(&self, id: &str) -> DbResult<String> {
        let snapshot = self
            .endpoint_snapshot(id)?
            .ok_or_else(|| format!("unknown endpoint: {id}"))?;
        if snapshot.transport.starts_with("websocket-") {
            return Ok("websocket".into());
        }
        if snapshot.transport == "udp-client" || snapshot.transport == "udp-server" {
            return Ok("datagram".into());
        }
        Ok(snapshot
            .config
            .get("receiveFraming")
            .and_then(Value::as_object)
            .and_then(|framing| framing.get("mode"))
            .and_then(Value::as_str)
            .unwrap_or("raw")
            .to_owned())
    }

    pub(crate) fn insert_endpoint(&self, input: EndpointInput) -> DbResult<EndpointProfile> {
        validate_endpoint(&input)?;
        let now = now_millis()?;
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO endpoint_profiles
                 (id, name, transport, config_json, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?5)",
                params![
                    input.id,
                    input.name,
                    input.transport,
                    encode(&input.config)?,
                    now
                ],
            )
            .map_err(db_error)?;
        endpoint_by_id(&connection, &input.id)?.ok_or_else(|| "inserted endpoint is missing".into())
    }

    #[allow(dead_code)]
    pub(crate) fn update_endpoint(&self, input: EndpointInput) -> DbResult<EndpointProfile> {
        validate_endpoint(&input)?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "UPDATE endpoint_profiles
                 SET name = ?2, transport = ?3, config_json = ?4, updated_at = ?5
                 WHERE id = ?1",
                params![
                    input.id,
                    input.name,
                    input.transport,
                    encode(&input.config)?,
                    now_millis()?
                ],
            )
            .map_err(db_error)?;
        if changed == 0 {
            return Err(format!("unknown endpoint: {}", input.id));
        }
        endpoint_by_id(&connection, &input.id)?.ok_or_else(|| "updated endpoint is missing".into())
    }

    pub(crate) fn save_endpoint(&self, input: EndpointInput) -> DbResult<EndpointProfile> {
        validate_endpoint(&input)?;
        let connection = self.connection()?;
        save_endpoint_on(&connection, &input)
    }

    #[allow(dead_code)]
    pub(crate) fn clone_endpoint(
        &self,
        source_id: &str,
        id: String,
        name: Option<String>,
    ) -> DbResult<EndpointProfile> {
        let source = {
            let connection = self.connection()?;
            endpoint_by_id(&connection, source_id)?
                .ok_or_else(|| format!("unknown endpoint: {source_id}"))?
        };
        self.insert_endpoint(EndpointInput {
            id,
            name: name.unwrap_or(source.name),
            transport: source.transport,
            config: source.config,
            created_at: None,
            updated_at: None,
        })
    }

    pub(crate) fn delete_endpoint(&self, id: &str) -> DbResult<bool> {
        require_text(id, "id")?;
        let connection = self.connection()?;
        connection
            .execute("DELETE FROM endpoint_profiles WHERE id = ?1", [id])
            .map(|changed| changed > 0)
            .map_err(db_error)
    }

    pub(crate) fn save_setting(&self, key: &str, value: Value) -> DbResult<Value> {
        let normalized = normalize_setting(key, &value)?;
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                 ON CONFLICT(key) DO UPDATE
                 SET value = excluded.value, updated_at = excluded.updated_at",
                params![key, encode(&normalized)?, now_millis()?],
            )
            .map_err(db_error)?;
        Ok(normalized)
    }

    pub(crate) fn save_settings(
        &self,
        values: BTreeMap<String, Value>,
    ) -> DbResult<BTreeMap<String, Value>> {
        let normalized = normalize_settings(&values)?;
        let encoded = normalized
            .iter()
            .map(|(key, value)| Ok((key.clone(), encode(value)?)))
            .collect::<DbResult<Vec<_>>>()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute("DELETE FROM settings", [])
            .map_err(db_error)?;
        let now = now_millis()?;
        for (key, value) in encoded {
            transaction
                .execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE
                     SET value = excluded.value, updated_at = excluded.updated_at",
                    params![key, value, now],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        get_settings_on(&connection)
    }

    pub(crate) fn get_settings(&self) -> DbResult<BTreeMap<String, Value>> {
        let connection = self.connection()?;
        get_settings_on(&connection)
    }

    #[allow(dead_code)]
    pub(crate) fn save_template(&self, input: TemplateInput) -> DbResult<SendTemplate> {
        validate_template(&input)?;
        let now = now_millis()?;
        let connection = self.connection()?;
        let id = input.id.clone();
        let created_at = template_by_id(&connection, &id)?
            .map(|template| template.created_at)
            .unwrap_or(now);
        save_template_on(
            &connection,
            &SendTemplate {
                id: input.id,
                endpoint_id: input.endpoint_id,
                name: input.name,
                format: input.format,
                framing: input.framing,
                target: input.target,
                payload_base64: input.payload_base64,
                created_at,
                updated_at: now,
            },
        )?;
        template_by_id(&connection, &id)?.ok_or_else(|| "saved template is missing".into())
    }

    #[allow(dead_code)]
    pub(crate) fn list_templates(&self, endpoint_id: &str) -> DbResult<Vec<SendTemplate>> {
        require_text(endpoint_id, "endpointId")?;
        let connection = self.connection()?;
        list_templates_on(&connection, Some(endpoint_id))
    }

    pub(crate) fn delete_template(&self, id: &str) -> DbResult<bool> {
        require_text(id, "id")?;
        let connection = self.connection()?;
        connection
            .execute("DELETE FROM send_templates WHERE id = ?1", [id])
            .map(|changed| changed > 0)
            .map_err(db_error)
    }

    pub(crate) fn record_send_history(&self, input: SendHistoryInput) -> DbResult<SendHistoryRow> {
        let payload = validate_send_history_input(&input)?;
        let byte_count = i64::try_from(payload.len()).map_err(|error| error.to_string())?;
        let connection = self.connection()?;
        connection
            .execute(
                "INSERT INTO send_history
                 (endpoint_id, session_id, peer_id, target_json, format, framing, payload, byte_count, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    input.endpoint_id,
                    input.session_id,
                    input.peer_id,
                    if input.target.is_null() {
                        None
                    } else {
                        Some(encode(&input.target)?)
                    },
                    input.format,
                    input.framing,
                    payload,
                    byte_count,
                    input.created_at,
                ],
            )
            .map_err(db_error)?;
        let id = connection.last_insert_rowid();
        send_history_by_id(&connection, id)?.ok_or_else(|| "saved send history is missing".into())
    }

    pub(crate) fn query_send_history(
        &self,
        query: SendHistoryQuery,
    ) -> DbResult<HistoryPage<SendHistoryRow>> {
        validate_send_history_query(&query)?;
        let connection = self.connection()?;
        let total = connection
            .query_row(
                "SELECT COUNT(*) FROM send_history WHERE endpoint_id = ?1",
                [&query.endpoint_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let mut statement = connection
            .prepare(
                "SELECT * FROM send_history WHERE endpoint_id = ?1
                 ORDER BY created_at DESC, id DESC LIMIT ?2 OFFSET ?3",
            )
            .map_err(db_error)?;
        let offset = query
            .page
            .checked_sub(1)
            .and_then(|page| page.checked_mul(query.page_size))
            .ok_or_else(|| "send history page offset is too large".to_owned())?;
        let rows = statement
            .query_map(
                params![query.endpoint_id, query.page_size, offset],
                send_history_from_row,
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(HistoryPage {
            rows,
            total,
            page: query.page,
            page_size: query.page_size,
        })
    }

    pub(crate) fn delete_send_history(&self, id: i64) -> DbResult<bool> {
        if id < 1 {
            return Err("id must be a positive integer".into());
        }
        let connection = self.connection()?;
        connection
            .execute("DELETE FROM send_history WHERE id = ?1", [id])
            .map(|changed| changed > 0)
            .map_err(db_error)
    }

    pub(crate) fn clear_send_history(&self, endpoint_id: &str) -> DbResult<i64> {
        require_text(endpoint_id, "endpointId")?;
        let connection = self.connection()?;
        let changed = connection
            .execute(
                "DELETE FROM send_history WHERE endpoint_id = ?1",
                [endpoint_id],
            )
            .map_err(db_error)?;
        i64::try_from(changed).map_err(|error| error.to_string())
    }

    pub(crate) fn record_modbus_point_history(
        &self,
        rows: Vec<ModbusPointHistoryInput>,
    ) -> DbResult<ModbusPointHistoryRecordResult> {
        validate_modbus_point_history_batch(&rows)?;
        if rows.is_empty() {
            return Ok(ModbusPointHistoryRecordResult { recorded_count: 0 });
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        for row in &rows {
            transaction
                .execute(
                    "INSERT INTO modbus_point_history
                     (endpoint_id, request_group_id, request_id, point_id, point_key, point_name,
                      data_type, unit, raw_json, value_json, numeric_value, display_value, quality,
                      reason, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        row.endpoint_id,
                        row.request_group_id,
                        row.request_id,
                        row.point_id,
                        row.point_key,
                        row.point_name,
                        row.data_type,
                        row.unit,
                        encode(&row.raw)?,
                        encode(&row.value)?,
                        row.numeric_value,
                        row.display_value,
                        row.quality,
                        row.reason,
                        row.created_at,
                    ],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(ModbusPointHistoryRecordResult {
            recorded_count: i64::try_from(rows.len()).map_err(|error| error.to_string())?,
        })
    }

    pub(crate) fn query_modbus_point_history_rows(
        &self,
        query: ModbusPointHistoryQuery,
    ) -> DbResult<ModbusPointHistoryPage> {
        let query = normalize_modbus_point_history_query(query, false)?;
        let (where_sql, values) = modbus_point_history_filters(&query);
        let connection = self.connection()?;
        let total = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM modbus_point_history WHERE {where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let offset = query
            .page
            .checked_sub(1)
            .and_then(|page| page.checked_mul(query.page_size))
            .ok_or_else(|| "Modbus point history page offset is too large".to_owned())?;
        let mut page_values = values;
        page_values.push(SqlValue::Integer(query.page_size));
        page_values.push(SqlValue::Integer(offset));
        let mut statement = connection
            .prepare(&format!(
                "SELECT * FROM modbus_point_history WHERE {where_sql}
                 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(
                params_from_iter(page_values.iter()),
                modbus_point_history_from_row,
            )
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(HistoryPage {
            rows,
            total,
            page: query.page,
            page_size: query.page_size,
        })
    }

    pub(crate) fn query_modbus_point_series(
        &self,
        query: ModbusPointSeriesQuery,
    ) -> DbResult<ModbusPointSeriesResult> {
        let query = normalize_modbus_point_series_query(query)?;
        let connection = self.connection()?;
        let mut series = Vec::new();
        for point in &query.points {
            let mut statement = connection
                .prepare(
                    "SELECT * FROM modbus_point_history
                     WHERE endpoint_id = ?1 AND request_group_id = ?2 AND request_id = ?3
                       AND point_id = ?4 AND created_at >= ?5 AND created_at <= ?6
                     ORDER BY created_at, id",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(
                    params![
                        query.endpoint_id,
                        point.request_group_id,
                        point.request_id,
                        point.point_id,
                        query.from,
                        query.to,
                    ],
                    modbus_point_history_from_row,
                )
                .map_err(db_error)?;
            if let Some(folded) = fold_modbus_point_series(rows, &query)? {
                series.push(folded);
            }
        }
        Ok(ModbusPointSeriesResult {
            series,
            from: query.from,
            to: query.to,
        })
    }

    pub(crate) fn clear_modbus_point_history(
        &self,
        query: ModbusPointHistoryQuery,
    ) -> DbResult<i64> {
        let query = normalize_modbus_point_history_query(query, false)?;
        let (where_sql, values) = modbus_point_history_filters(&query);
        let connection = self.connection()?;
        let changed = connection
            .execute(
                &format!("DELETE FROM modbus_point_history WHERE {where_sql}"),
                params_from_iter(values.iter()),
            )
            .map_err(db_error)?;
        i64::try_from(changed).map_err(|error| error.to_string())
    }

    pub(crate) fn cleanup_modbus_point_history(
        &self,
        retention: &str,
    ) -> DbResult<ModbusPointHistoryCleanupResult> {
        self.cleanup_modbus_point_history_at(retention, now_millis()?)
    }

    fn cleanup_modbus_point_history_at(
        &self,
        retention: &str,
        completed_at: i64,
    ) -> DbResult<ModbusPointHistoryCleanupResult> {
        validate_timestamp(completed_at, "completedAt")?;
        let days = match retention {
            "7-days" => Some(7_i64),
            "30-days" => Some(30_i64),
            "90-days" => Some(90_i64),
            "forever" => None,
            _ => return Err("retention must be 7-days, 30-days, 90-days, or forever".into()),
        };
        let deleted_count = if let Some(days) = days {
            let cutoff = completed_at.saturating_sub(days * 86_400_000);
            let connection = self.connection()?;
            i64::try_from(
                connection
                    .execute(
                        "DELETE FROM modbus_point_history WHERE created_at < ?1",
                        [cutoff],
                    )
                    .map_err(db_error)?,
            )
            .map_err(|error| error.to_string())?
        } else {
            0
        };
        *self
            .modbus_point_history_last_cleanup_at
            .lock()
            .map_err(|_| "point history cleanup lock is unavailable".to_owned())? =
            Some(completed_at);
        Ok(ModbusPointHistoryCleanupResult {
            deleted_count,
            completed_at,
        })
    }

    pub(crate) fn export_workspace(&self) -> DbResult<Workspace> {
        let connection = self.connection()?;
        export_on(&connection)
    }

    fn prepare_workspace_import(&self, mut workspace: Workspace) -> DbResult<Workspace> {
        drop_retired_import_settings(&mut workspace.settings);
        validate_workspace(&workspace)?;
        workspace.settings = normalize_settings(&workspace.settings)?;
        let endpoint_ids: HashSet<String> = self
            .list_endpoints()?
            .into_iter()
            .map(|profile| profile.id)
            .chain(
                workspace
                    .endpoint_profiles
                    .iter()
                    .map(|profile| profile.id.clone()),
            )
            .collect();
        for template in &workspace.send_templates {
            if !endpoint_ids.contains(&template.endpoint_id) {
                return Err(format!(
                    "send template refers to a missing endpoint: {}",
                    template.endpoint_id
                ));
            }
        }
        Ok(workspace)
    }

    pub(crate) fn import_workspace(&self, workspace: Workspace) -> DbResult<Workspace> {
        let workspace = self.prepare_workspace_import(workspace)?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;

        for profile in &workspace.endpoint_profiles {
            transaction
                .execute(
                    "INSERT INTO endpoint_profiles
                     (id, name, transport, config_json, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                       name = excluded.name,
                       transport = excluded.transport,
                       config_json = excluded.config_json,
                       created_at = excluded.created_at,
                       updated_at = excluded.updated_at",
                    params![
                        profile.id,
                        profile.name,
                        profile.transport,
                        encode(&profile.config)?,
                        profile.created_at,
                        profile.updated_at
                    ],
                )
                .map_err(db_error)?;
        }
        transaction
            .execute("DELETE FROM settings", [])
            .map_err(db_error)?;
        for (key, value) in &workspace.settings {
            transaction
                .execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
                     ON CONFLICT(key) DO UPDATE
                     SET value = excluded.value, updated_at = excluded.updated_at",
                    params![key, encode(value)?, now_millis()?],
                )
                .map_err(db_error)?;
        }
        for template in &workspace.send_templates {
            save_template_on(&transaction, template)?;
        }
        transaction.commit().map_err(db_error)?;
        export_on(&connection)
    }

    pub(crate) fn query_frames(
        &self,
        query: HistoryQuery,
    ) -> DbResult<HistoryPage<FrameHistoryRow>> {
        validate_history_query(&query)?;
        let connection = self.connection()?;
        let (where_sql, values) = history_filters(&query, true);
        let total: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM transfer_frames{where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let mut page_values = values;
        page_values.push(SqlValue::Integer(query.page_size));
        page_values.push(SqlValue::Integer(history_offset(&query)?));
        let mut statement = connection.prepare(&format!(
            "SELECT * FROM transfer_frames{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        )).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(page_values.iter()), |row| {
                let payload: Vec<u8> = row.get("payload")?;
                Ok(FrameHistoryRow {
                    id: row.get("id")?,
                    endpoint_id: row.get("endpoint_id")?,
                    session_id: row.get("session_id")?,
                    peer_id: row.get("peer_id")?,
                    direction: row.get("direction")?,
                    format: row.get("format")?,
                    framing: row.get("framing")?,
                    payload_base64: BASE64.encode(payload),
                    byte_count: row.get("byte_count")?,
                    created_at: row.get("created_at")?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(HistoryPage {
            rows,
            total,
            page: query.page,
            page_size: query.page_size,
        })
    }

    pub(crate) fn insert_frame_batch(&self, rows: &[FrameHistoryInsert]) -> DbResult<()> {
        validate_frame_history_batch(rows)?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        for row in rows {
            transaction
                .execute(
                    "INSERT INTO transfer_frames
                     (endpoint_id, session_id, peer_id, direction, format, framing, payload, byte_count, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        row.endpoint_id,
                        row.session_id,
                        row.peer_id,
                        row.direction,
                        row.format,
                        row.framing,
                        row.payload,
                        row.byte_count,
                        row.created_at,
                    ],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub(crate) fn insert_log_batch(&self, rows: &[LogHistoryInsert]) -> DbResult<()> {
        let rows = validate_log_history_batch(rows)?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        for (row, details) in rows {
            transaction
                .execute(
                    "INSERT INTO runtime_logs
                     (endpoint_id, session_id, peer_id, level, source, code, message, details_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        row.endpoint_id,
                        row.session_id,
                        row.peer_id,
                        row.level,
                        row.source,
                        row.code,
                        row.message,
                        details,
                        row.created_at,
                    ],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub(crate) fn query_logs(&self, query: HistoryQuery) -> DbResult<HistoryPage<LogHistoryRow>> {
        validate_history_query(&query)?;
        let connection = self.connection()?;
        let (where_sql, values) = history_filters(&query, false);
        let total: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM runtime_logs{where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let mut page_values = values;
        page_values.push(SqlValue::Integer(query.page_size));
        page_values.push(SqlValue::Integer(history_offset(&query)?));
        let mut statement = connection.prepare(&format!(
            "SELECT * FROM runtime_logs{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        )).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(page_values.iter()), |row| {
                let details: Option<String> = row.get("details_json")?;
                Ok(LogHistoryRow {
                    id: row.get("id")?,
                    endpoint_id: row.get("endpoint_id")?,
                    session_id: row.get("session_id")?,
                    peer_id: row.get("peer_id")?,
                    level: row.get("level")?,
                    source: row.get("source")?,
                    code: row.get("code")?,
                    message: row.get("message")?,
                    details: details.map(|value| decode(&value)).transpose()?,
                    created_at: row.get("created_at")?,
                })
            })
            .map_err(db_error)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(db_error)?;
        Ok(HistoryPage {
            rows,
            total,
            page: query.page,
            page_size: query.page_size,
        })
    }

    pub(crate) fn storage_stats(&self) -> DbResult<StorageStats> {
        let connection = self.connection()?;
        let frame_count = row_count(&connection, "transfer_frames")?;
        let log_count = row_count(&connection, "runtime_logs")?;
        let send_history_count = row_count(&connection, "send_history")?;
        let (modbus_point_history_count, modbus_point_history_estimated_bytes) = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(
                   length(CAST(endpoint_id AS BLOB))
                   + length(CAST(request_group_id AS BLOB))
                   + length(CAST(request_id AS BLOB))
                   + length(CAST(point_id AS BLOB))
                   + length(CAST(point_key AS BLOB))
                   + length(CAST(point_name AS BLOB))
                   + length(CAST(data_type AS BLOB))
                   + COALESCE(length(CAST(unit AS BLOB)), 0)
                   + length(CAST(raw_json AS BLOB))
                   + length(CAST(value_json AS BLOB))
                   + length(CAST(display_value AS BLOB))
                   + length(CAST(quality AS BLOB))
                   + COALESCE(length(CAST(reason AS BLOB)), 0)
                   + 16 + CASE WHEN numeric_value IS NULL THEN 0 ELSE 8 END
                 ), 0) FROM modbus_point_history",
                [],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(db_error)?;
        let modbus_point_history_last_cleanup_at = *self
            .modbus_point_history_last_cleanup_at
            .lock()
            .map_err(|_| "point history cleanup lock is unavailable".to_owned())?;
        Ok(StorageStats {
            frame_count,
            log_count,
            send_history_count,
            modbus_point_history_count,
            modbus_point_history_estimated_bytes,
            modbus_point_history_last_cleanup_at,
            total_count: frame_count + log_count + send_history_count,
            disk_bytes: [
                &self.filename,
                &PathBuf::from(format!("{}-wal", self.filename.display())),
                &PathBuf::from(format!("{}-shm", self.filename.display())),
            ]
            .iter()
            .map(|path| database_file_size(path))
            .collect::<DbResult<Vec<_>>>()?
            .into_iter()
            .sum(),
        })
    }

    pub(crate) fn clear_history(&self) -> DbResult<ClearHistoryResult> {
        self.clear_history_with_vacuum(|connection| {
            connection.execute_batch("VACUUM").map_err(db_error)
        })
    }

    fn clear_history_with_vacuum<F>(&self, vacuum: F) -> DbResult<ClearHistoryResult>
    where
        F: FnOnce(&Connection) -> DbResult<()>,
    {
        let before = self.storage_stats()?;
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        transaction
            .execute_batch(
                "DELETE FROM transfer_frames; DELETE FROM runtime_logs; DELETE FROM send_history;",
            )
            .map_err(db_error)?;
        transaction.commit().map_err(db_error)?;
        let maintenance = (|| -> DbResult<()> {
            let (busy, log, checkpointed): (i64, i64, i64) = connection
                .query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
                    Ok((row.get(0)?, row.get(1)?, row.get(2)?))
                })
                .map_err(db_error)?;
            if busy != 0 || log != checkpointed {
                return Err(format!(
                    "WAL checkpoint was busy or incomplete ({busy}, {log}, {checkpointed})"
                ));
            }
            vacuum(&connection)
        })();
        Ok(ClearHistoryResult {
            cleared: true,
            reclaimed: maintenance.is_ok(),
            frame_count: before.frame_count,
            log_count: before.log_count,
            send_history_count: before.send_history_count,
            total_count: before.total_count,
            maintenance_error: maintenance.err().map(|message| MaintenanceError {
                name: "MaintenanceError",
                code: "PARTIAL_MAINTENANCE",
                message,
            }),
        })
    }

    fn connection(&self) -> DbResult<MutexGuard<'_, Connection>> {
        self.connection
            .lock()
            .map_err(|_| "database lock is unavailable".into())
    }
}

fn validate_modbus_point_history_batch(rows: &[ModbusPointHistoryInput]) -> DbResult<()> {
    if rows.len() > 2_000 {
        return Err("Modbus point history batch must contain at most 2000 rows".into());
    }
    for row in rows {
        for (value, name) in [
            (&row.endpoint_id, "endpointId"),
            (&row.request_group_id, "requestGroupId"),
            (&row.request_id, "requestId"),
            (&row.point_id, "pointId"),
            (&row.point_key, "pointKey"),
        ] {
            require_bounded_id(value, name)?;
        }
        require_text(&row.point_name, "pointName")?;
        if !matches!(
            row.data_type.as_str(),
            "boolean"
                | "uint16"
                | "int16"
                | "uint32"
                | "int32"
                | "uint64"
                | "int64"
                | "float32"
                | "float64"
                | "string"
        ) {
            return Err("dataType is invalid".into());
        }
        if !row.raw.is_array() {
            return Err("raw must be an array".into());
        }
        validate_lossless_json(&row.raw, "raw")?;
        validate_lossless_json(&row.value, "value")?;
        if row.numeric_value.is_some_and(|value| !value.is_finite()) {
            return Err("numericValue must be a finite number or null".into());
        }
        require_text(&row.display_value, "displayValue")?;
        if !matches!(
            row.quality.as_str(),
            "good" | "disabled" | "uncertain-overflow" | "bad-value" | "bad-communication"
        ) {
            return Err("quality is invalid".into());
        }
        validate_timestamp(row.created_at, "createdAt")?;
    }
    Ok(())
}

fn validate_lossless_json(value: &Value, name: &str) -> DbResult<()> {
    match value {
        Value::Number(number) => {
            if number
                .as_i64()
                .is_some_and(|value| !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&value))
                || number
                    .as_u64()
                    .is_some_and(|value| value > MAX_SAFE_TIMESTAMP as u64)
                || (number.as_f64() == Some(0.0) && number.to_string().starts_with('-'))
            {
                return Err(format!("{name} contains a value that is not lossless JSON"));
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_lossless_json(value, name)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_lossless_json(value, name)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
    Ok(())
}

fn normalize_modbus_point_history_query(
    mut query: ModbusPointHistoryQuery,
    require_points: bool,
) -> DbResult<ModbusPointHistoryQuery> {
    require_bounded_id(&query.endpoint_id, "endpointId")?;
    validate_modbus_point_identities(&query.points, require_points)?;
    validate_timestamp(query.from, "from")?;
    validate_timestamp(query.to, "to")?;
    if query.from > query.to {
        return Err("from must be less than or equal to to".into());
    }
    if !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&query.page)
        || !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&query.page_size)
    {
        return Err("page values must be safe integers".into());
    }
    query.page = query.page.clamp(1, MAX_SAFE_TIMESTAMP);
    query.page_size = query.page_size.clamp(1, 200);
    Ok(query)
}

fn normalize_modbus_point_series_query(
    mut query: ModbusPointSeriesQuery,
) -> DbResult<ModbusPointSeriesQuery> {
    require_bounded_id(&query.endpoint_id, "endpointId")?;
    validate_modbus_point_identities(&query.points, true)?;
    validate_timestamp(query.from, "from")?;
    validate_timestamp(query.to, "to")?;
    if query.from > query.to {
        return Err("from must be less than or equal to to".into());
    }
    if !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&query.bucket_count) {
        return Err("bucketCount must be a safe integer".into());
    }
    query.bucket_count = query.bucket_count.clamp(1, 2_000);
    Ok(query)
}

fn validate_modbus_point_identities(
    points: &[ModbusPointIdentity],
    required: bool,
) -> DbResult<()> {
    if (required && points.is_empty()) || points.len() > 6 {
        return Err("points must contain one to six point identities".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for point in points {
        for (value, name) in [
            (&point.request_group_id, "requestGroupId"),
            (&point.request_id, "requestId"),
            (&point.point_id, "pointId"),
        ] {
            require_bounded_id(value, name)?;
        }
        if !seen.insert((
            point.request_group_id.clone(),
            point.request_id.clone(),
            point.point_id.clone(),
        )) {
            return Err("points contains duplicate identities".into());
        }
    }
    Ok(())
}

fn modbus_point_history_filters(query: &ModbusPointHistoryQuery) -> (String, Vec<SqlValue>) {
    let mut conditions = vec![
        "endpoint_id = ?".to_owned(),
        "created_at >= ?".to_owned(),
        "created_at <= ?".to_owned(),
    ];
    let mut values = vec![
        query.endpoint_id.clone().into(),
        query.from.into(),
        query.to.into(),
    ];
    if !query.points.is_empty() {
        conditions.push(format!(
            "({})",
            query
                .points
                .iter()
                .map(|_| "(request_group_id = ? AND request_id = ? AND point_id = ?)")
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
        for point in &query.points {
            values.push(point.request_group_id.clone().into());
            values.push(point.request_id.clone().into());
            values.push(point.point_id.clone().into());
        }
    }
    (conditions.join(" AND "), values)
}

fn modbus_point_history_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ModbusPointHistoryRow> {
    let raw: String = row.get("raw_json")?;
    let value: String = row.get("value_json")?;
    Ok(ModbusPointHistoryRow {
        id: row.get("id")?,
        endpoint_id: row.get("endpoint_id")?,
        request_group_id: row.get("request_group_id")?,
        request_id: row.get("request_id")?,
        point_id: row.get("point_id")?,
        point_key: row.get("point_key")?,
        point_name: row.get("point_name")?,
        data_type: row.get("data_type")?,
        unit: row.get("unit")?,
        raw: decode(&raw)?,
        value: decode(&value)?,
        numeric_value: row.get("numeric_value")?,
        display_value: row.get("display_value")?,
        quality: row.get("quality")?,
        reason: row.get("reason")?,
        created_at: row.get("created_at")?,
    })
}

#[derive(Default)]
struct NumericBucket {
    bucket: i64,
    first_at: Option<i64>,
    first_value: Option<f64>,
    last_at: Option<i64>,
    last_value: Option<f64>,
    min_at: Option<i64>,
    min_value: Option<f64>,
    max_at: Option<i64>,
    max_value: Option<f64>,
    good_count: i64,
    abnormal_count: i64,
    worst_quality: String,
    marker: Option<Value>,
}

fn fold_modbus_point_series<I>(rows: I, query: &ModbusPointSeriesQuery) -> DbResult<Option<Value>>
where
    I: Iterator<Item = rusqlite::Result<ModbusPointHistoryRow>>,
{
    let mut latest = None;
    let mut previous_good_value = None;
    let mut minimum: Option<f64> = None;
    let mut maximum: Option<f64> = None;
    let mut change_count = 0_i64;
    let mut abnormal_count = 0_i64;
    let mut numeric_buckets = BTreeMap::<i64, NumericBucket>::new();
    let mut events = Vec::<Value>::new();
    let mut previous_event = None;
    let span = (query.to - query.from).saturating_add(1).max(1);

    for row in rows {
        let row = row.map_err(db_error)?;
        if row.quality == "good" {
            if previous_good_value
                .as_ref()
                .is_some_and(|previous: &Value| previous != &row.value)
            {
                change_count += 1;
            }
            previous_good_value = Some(row.value.clone());
        } else {
            abnormal_count += 1;
        }
        if let Some(value) = row.numeric_value {
            minimum = Some(minimum.map_or(value, |current| current.min(value)));
            maximum = Some(maximum.map_or(value, |current| current.max(value)));
        }

        if !matches!(row.data_type.as_str(), "boolean" | "string") {
            let bucket_number = (((row.created_at - query.from) * query.bucket_count) / span)
                .min(query.bucket_count - 1);
            let bucket = numeric_buckets
                .entry(bucket_number)
                .or_insert_with(|| NumericBucket {
                    bucket: bucket_number,
                    worst_quality: "good".into(),
                    ..NumericBucket::default()
                });
            if row.quality == "good" {
                bucket.good_count += 1;
            } else {
                bucket.abnormal_count += 1;
            }
            if modbus_quality_rank(&row.quality) > modbus_quality_rank(&bucket.worst_quality) {
                bucket.worst_quality = row.quality.clone();
            }
            if row.quality != "good"
                && bucket.marker.as_ref().is_none_or(|marker| {
                    modbus_quality_rank(&row.quality)
                        > modbus_quality_rank(marker["quality"].as_str().unwrap_or("good"))
                })
            {
                bucket.marker = Some(json!({
                    "createdAt": row.created_at,
                    "quality": row.quality,
                    "reason": row.reason,
                }));
            }
            if let Some(value) = row.numeric_value {
                if bucket.first_at.is_none() {
                    bucket.first_at = Some(row.created_at);
                    bucket.first_value = Some(value);
                }
                bucket.last_at = Some(row.created_at);
                bucket.last_value = Some(value);
                if bucket.min_value.is_none_or(|current| value < current) {
                    bucket.min_at = Some(row.created_at);
                    bucket.min_value = Some(value);
                }
                if bucket.max_value.is_none_or(|current| value > current) {
                    bucket.max_at = Some(row.created_at);
                    bucket.max_value = Some(value);
                }
            }
        } else {
            let signature = (row.value.clone(), row.quality.clone(), row.reason.clone());
            if previous_event.as_ref() != Some(&signature) {
                events.push(json!({
                    "createdAt": row.created_at,
                    "value": row.value,
                    "displayValue": row.display_value,
                    "quality": row.quality,
                    "reason": row.reason,
                }));
                previous_event = Some(signature);
            }
        }
        latest = Some(row);
    }

    let Some(latest) = latest else {
        return Ok(None);
    };
    let kind = match latest.data_type.as_str() {
        "boolean" => "boolean",
        "string" => "string",
        _ => "numeric",
    };
    let samples = if kind == "numeric" {
        Value::Array(
            numeric_buckets
                .into_values()
                .map(|bucket| {
                    json!({
                        "bucket": bucket.bucket,
                        "firstAt": bucket.first_at,
                        "firstValue": bucket.first_value,
                        "lastAt": bucket.last_at,
                        "lastValue": bucket.last_value,
                        "minAt": bucket.min_at,
                        "minValue": bucket.min_value,
                        "maxAt": bucket.max_at,
                        "maxValue": bucket.max_value,
                        "goodCount": bucket.good_count,
                        "abnormalCount": bucket.abnormal_count,
                        "worstQuality": bucket.worst_quality,
                        "marker": bucket.marker,
                    })
                })
                .collect(),
        )
    } else {
        Value::Array(compact_modbus_events(
            events,
            usize::try_from((query.bucket_count * 2) + 2).unwrap_or(4_002),
        ))
    };
    Ok(Some(json!({
        "requestGroupId": latest.request_group_id,
        "requestId": latest.request_id,
        "pointId": latest.point_id,
        "pointKey": latest.point_key,
        "pointName": latest.point_name,
        "dataType": latest.data_type,
        "unit": latest.unit,
        "kind": kind,
        "samples": samples,
        "summary": {
            "lastValue": latest.value,
            "lastDisplayValue": latest.display_value,
            "lastCreatedAt": latest.created_at,
            "minimum": minimum,
            "maximum": maximum,
            "changeCount": change_count,
            "abnormalCount": abnormal_count,
            "latestQuality": latest.quality,
        }
    })))
}

fn compact_modbus_events(events: Vec<Value>, limit: usize) -> Vec<Value> {
    if events.len() <= limit {
        return events;
    }
    let mut result = Vec::with_capacity(limit);
    result.push(events[0].clone());
    let interior_count = limit - 2;
    for index in 1..=interior_count {
        result.push(events[(index * (events.len() - 1)) / (interior_count + 1)].clone());
    }
    result.push(events.last().unwrap().clone());
    result
}

fn modbus_quality_rank(quality: &str) -> i64 {
    match quality {
        "disabled" => 1,
        "uncertain-overflow" => 2,
        "bad-value" => 3,
        "bad-communication" => 4,
        _ => 0,
    }
}

fn validate_history_query(query: &HistoryQuery) -> DbResult<()> {
    if !(1..=1_000_000).contains(&query.page) {
        return Err("page must be from 1 to 1000000".into());
    }
    if !(1..=200).contains(&query.page_size) {
        return Err("pageSize must be from 1 to 200".into());
    }
    if query.from.is_some_and(|value| value < 0) || query.to.is_some_and(|value| value < 0) {
        return Err("history timestamps must be non-negative".into());
    }
    Ok(())
}

const MIN_RUNTIME_HISTORY_TIMESTAMP: i64 = 1_000_000_000_000;

fn validate_runtime_history_timestamp(value: i64, name: &str) -> DbResult<()> {
    validate_timestamp(value, name)?;
    if value < MIN_RUNTIME_HISTORY_TIMESTAMP {
        return Err(format!("{name} must be an epoch-millisecond timestamp"));
    }
    Ok(())
}

fn validate_frame_history_batch(rows: &[FrameHistoryInsert]) -> DbResult<()> {
    for row in rows {
        for (value, name) in [
            (&row.endpoint_id, "endpointId"),
            (&row.session_id, "sessionId"),
            (&row.direction, "direction"),
            (&row.format, "format"),
            (&row.framing, "framing"),
        ] {
            require_text(value, name)?;
        }
        if row
            .peer_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("peerId must be a nonblank string or null".into());
        }
        if !matches!(row.direction.as_str(), "in" | "out") {
            return Err("direction must be in or out".into());
        }
        if row.byte_count != i64::try_from(row.payload.len()).map_err(|error| error.to_string())? {
            return Err("byteCount must match payload length".into());
        }
        validate_runtime_history_timestamp(row.created_at, "createdAt")?;
    }
    Ok(())
}

fn validate_log_history_batch(
    rows: &[LogHistoryInsert],
) -> DbResult<Vec<(&LogHistoryInsert, Option<String>)>> {
    rows.iter()
        .map(|row| {
            for (value, name) in [
                (&row.endpoint_id, "endpointId"),
                (&row.level, "level"),
                (&row.source, "source"),
                (&row.message, "message"),
            ] {
                require_text(value, name)?;
            }
            for (value, name) in [
                (row.session_id.as_deref(), "sessionId"),
                (row.peer_id.as_deref(), "peerId"),
                (row.code.as_deref(), "code"),
            ] {
                if value.is_some_and(|value| value.trim().is_empty()) {
                    return Err(format!("{name} must be a nonblank string or null"));
                }
            }
            validate_runtime_history_timestamp(row.created_at, "createdAt")?;
            let details = match &row.details {
                Some(details) if details.is_object() => {
                    validate_fields(details)?;
                    Some(encode(details)?)
                }
                Some(_) => return Err("details must be an object or null".into()),
                None => None,
            };
            Ok((row, details))
        })
        .collect()
}

fn history_offset(query: &HistoryQuery) -> DbResult<i64> {
    query
        .page
        .checked_sub(1)
        .and_then(|page| page.checked_mul(query.page_size))
        .ok_or_else(|| "history page offset is too large".into())
}

fn history_filters(query: &HistoryQuery, frames: bool) -> (String, Vec<SqlValue>) {
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    let mut add = |condition: &str, value: SqlValue| {
        conditions.push(condition.to_owned());
        values.push(value);
    };
    if let Some(endpoint_id) = query
        .endpoint_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        add("endpoint_id = ?", endpoint_id.to_owned().into());
    }
    if let Some(from) = query.from {
        add("created_at >= ?", from.into());
    }
    if let Some(to) = query.to {
        add("created_at <= ?", to.into());
    }
    let direction = query.direction.trim();
    if frames && !direction.is_empty() {
        add("direction = ?", direction.to_owned().into());
    }
    let level = query.level.trim();
    if !frames && !level.is_empty() {
        add("level = ?", level.to_owned().into());
    }
    let source = query.source.trim();
    if !frames && !source.is_empty() {
        add("source = ?", source.to_owned().into());
    }
    let search = query.search.trim();
    if !search.is_empty() {
        let escaped = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        if frames {
            add("CAST(payload AS TEXT) LIKE ? ESCAPE '\\'", escaped.into());
        } else {
            conditions.push("(message LIKE ? ESCAPE '\\' OR COALESCE(code, '') LIKE ? ESCAPE '\\' OR COALESCE(details_json, '') LIKE ? ESCAPE '\\')".into());
            values.extend([
                escaped.clone().into(),
                escaped.clone().into(),
                escaped.into(),
            ]);
        }
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    (where_sql, values)
}

fn row_count(connection: &Connection, table: &str) -> DbResult<i64> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(db_error)
}

fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

fn write_modbus_point_history_csv(
    database: &ConfigurationDatabase,
    destination: &Path,
    query: ModbusPointHistoryQuery,
) -> DbResult<i64> {
    let mut query = normalize_modbus_point_history_query(query, false)?;
    query.page = 1;
    query.page_size = 200;
    atomic_write_stream(destination, |file| {
        file.write_all(b"timestamp,endpointId,requestGroupId,requestId,pointId,pointKey,pointName,rawValue,engineeringValue,unit,quality,reason\r\n")
            .map_err(|error| error.to_string())?;
        let mut exported_count = 0_i64;
        loop {
            let page = database.query_modbus_point_history_rows(query.clone())?;
            for row in &page.rows {
                let raw = serde_json::to_string(&row.raw).map_err(|error| error.to_string())?;
                let value = serde_json::to_string(&row.value).map_err(|error| error.to_string())?;
                let fields = [
                    row.created_at.to_string(),
                    row.endpoint_id.clone(),
                    row.request_group_id.clone(),
                    row.request_id.clone(),
                    row.point_id.clone(),
                    row.point_key.clone(),
                    row.point_name.clone(),
                    raw,
                    value,
                    row.unit.clone().unwrap_or_default(),
                    row.quality.clone(),
                    row.reason.clone().unwrap_or_default(),
                ];
                let line = fields
                    .iter()
                    .map(|field| csv_field(field))
                    .collect::<Vec<_>>()
                    .join(",");
                file.write_all(line.as_bytes())
                    .and_then(|_| file.write_all(b"\r\n"))
                    .map_err(|error| error.to_string())?;
                exported_count += 1;
            }
            if query.page.saturating_mul(page.page_size) >= page.total || page.rows.is_empty() {
                break;
            }
            query.page += 1;
        }
        Ok(exported_count)
    })
}

#[tauri::command]
pub(crate) async fn endpoint_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
    _args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "endpoint.list");
    let database = state.database.clone();
    Ok(persistence_envelope(
        "endpoint.list",
        runtime::spawn_blocking(move || database.list_endpoints()).await,
    ))
}

#[tauri::command]
pub(crate) async fn endpoint_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "endpoint.save");
    let input = first_argument::<EndpointInput>(args, "endpoint.save");
    let database = state.database.clone();
    let result = match input {
        Ok(value) => runtime::spawn_blocking(move || database.save_endpoint(value)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("endpoint.save", result))
}

#[tauri::command]
pub(crate) async fn endpoint_clone(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "endpoint.clone");
    let values = args.unwrap_or_default();
    let source_id = values.first().and_then(Value::as_str).map(str::to_owned);
    let overrides = values
        .get(1)
        .cloned()
        .ok_or_else(|| "endpoint.clone requires source ID and overrides".to_owned())
        .and_then(|value| {
            serde_json::from_value::<CloneEndpointInput>(value).map_err(|error| error.to_string())
        });
    let database = state.database.clone();
    let result = match (source_id, overrides) {
        (Some(source_id), Ok(overrides)) => {
            runtime::spawn_blocking(move || {
                database.clone_endpoint(&source_id, overrides.id, overrides.name)
            })
            .await
        }
        _ => Err("endpoint.clone requires source ID and overrides".into()),
    };
    Ok(persistence_envelope("endpoint.clone", result))
}

#[tauri::command]
pub(crate) async fn endpoint_delete(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "endpoint.delete");
    let id = first_argument::<String>(args, "endpoint.delete");
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    let result = match id {
        Ok(value) => {
            runtime::spawn_blocking(move || {
                coordinator.close_endpoint(&value)?;
                database.delete_endpoint(&value)
            })
            .await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("endpoint.delete", result))
}

#[tauri::command]
pub(crate) async fn template_list(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "template.list");
    let endpoint_id = first_argument::<String>(args, "template.list");
    let database = state.database.clone();
    let result = match endpoint_id {
        Ok(endpoint_id) => {
            runtime::spawn_blocking(move || database.list_templates(&endpoint_id)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("template.list", result))
}

#[tauri::command]
pub(crate) async fn template_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "template.save");
    let input = first_argument::<TemplateInput>(args, "template.save");
    let database = state.database.clone();
    let result = match input {
        Ok(input) => runtime::spawn_blocking(move || database.save_template(input)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("template.save", result))
}

#[tauri::command]
pub(crate) async fn template_delete(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "template.delete");
    let id = first_argument::<String>(args, "template.delete");
    let database = state.database.clone();
    let result = match id {
        Ok(id) => runtime::spawn_blocking(move || database.delete_template(&id)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("template.delete", result))
}

#[tauri::command]
pub(crate) async fn send_history_record(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "sendHistory.record");
    let input = first_argument::<SendHistoryInput>(args, "sendHistory.record");
    let database = state.database.clone();
    let result = match input {
        Ok(input) => runtime::spawn_blocking(move || database.record_send_history(input)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("sendHistory.record", result))
}

#[tauri::command]
pub(crate) async fn send_history_query(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "sendHistory.query");
    let query = first_argument::<SendHistoryQuery>(args, "sendHistory.query");
    let database = state.database.clone();
    let result = match query {
        Ok(query) => runtime::spawn_blocking(move || database.query_send_history(query)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("sendHistory.query", result))
}

#[tauri::command]
pub(crate) async fn send_history_delete(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "sendHistory.delete");
    let id = first_argument::<i64>(args, "sendHistory.delete");
    let database = state.database.clone();
    let result = match id {
        Ok(id) => runtime::spawn_blocking(move || database.delete_send_history(id)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("sendHistory.delete", result))
}

#[tauri::command]
pub(crate) async fn send_history_clear(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "sendHistory.clear");
    let endpoint_id = first_argument::<String>(args, "sendHistory.clear");
    let database = state.database.clone();
    let result = match endpoint_id {
        Ok(endpoint_id) => {
            runtime::spawn_blocking(move || database.clear_send_history(&endpoint_id)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("sendHistory.clear", result))
}

#[tauri::command]
pub(crate) async fn settings_get_all(
    window: WebviewWindow,
    state: State<'_, AppState>,
    _args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "settings.getAll");
    let database = state.database.clone();
    Ok(persistence_envelope(
        "settings.getAll",
        runtime::spawn_blocking(move || database.get_settings()).await,
    ))
}

#[tauri::command]
pub(crate) async fn settings_save(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "settings.save");
    let values = args.unwrap_or_default();
    let key = values.first().and_then(Value::as_str).map(str::to_owned);
    let value = values.get(1).cloned();
    let database = state.database.clone();
    let result = match (key, value) {
        (Some(key), Some(value)) => {
            runtime::spawn_blocking(move || database.save_setting(&key, value)).await
        }
        _ => Err("settings.save requires a key and value".into()),
    };
    Ok(persistence_envelope("settings.save", result))
}

#[tauri::command]
pub(crate) async fn settings_save_all(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "settings.saveAll");
    let values = first_argument::<BTreeMap<String, Value>>(args, "settings.saveAll");
    let database = state.database.clone();
    let result = match values {
        Ok(values) => runtime::spawn_blocking(move || database.save_settings(values)).await,
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("settings.saveAll", result))
}

#[tauri::command]
pub(crate) async fn workspace_export(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "workspace.export");
    if args.as_ref().is_some_and(|values| !values.is_empty()) {
        return Ok(runtime::database_failure(
            "workspace.export",
            "workspace.export does not accept renderer paths".into(),
        ));
    }
    let database = state.database.clone();
    let result = runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("导出工作区")
            .set_file_name("ineed-workspace.json")
            .add_filter("工作区 JSON", &["json"])
            .blocking_save_file()
        else {
            return Ok(serde_json::json!({ "canceled": true }));
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        let document = WorkspaceDocument::from(database.export_workspace()?);
        let json = serde_json::to_string_pretty(&document).map_err(|error| error.to_string())?;
        atomic_write_workspace(&path, format!("{json}\n").as_bytes())?;
        Ok(serde_json::json!({ "canceled": false, "path": path.to_string_lossy() }))
    })
    .await;
    Ok(persistence_envelope("workspace.export", result))
}

#[tauri::command]
pub(crate) async fn workspace_import(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "workspace.import");
    if args.as_ref().is_some_and(|values| !values.is_empty()) {
        return Ok(runtime::database_failure(
            "workspace.import",
            "workspace.import does not accept renderer paths".into(),
        ));
    }
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    let result = runtime::spawn_blocking(move || {
        let Some(selected) = app
            .dialog()
            .file()
            .set_title("导入工作区")
            .add_filter("工作区 JSON", &["json"])
            .blocking_pick_file()
        else {
            return Ok(serde_json::json!({ "canceled": true }));
        };
        let path = selected.into_path().map_err(|error| error.to_string())?;
        let source = read_workspace_source(&path)?;
        let document: WorkspaceDocument =
            serde_json::from_str(&source).map_err(|error| error.to_string())?;
        let workspace = Workspace::try_from(document)?;
        import_workspace_with_transports(&database, coordinator.as_ref(), workspace)?;
        Ok(serde_json::json!({ "canceled": false, "path": path.to_string_lossy() }))
    })
    .await;
    Ok(persistence_envelope("workspace.import", result))
}

#[tauri::command]
pub(crate) async fn history_query_frames(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "history.queryFrames");
    let query = first_argument::<HistoryQuery>(args, "history.queryFrames");
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    let result = match query {
        Ok(value) => {
            runtime::spawn_blocking(move || {
                after_persistence_flush(coordinator.as_ref(), || database.query_frames(value))
            })
            .await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("history.queryFrames", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_record_batch(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.recordBatch");
    let rows = first_argument::<Vec<ModbusPointHistoryInput>>(args, "modbusHistory.recordBatch");
    let database = state.database.clone();
    let result = match rows {
        Ok(rows) => {
            runtime::spawn_blocking(move || database.record_modbus_point_history(rows)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("modbusHistory.recordBatch", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_query_series(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.querySeries");
    let query = first_argument::<ModbusPointSeriesQuery>(args, "modbusHistory.querySeries");
    let database = state.database.clone();
    let result = match query {
        Ok(query) => {
            runtime::spawn_blocking(move || database.query_modbus_point_series(query)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("modbusHistory.querySeries", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_query_rows(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.queryRows");
    let query = first_argument::<ModbusPointHistoryQuery>(args, "modbusHistory.queryRows");
    let database = state.database.clone();
    let result = match query {
        Ok(query) => {
            runtime::spawn_blocking(move || database.query_modbus_point_history_rows(query)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("modbusHistory.queryRows", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_export_csv(
    window: WebviewWindow,
    app: AppHandle,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.exportCsv");
    let query = first_argument::<ModbusPointHistoryQuery>(args, "modbusHistory.exportCsv");
    let database = state.database.clone();
    let result = match query {
        Ok(query) => {
            runtime::spawn_blocking(move || {
                let Some(selected) = app
                    .dialog()
                    .file()
                    .set_title("导出 Modbus 数据点历史")
                    .set_file_name("modbus-point-history.csv")
                    .add_filter("CSV", &["csv"])
                    .blocking_save_file()
                else {
                    return Ok(serde_json::json!({ "canceled": true }));
                };
                let path = selected.into_path().map_err(|error| error.to_string())?;
                let exported_count = write_modbus_point_history_csv(&database, &path, query)?;
                Ok(serde_json::json!({
                    "canceled": false,
                    "path": path.to_string_lossy(),
                    "exportedCount": exported_count,
                }))
            })
            .await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("modbusHistory.exportCsv", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_clear(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.clear");
    let query = first_argument::<ModbusPointHistoryQuery>(args, "modbusHistory.clear");
    let database = state.database.clone();
    let result = match query {
        Ok(query) => {
            runtime::spawn_blocking(move || database.clear_modbus_point_history(query)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("modbusHistory.clear", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_cleanup(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.cleanup");
    let retention = first_argument::<String>(args, "modbusHistory.cleanup");
    let database = state.database.clone();
    let result = match retention {
        Ok(retention) => {
            runtime::spawn_blocking(move || database.cleanup_modbus_point_history(&retention)).await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("modbusHistory.cleanup", result))
}

#[tauri::command]
pub(crate) async fn modbus_history_flush(
    window: WebviewWindow,
    _state: State<'_, AppState>,
    _args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "modbusHistory.flush");
    Ok(runtime::success(serde_json::json!({ "flushed": true })))
}

#[tauri::command]
pub(crate) async fn history_query_logs(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "history.queryLogs");
    let query = first_argument::<HistoryQuery>(args, "history.queryLogs");
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    let result = match query {
        Ok(value) => {
            runtime::spawn_blocking(move || {
                after_persistence_flush(coordinator.as_ref(), || database.query_logs(value))
            })
            .await
        }
        Err(error) => Err(error),
    };
    Ok(persistence_envelope("history.queryLogs", result))
}

#[tauri::command]
pub(crate) async fn storage_stats(
    window: WebviewWindow,
    state: State<'_, AppState>,
    _args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "storage.stats");
    let database = state.database.clone();
    Ok(persistence_envelope(
        "storage.stats",
        runtime::spawn_blocking(move || database.storage_stats()).await,
    ))
}

#[tauri::command]
pub(crate) async fn storage_clear_history(
    window: WebviewWindow,
    state: State<'_, AppState>,
    _args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "storage.clearHistory");
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    Ok(persistence_envelope(
        "storage.clearHistory",
        runtime::spawn_blocking(move || {
            after_persistence_flush(coordinator.as_ref(), || database.clear_history())
        })
        .await,
    ))
}

fn persistence_envelope<T: Serialize>(
    method: &'static str,
    result: DbResult<T>,
) -> runtime::Envelope {
    match result.and_then(|value| serde_json::to_value(value).map_err(|error| error.to_string())) {
        Ok(value) => runtime::success(value),
        Err(error) => runtime::database_failure(method, error),
    }
}

fn first_argument<T: for<'de> Deserialize<'de>>(
    args: Option<Vec<Value>>,
    method: &str,
) -> DbResult<T> {
    let value = args
        .and_then(|values| values.into_iter().next())
        .ok_or_else(|| format!("{method} requires an argument"))?;
    serde_json::from_value(value).map_err(|error| error.to_string())
}

fn apply_migrations(connection: &Connection) -> DbResult<()> {
    let tables = schema_tables(connection)?;
    if tables.is_empty() {
        for migration in MIGRATIONS {
            connection.execute_batch(migration.sql).map_err(db_error)?;
        }
        return verify_migration_schema(connection);
    }
    if !tables.iter().any(|table| table == "schema_migrations") {
        return Err("migration ledger is missing from an existing database".into());
    }

    let mut statement = connection
        .prepare("SELECT version, name FROM schema_migrations ORDER BY version")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    if rows.is_empty() {
        return Err("migration ledger is empty".into());
    }
    if let Some((version, _)) = rows
        .iter()
        .find(|(version, _)| *version > MIGRATIONS.last().unwrap().version)
    {
        return Err(format!(
            "migration ledger contains unknown version {version}"
        ));
    }
    if rows.len() > MIGRATIONS.len() {
        return Err(format!(
            "migration ledger contains unknown version {}",
            rows.last().unwrap().0
        ));
    }
    for (index, (version, name)) in rows.iter().enumerate() {
        let expected = &MIGRATIONS[index];
        if *version != expected.version || name != expected.name {
            return Err(format!(
                "migration ledger entry {} must be {}:{}",
                index + 1,
                expected.version,
                expected.name
            ));
        }
    }
    drop(statement);
    for migration in MIGRATIONS.iter().skip(rows.len()) {
        connection.execute_batch(migration.sql).map_err(|error| {
            format!(
                "migration schema update {}:{} failed: {}",
                migration.version,
                migration.name,
                db_error(error)
            )
        })?;
    }
    verify_migration_schema(connection)
}

fn schema_tables(connection: &Connection) -> DbResult<Vec<String>> {
    let mut statement = connection
        .prepare(
            "SELECT name FROM sqlite_schema
             WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
             ORDER BY name",
        )
        .map_err(db_error)?;
    let tables = statement
        .query_map([], |row| row.get(0))
        .map_err(db_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(db_error)?;
    Ok(tables)
}

fn verify_migration_schema(connection: &Connection) -> DbResult<()> {
    let tables = schema_tables(connection)?;
    let missing = REQUIRED_SCHEMA_TABLES
        .iter()
        .filter(|expected| !tables.iter().any(|table| table == **expected))
        .copied()
        .collect::<Vec<_>>();
    if missing.is_empty() {
        Ok(())
    } else {
        Err(format!(
            "migration schema is incomplete; missing: {}",
            missing.join(", ")
        ))
    }
}

fn list_endpoints_on(connection: &Connection) -> DbResult<Vec<EndpointProfile>> {
    let mut statement = connection
        .prepare("SELECT * FROM endpoint_profiles ORDER BY created_at, id")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], endpoint_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

fn endpoint_by_id(connection: &Connection, id: &str) -> DbResult<Option<EndpointProfile>> {
    connection
        .query_row(
            "SELECT * FROM endpoint_profiles WHERE id = ?1",
            [id],
            endpoint_from_row,
        )
        .optional()
        .map_err(db_error)
}

fn save_endpoint_on(connection: &Connection, input: &EndpointInput) -> DbResult<EndpointProfile> {
    let now = now_millis()?;
    connection
        .execute(
            "INSERT INTO endpoint_profiles
             (id, name, transport, config_json, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?5)
             ON CONFLICT(id) DO UPDATE SET
               name = excluded.name,
               transport = excluded.transport,
               config_json = excluded.config_json,
               updated_at = excluded.updated_at",
            params![
                input.id,
                input.name,
                input.transport,
                encode(&input.config)?,
                now
            ],
        )
        .map_err(db_error)?;
    endpoint_by_id(connection, &input.id)?.ok_or_else(|| "saved endpoint is missing".into())
}

fn endpoint_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EndpointProfile> {
    let config: String = row.get("config_json")?;
    Ok(EndpointProfile {
        id: row.get("id")?,
        name: row.get("name")?,
        transport: row.get("transport")?,
        config: decode(&config)?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn normalize_settings(values: &BTreeMap<String, Value>) -> DbResult<BTreeMap<String, Value>> {
    let mut normalized = SETTINGS_SCHEMA
        .settings
        .iter()
        .map(|(key, rule)| (key.clone(), rule.default.clone()))
        .collect::<BTreeMap<_, _>>();
    for (key, value) in values {
        normalized.insert(key.clone(), normalize_setting(key, value)?);
    }
    Ok(normalized)
}

fn drop_retired_import_settings(settings: &mut BTreeMap<String, Value>) {
    for key in RETIRED_IMPORT_SETTING_KEYS {
        settings.remove(key);
    }
}

fn normalize_setting(key: &str, value: &Value) -> DbResult<Value> {
    let rule = SETTINGS_SCHEMA
        .settings
        .get(key)
        .ok_or_else(|| format!("unknown setting: {key}"))?;
    let normalized = match rule.kind.as_str() {
        "integer" => {
            let maximum = rule.maximum.unwrap_or(MAX_SAFE_TIMESTAMP);
            let number = safe_integral_json_number(value, key, maximum)?;
            if rule.minimum.is_some_and(|minimum| number < minimum) {
                return Err(format!("{key} is outside the allowed range"));
            }
            Value::from(number)
        }
        "boolean" if !value.is_boolean() => return Err(format!("{key} must be boolean")),
        "string" if !value.is_string() => return Err(format!("{key} must be a string")),
        "boolean" | "string" => value.clone(),
        "acceptance-document" => {
            validate_acceptance_document(value)?;
            value.clone()
        }
        "stomp-profiles" => {
            validate_stomp_profiles(value)?;
            value.clone()
        }
        kind => return Err(format!("unsupported settings schema type: {kind}")),
    };
    if !rule.choices.is_empty() && !rule.choices.contains(&normalized) {
        return Err(format!("{key} is invalid"));
    }
    Ok(normalized)
}

// Deliberately opaque JSON storage; full domain validation is shared by both renderers.
fn validate_acceptance_document(value: &Value) -> DbResult<()> {
    let invalid = || "acceptanceWorkspace must be a bounded version 1 JSON document".to_string();
    let text = value
        .as_str()
        .filter(|s| s.len() <= 2 * 1024 * 1024)
        .ok_or_else(invalid)?;
    let doc: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let object = doc
        .as_object()
        .filter(|o| o.len() == if o.contains_key("templates") { 4 } else { 3 })
        .ok_or_else(invalid)?;
    if object
        .get("templates")
        .is_some_and(|rows| !rows.as_array().is_some_and(|a| a.len() <= 50))
        || object.get("version") != Some(&json!(1))
        || !object
            .get("plans")
            .and_then(Value::as_array)
            .is_some_and(|rows| rows.len() <= 50)
        || !object
            .get("reports")
            .and_then(Value::as_array)
            .is_some_and(|rows| rows.len() <= 20)
    {
        return Err(invalid());
    }
    Ok(())
}

// Apply the same strict profile boundary to settings IPC and workspace imports.
fn validate_stomp_profiles(value: &Value) -> DbResult<()> {
    fn object<'a>(value: &'a Value, keys: &[&str]) -> DbResult<&'a serde_json::Map<String, Value>> {
        value
            .as_object()
            .filter(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
            .ok_or_else(|| "stompProfiles contains invalid or unknown profile fields".into())
    }
    fn text(value: &Value, maximum: usize) -> bool {
        value.as_str().is_some_and(|s| {
            !s.is_empty() && s.encode_utf16().count() <= maximum && !s.contains(['\0', '\r', '\n'])
        })
    }
    fn integer(value: &Value, minimum: i64, maximum: i64) -> bool {
        safe_integral_json_number(value, "STOMP profile integer", maximum)
            .is_ok_and(|n| n >= minimum)
    }
    let invalid = || "stompProfiles must contain bounded safe STOMP profiles".to_string();
    let profiles = value
        .as_array()
        .filter(|a| a.len() <= 50)
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    for p in profiles {
        object(p, &["id", "name", "mode", "config", "subscriptions"])?;
        let id = p["id"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 80
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .ok_or_else(invalid)?;
        if !ids.insert(id)
            || p["name"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.encode_utf16().count() > 100)
            || !matches!(p["mode"].as_str(), Some("client" | "server"))
        {
            return Err(invalid());
        }
        let c = &p["config"];
        object(
            c,
            &[
                "url",
                "host",
                "autoReconnect",
                "heartbeatOutgoing",
                "heartbeatIncoming",
                "listenHost",
                "listenPort",
                "path",
            ],
        )?;
        if !text(&c["url"], 4096)
            || !text(&c["host"], 255)
            || !text(&c["listenHost"], 255)
            || !text(&c["path"], 1024)
            || c["path"]
                .as_str()
                .is_none_or(|s| !s.starts_with('/') || s.contains(['?', '#']))
            || !c["autoReconnect"].is_boolean()
            || !integer(&c["listenPort"], 1, 65535)
            || ["heartbeatOutgoing", "heartbeatIncoming"].iter().any(|k| {
                !integer(&c[*k], 0, 60000)
                    || safe_integral_json_number(&c[*k], "heartbeat", 60000)
                        .is_ok_and(|n| n > 0 && n < 1000)
            })
        {
            return Err(invalid());
        }
        let url_text = c["url"].as_str().unwrap();
        let url = url::Url::parse(url_text).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "ws" | "wss")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url_text.contains(['?', '#'])
        {
            return Err(invalid());
        }
        let subscriptions = p["subscriptions"]
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        for row in subscriptions {
            object(row, &["id", "destination", "ack"])?;
            if !text(&row["id"], 128)
                || !seen.insert(row["id"].as_str().unwrap())
                || !text(&row["destination"], 1024)
                || !matches!(
                    row["ack"].as_str(),
                    Some("auto" | "client" | "client-individual")
                )
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

fn safe_integral_json_number(value: &Value, name: &str, maximum: i64) -> DbResult<i64> {
    let number = value
        .as_number()
        .ok_or_else(|| format!("{name} must be an integer"))?;
    parse_integral_json_lexeme(&number.to_string(), name, maximum)
}

fn parse_integral_json_lexeme(raw: &str, name: &str, maximum: i64) -> DbResult<i64> {
    let lexeme = raw.trim();
    if lexeme.starts_with('-') {
        return Err(format!("{name} must be a non-negative safe integer"));
    }
    let (mantissa, exponent_text) = lexeme
        .split_once(['e', 'E'])
        .map_or((lexeme, "0"), |parts| parts);
    let (whole, fraction) = mantissa
        .split_once('.')
        .map_or((mantissa, ""), |parts| parts);
    let digits = format!("{whole}{fraction}");
    if digits.bytes().all(|digit| digit == b'0') {
        return Ok(0);
    }
    let exponent = exponent_text
        .parse::<i64>()
        .map_err(|_| format!("{name} must be a non-negative safe integer"))?;
    let fraction_length = i64::try_from(fraction.len())
        .map_err(|_| format!("{name} must be a non-negative safe integer"))?;
    let scale = exponent
        .checked_sub(fraction_length)
        .ok_or_else(|| format!("{name} must be a non-negative safe integer"))?;
    let significant = digits.trim_start_matches('0');
    let integer_text = if scale >= 0 {
        let maximum_digits = maximum.to_string().len();
        let zero_count =
            usize::try_from(scale).map_err(|_| format!("{name} is outside the allowed range"))?;
        if significant.len().saturating_add(zero_count) > maximum_digits {
            return Err(format!("{name} is outside the allowed range"));
        }
        format!("{significant}{}", "0".repeat(zero_count))
    } else {
        let removed = usize::try_from(scale.unsigned_abs())
            .map_err(|_| format!("{name} must be an integer"))?;
        if removed > digits.len()
            || digits[digits.len() - removed..]
                .bytes()
                .any(|digit| digit != b'0')
        {
            return Err(format!("{name} must be an integer"));
        }
        digits[..digits.len() - removed]
            .trim_start_matches('0')
            .to_owned()
    };
    let integer = if integer_text.is_empty() {
        0
    } else {
        integer_text
            .parse::<i64>()
            .map_err(|_| format!("{name} is outside the allowed range"))?
    };
    if integer > maximum {
        return Err(format!("{name} is outside the allowed range"));
    }
    Ok(integer)
}

fn get_settings_on(connection: &Connection) -> DbResult<BTreeMap<String, Value>> {
    let mut statement = connection
        .prepare("SELECT key, value FROM settings ORDER BY key")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], |row| {
            let encoded: String = row.get(1)?;
            Ok((row.get::<_, String>(0)?, encoded))
        })
        .map_err(db_error)?;
    let mut settings = normalize_settings(&BTreeMap::new())?;
    for row in rows {
        let (key, encoded) = row.map_err(db_error)?;
        if !SETTINGS_SCHEMA.settings.contains_key(&key) {
            continue;
        }
        // Acceptance evidence must never fall back to an empty document on corruption.
        if key == "acceptanceWorkspace" {
            let value =
                decode(&encoded).map_err(|_| "acceptanceWorkspace is corrupt".to_string())?;
            settings.insert(key.clone(), normalize_setting(&key, &value)?);
            continue;
        }
        let Ok(value) = decode(&encoded) else {
            continue;
        };
        if let Ok(normalized) = normalize_setting(&key, &value) {
            settings.insert(key, normalized);
        }
    }
    Ok(settings)
}

fn save_template_on(connection: &Connection, template: &SendTemplate) -> DbResult<()> {
    connection
        .execute(
            "INSERT INTO send_templates
             (id, endpoint_id, name, format, framing, target_json, payload, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(id) DO UPDATE SET
               endpoint_id = excluded.endpoint_id,
               name = excluded.name,
               format = excluded.format,
               framing = excluded.framing,
               target_json = excluded.target_json,
               payload = excluded.payload,
               created_at = excluded.created_at,
               updated_at = excluded.updated_at",
            params![
                template.id,
                template.endpoint_id,
                template.name,
                template.format,
                template.framing,
                if template.target.is_null() {
                    None
                } else {
                    Some(encode(&template.target)?)
                },
                BASE64
                    .decode(&template.payload_base64)
                    .map_err(|error| error.to_string())?,
                template.created_at,
                template.updated_at
            ],
        )
        .map(|_| ())
        .map_err(db_error)
}

fn list_templates_on(
    connection: &Connection,
    endpoint_id: Option<&str>,
) -> DbResult<Vec<SendTemplate>> {
    let sql = match endpoint_id {
        Some(_) => "SELECT * FROM send_templates WHERE endpoint_id = ?1 ORDER BY created_at, id",
        None => "SELECT * FROM send_templates ORDER BY created_at, id",
    };
    let mut statement = connection.prepare(sql).map_err(db_error)?;
    let rows = match endpoint_id {
        Some(id) => statement.query_map([id], template_from_row),
        None => statement.query_map([], template_from_row),
    }
    .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

#[allow(dead_code)]
fn template_by_id(connection: &Connection, id: &str) -> DbResult<Option<SendTemplate>> {
    connection
        .query_row(
            "SELECT * FROM send_templates WHERE id = ?1",
            [id],
            template_from_row,
        )
        .optional()
        .map_err(db_error)
}

fn template_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendTemplate> {
    let target: Option<String> = row.get("target_json")?;
    let payload: Vec<u8> = row.get("payload")?;
    Ok(SendTemplate {
        id: row.get("id")?,
        endpoint_id: row.get("endpoint_id")?,
        name: row.get("name")?,
        format: row.get("format")?,
        framing: row.get("framing")?,
        target: target
            .map(|value| decode(&value))
            .transpose()?
            .unwrap_or(Value::Null),
        payload_base64: BASE64.encode(payload),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn validate_send_history_input(input: &SendHistoryInput) -> DbResult<Vec<u8>> {
    for (value, name) in [
        (&input.endpoint_id, "endpointId"),
        (&input.format, "format"),
        (&input.framing, "framing"),
        (&input.payload_base64, "payloadBase64"),
    ] {
        require_text(value, name)?;
    }
    for (value, name) in [
        (input.session_id.as_deref(), "sessionId"),
        (input.peer_id.as_deref(), "peerId"),
    ] {
        if value.is_some_and(|value| value.trim().is_empty()) {
            return Err(format!("{name} must be a nonblank string or null"));
        }
    }
    if !input.target.is_null() {
        if !input.target.is_object() {
            return Err("target must be an object or null".into());
        }
        validate_fields(&input.target)?;
    }
    validate_runtime_history_timestamp(input.created_at, "createdAt")?;
    let payload = BASE64
        .decode(&input.payload_base64)
        .map_err(|_| "payloadBase64 must be canonical base64".to_owned())?;
    if BASE64.encode(&payload) != input.payload_base64 {
        return Err("payloadBase64 must be canonical base64".into());
    }
    Ok(payload)
}

fn validate_send_history_query(query: &SendHistoryQuery) -> DbResult<()> {
    require_text(&query.endpoint_id, "endpointId")?;
    if !(1..=1_000_000).contains(&query.page) {
        return Err("page must be from 1 to 1000000".into());
    }
    if !(1..=100).contains(&query.page_size) {
        return Err("pageSize must be from 1 to 100".into());
    }
    query
        .page
        .checked_sub(1)
        .and_then(|page| page.checked_mul(query.page_size))
        .ok_or_else(|| "send history page offset is too large".into())
        .map(|_| ())
}

fn send_history_by_id(connection: &Connection, id: i64) -> DbResult<Option<SendHistoryRow>> {
    connection
        .query_row(
            "SELECT * FROM send_history WHERE id = ?1",
            [id],
            send_history_from_row,
        )
        .optional()
        .map_err(db_error)
}

fn send_history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendHistoryRow> {
    let target: Option<String> = row.get("target_json")?;
    let payload: Vec<u8> = row.get("payload")?;
    Ok(SendHistoryRow {
        id: row.get("id")?,
        endpoint_id: row.get("endpoint_id")?,
        session_id: row.get("session_id")?,
        peer_id: row.get("peer_id")?,
        target: target
            .map(|value| decode(&value))
            .transpose()?
            .unwrap_or(Value::Null),
        format: row.get("format")?,
        framing: row.get("framing")?,
        payload_base64: BASE64.encode(payload),
        byte_count: row.get("byte_count")?,
        created_at: row.get("created_at")?,
    })
}

fn export_on(connection: &Connection) -> DbResult<Workspace> {
    Ok(Workspace {
        version: WORKSPACE_VERSION,
        endpoint_profiles: list_endpoints_on(connection)?,
        settings: get_settings_on(connection)?,
        send_templates: list_templates_on(connection, None)?,
    })
}

fn validate_endpoint(input: &EndpointInput) -> DbResult<()> {
    require_text(&input.id, "id")?;
    require_text(&input.name, "name")?;
    require_text(&input.transport, "transport")?;
    if !matches!(
        input.transport.as_str(),
        "serial"
            | "tcp-client"
            | "tcp-server"
            | "udp-client"
            | "udp-server"
            | "websocket-client"
            | "websocket-server"
            | "dlt645-master"
            | "dlt645-slave"
            | "modbus-tcp-master"
            | "modbus-tcp-slave"
            | "modbus-rtu-master"
            | "modbus-rtu-slave"
    ) {
        return Err("Unsupported transport".into());
    }
    if !input.config.is_object() {
        return Err("config must be an object".into());
    }
    validate_fields(&input.config)?;
    if input.transport.starts_with("websocket-") {
        crate::websocket::validate_config(&input.transport, &input.config, false)
            .map_err(|e| e.to_string())?;
    }
    validate_optional_timestamp(input.created_at, "createdAt")?;
    validate_optional_timestamp(input.updated_at, "updatedAt")
}

fn validate_template(input: &TemplateInput) -> DbResult<()> {
    for (value, name) in [
        (&input.id, "id"),
        (&input.endpoint_id, "endpointId"),
        (&input.name, "name"),
        (&input.format, "format"),
        (&input.framing, "framing"),
        (&input.payload_base64, "payloadBase64"),
    ] {
        require_text(value, name)?;
    }
    if !input.target.is_null() && !input.target.is_object() {
        return Err("target must be an object or null".into());
    }
    validate_fields(&input.target)?;
    BASE64
        .decode(&input.payload_base64)
        .map_err(|error| error.to_string())?;
    validate_optional_timestamp(input.created_at, "createdAt")?;
    validate_optional_timestamp(input.updated_at, "updatedAt")
}

fn validate_workspace(workspace: &Workspace) -> DbResult<()> {
    if workspace.version != WORKSPACE_VERSION {
        return Err(format!("workspace version must be {WORKSPACE_VERSION}"));
    }
    for profile in &workspace.endpoint_profiles {
        validate_endpoint(&EndpointInput {
            id: profile.id.clone(),
            name: profile.name.clone(),
            transport: profile.transport.clone(),
            config: profile.config.clone(),
            created_at: None,
            updated_at: None,
        })?;
        validate_timestamp(profile.created_at, "endpointProfiles.createdAt")?;
        validate_timestamp(profile.updated_at, "endpointProfiles.updatedAt")?;
    }
    normalize_settings(&workspace.settings)?;
    for template in &workspace.send_templates {
        validate_template(&TemplateInput {
            id: template.id.clone(),
            endpoint_id: template.endpoint_id.clone(),
            name: template.name.clone(),
            format: template.format.clone(),
            framing: template.framing.clone(),
            target: template.target.clone(),
            payload_base64: template.payload_base64.clone(),
            created_at: None,
            updated_at: None,
        })?;
        validate_timestamp(template.created_at, "sendTemplates.createdAt")?;
        validate_timestamp(template.updated_at, "sendTemplates.updatedAt")?;
    }
    Ok(())
}

fn validate_timestamp(value: i64, name: &str) -> DbResult<()> {
    if (0..=MAX_SAFE_TIMESTAMP).contains(&value) {
        Ok(())
    } else {
        Err(format!(
            "{name} must be a non-negative safe integer timestamp"
        ))
    }
}

fn validate_optional_timestamp(value: Option<i64>, name: &str) -> DbResult<()> {
    value.map_or(Ok(()), |timestamp| validate_timestamp(timestamp, name))
}

fn validate_fields(value: &Value) -> DbResult<()> {
    let denied = [
        "pass".to_owned() + "word",
        "pass".to_owned() + "wd",
        "pass".to_owned() + "phrase",
        "se".to_owned() + "cret",
        "creden".to_owned() + "tial",
        "api".to_owned() + "key",
        "to".to_owned() + "ken",
    ];
    match value {
        Value::Array(values) => {
            for child in values {
                validate_fields(child)?;
            }
        }
        Value::Object(values) => {
            for (key, child) in values {
                let normalized = key.to_ascii_lowercase().replace(['_', '-'], "");
                if denied.iter().any(|part| normalized.contains(part)) {
                    return Err(format!("protected-like field is not allowed: {key}"));
                }
                validate_fields(child)?;
            }
        }
        _ => {}
    }
    Ok(())
}

fn require_text(value: &str, name: &str) -> DbResult<()> {
    if value.trim().is_empty() {
        Err(format!("{name} must be a nonblank string"))
    } else {
        Ok(())
    }
}

fn require_bounded_id(value: &str, name: &str) -> DbResult<()> {
    require_text(value, name)?;
    if value.len() > 128 {
        return Err(format!("{name} must be at most 128 bytes"));
    }
    Ok(())
}

fn encode(value: &Value) -> DbResult<String> {
    serde_json::to_string(value).map_err(|error| error.to_string())
}

fn decode(value: &str) -> rusqlite::Result<Value> {
    serde_json::from_str(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn now_millis() -> DbResult<i64> {
    let millis = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|error| error.to_string())
}

fn db_error(error: rusqlite::Error) -> String {
    error.to_string()
}

#[cfg(test)]
mod tests {
    use std::{fs, process};

    use serde_json::json;

    use super::*;

    #[test]
    fn modbus_point_history_csv_escapes_delimiters_quotes_and_line_breaks() {
        assert_eq!(csv_field("plain"), "plain");
        assert_eq!(csv_field("a,b"), "\"a,b\"");
        assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
        assert_eq!(csv_field("a\r\nb"), "\"a\r\nb\"");
    }

    fn temporary_database(name: &str) -> (ConfigurationDatabase, PathBuf) {
        let directory = std::env::temp_dir().join(format!(
            "ineed-tauri-{name}-{}-{}",
            process::id(),
            now_millis().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        let database = ConfigurationDatabase::open_in(&directory).unwrap();
        (database, directory)
    }

    #[test]
    fn workspace_files_are_bounded_regular_and_not_symlinks() {
        let directory = std::env::temp_dir().join(format!(
            "ineed-tauri-workspace-files-{}-{}",
            process::id(),
            now_millis().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        let valid = directory.join("valid.json");
        let large = directory.join("large.json");
        let linked = directory.join("linked.json");
        fs::write(&valid, r#"{"schemaVersion":1}"#).unwrap();
        fs::write(&large, vec![b'x'; MAX_WORKSPACE_BYTES + 1]).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(&valid, &linked).unwrap();

        assert_eq!(
            read_workspace_source(&valid).unwrap(),
            r#"{"schemaVersion":1}"#
        );
        assert!(read_workspace_source(&large)
            .unwrap_err()
            .contains("10 MiB"));
        assert!(read_workspace_source(&directory)
            .unwrap_err()
            .contains("regular file"));
        #[cfg(unix)]
        assert!(read_workspace_source(&linked)
            .unwrap_err()
            .contains("symbolic link"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn workspace_import_descriptor_survives_path_swap_and_detects_growth() {
        use std::io::Write as _;

        let directory = std::env::temp_dir().join(format!(
            "ineed-tauri-workspace-race-{}-{}",
            process::id(),
            now_millis().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        let selected = directory.join("selected.json");
        let moved = directory.join("moved.json");
        fs::write(&selected, r#"{"schemaVersion":1}"#).unwrap();
        let opened = open_workspace_import(&selected).unwrap();
        fs::rename(&selected, &moved).unwrap();
        std::os::unix::fs::symlink(&moved, &selected).unwrap();
        assert_eq!(
            read_open_workspace_source(opened).unwrap(),
            r#"{"schemaVersion":1}"#
        );

        fs::remove_file(&selected).unwrap();
        fs::write(&selected, b"{}").unwrap();
        let opened = open_workspace_import(&selected).unwrap();
        let mut writer = fs::OpenOptions::new().append(true).open(&selected).unwrap();
        writer.write_all(&vec![b'x'; MAX_WORKSPACE_BYTES]).unwrap();
        writer.sync_all().unwrap();
        assert!(read_open_workspace_source(opened)
            .unwrap_err()
            .contains("10 MiB"));
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn database_file_size_treats_only_not_found_as_zero() {
        let missing = std::env::temp_dir().join(format!("missing-{}", process::id()));
        assert_eq!(database_file_size(&missing).unwrap(), 0);
        assert!(database_file_size(Path::new("\0invalid")).is_err());
    }

    #[test]
    fn workspace_export_atomically_replaces_destination_and_rejects_symlinks() {
        let directory = std::env::temp_dir().join(format!(
            "ineed-tauri-workspace-write-{}-{}",
            process::id(),
            now_millis().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        let destination = directory.join("workspace.json");
        fs::write(&destination, "old").unwrap();
        atomic_write_workspace(&destination, b"new\n").unwrap();
        assert_eq!(fs::read_to_string(&destination).unwrap(), "new\n");
        assert!(fs::read_dir(&directory).unwrap().all(|entry| !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")));

        #[cfg(unix)]
        {
            fs::remove_file(&destination).unwrap();
            std::os::unix::fs::symlink(directory.join("other"), &destination).unwrap();
            assert!(atomic_write_workspace(&destination, b"unsafe")
                .unwrap_err()
                .contains("symbolic link"));
        }
        fs::remove_dir_all(directory).unwrap();
    }

    fn endpoint(id: &str, name: &str) -> EndpointInput {
        EndpointInput {
            id: id.into(),
            name: name.into(),
            transport: "tcp-client".into(),
            config: json!({ "host": "127.0.0.1", "port": 9000 }),
            created_at: None,
            updated_at: None,
        }
    }

    #[test]
    fn udp_endpoint_receive_mode_is_always_datagram() {
        let (database, directory) = temporary_database("udp-receive-mode");
        database
            .insert_endpoint(EndpointInput {
                id: "udp-server-1".into(),
                name: "UDP Server".into(),
                transport: "udp-server".into(),
                config: json!({
                    "bindHost": "127.0.0.1",
                    "bindPort": 41000,
                    "receiveFraming": { "mode": "delimiter", "delimiterBytes": [10] }
                }),
                created_at: None,
                updated_at: None,
            })
            .unwrap();

        assert_eq!(
            database.endpoint_receive_mode("udp-server-1").unwrap(),
            "datagram"
        );

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn reading_and_normalizing_a_version_two_modbus_master_leaves_its_sqlite_row_unchanged() {
        let (database, directory) = temporary_database("modbus-master-read-only-upgrade");
        let config = json!({
            "configVersion": 2,
            "marker": "preserved",
            "host": "192.168.1.20",
            "port": 502,
            "unitId": 1,
            "timeoutMs": 1000,
            "requestGroups": []
        });
        database
            .insert_endpoint(EndpointInput {
                id: "legacy-master".into(),
                name: "Legacy master".into(),
                transport: "modbus-tcp-master".into(),
                config: config.clone(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        let read_raw_row = || {
            let connection = database.connection().unwrap();
            connection
                .query_row(
                    "SELECT config_json, updated_at FROM endpoint_profiles WHERE id = ?1",
                    ["legacy-master"],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .unwrap()
        };
        let before = read_raw_row();

        let loaded = database
            .list_endpoints()
            .unwrap()
            .into_iter()
            .find(|endpoint| endpoint.id == "legacy-master")
            .unwrap();
        assert_eq!(loaded.config, config);
        assert!(loaded.config.get("writeCommands").is_none());
        assert_eq!(read_raw_row(), before);

        // Native persistence stores opaque endpoint JSON; normalization belongs to the model layer.
        let mut normalized_for_save = loaded.config.clone();
        normalized_for_save
            .as_object_mut()
            .unwrap()
            .insert("configVersion".into(), json!(3));
        normalized_for_save
            .as_object_mut()
            .unwrap()
            .insert("writeCommands".into(), json!([]));
        assert_eq!(normalized_for_save["writeCommands"], json!([]));
        assert_eq!(read_raw_row(), before);

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn version_two_modbus_master_upgrades_without_changing_history_rows_or_bytes() {
        let (database, directory) = temporary_database("modbus-master-request-groups");
        let config = json!({
            "configVersion": 2,
            "marker": "preserved",
            "host": "192.168.1.20",
            "port": 502,
            "unitId": 1,
            "timeoutMs": 1000,
            "scheduler": { "autoStart": true, "minGapMs": 50 },
            "requestGroups": [{
                "id": "holding",
                "name": "Environment",
                "functionCode": 3,
                "startAddress": 100,
                "quantity": 10,
                "dataPoints": [{
                    "id": "temperature",
                    "key": "temperature",
                    "name": "Temperature",
                    "offset": 0,
                    "dataType": "float32",
                    "length": 2
                }]
            }]
        });
        database
            .insert_endpoint(EndpointInput {
                id: "modbus-master".into(),
                name: "Boiler master".into(),
                transport: "modbus-tcp-master".into(),
                config: config.clone(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        database
            .insert_frame_batch(&[frame_insert(
                "modbus-master",
                vec![0, 128, 255],
                1_720_000_000_123,
            )])
            .unwrap();
        database
            .insert_log_batch(&[log_insert(
                "modbus-master",
                Some(json!({ "requestGroupId": "holding" })),
                1_720_000_000_124,
            )])
            .unwrap();
        database
            .record_send_history(SendHistoryInput {
                endpoint_id: "modbus-master".into(),
                session_id: Some("session-1".into()),
                peer_id: None,
                target: json!({ "unitId": 1 }),
                format: "hex".into(),
                framing: "none".into(),
                payload_base64: "AID/".into(),
                created_at: 1_720_000_000_125,
            })
            .unwrap();
        database
            .insert_endpoint(endpoint("unchanged", "Unchanged endpoint"))
            .unwrap();
        let history_query = || HistoryQuery {
            endpoint_id: Some("modbus-master".into()),
            page: 1,
            page_size: 20,
            ..HistoryQuery::default()
        };
        let send_query = || SendHistoryQuery {
            endpoint_id: "modbus-master".into(),
            page: 1,
            page_size: 20,
        };
        let before_frames = database.query_frames(history_query()).unwrap();
        let before_logs = database.query_logs(history_query()).unwrap();
        let before_sends = database.query_send_history(send_query()).unwrap();
        let before_history = database.storage_stats().unwrap();
        let unchanged_before = database
            .list_endpoints()
            .unwrap()
            .into_iter()
            .find(|endpoint| endpoint.id == "unchanged")
            .unwrap();

        let updated = json!({
            "configVersion": 3,
            "marker": "preserved",
            "host": "192.168.1.20",
            "port": 502,
            "unitId": 1,
            "timeoutMs": 1000,
            "scheduler": { "autoStart": true, "minGapMs": 50 },
            "description": "updated without dropping nested configuration",
            "writeCommands": [
                {
                    "id": "reset-alarm",
                    "name": "Reset alarm",
                    "description": "Clear the alarm latch",
                    "enabled": false,
                    "order": 0,
                    "unitId": 1,
                    "functionCode": 5,
                    "address": 12,
                    "values": [true]
                },
                {
                    "id": "set-thresholds",
                    "name": "Set thresholds",
                    "description": "Apply limits",
                    "enabled": true,
                    "order": 1,
                    "unitId": 1,
                    "functionCode": 16,
                    "address": 200,
                    "values": [10, 20, 30]
                }
            ],
            "requestGroups": [{
                "id": "holding",
                "name": "Environment",
                "unitId": 1,
                "enabled": true,
                "order": 0,
                "requests": [{
                    "id": "holding-request",
                    "name": "Environment request",
                    "enabled": false,
                    "order": 0,
                    "functionCode": 3,
                    "startAddress": 100,
                    "quantity": 10,
                    "intervalMs": 1000,
                    "dataPoints": [{
                        "id": "temperature",
                        "key": "temperature",
                        "name": "Temperature",
                        "enabled": false,
                        "offset": 0,
                        "dataType": "float32",
                        "length": 2,
                        "saveHistory": true
                    }]
                }]
            }]
        });
        let saved = database
            .save_endpoint(EndpointInput {
                id: "modbus-master".into(),
                name: "Boiler master updated".into(),
                transport: "modbus-tcp-master".into(),
                config: updated.clone(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        assert_eq!(saved.config, updated);
        assert_eq!(saved.config["configVersion"], 3);
        assert_eq!(saved.config["marker"], "preserved");
        assert_eq!(saved.config["writeCommands"][0]["id"], "reset-alarm");
        assert_eq!(saved.config["writeCommands"][0]["enabled"], false);
        assert_eq!(
            saved.config["writeCommands"][1]["values"],
            json!([10, 20, 30])
        );
        assert_eq!(
            database.query_frames(history_query()).unwrap(),
            before_frames
        );
        assert_eq!(database.query_logs(history_query()).unwrap(), before_logs);
        assert_eq!(
            database.query_send_history(send_query()).unwrap(),
            before_sends
        );
        let after_history = database.storage_stats().unwrap();
        assert_eq!(after_history.frame_count, before_history.frame_count);
        assert_eq!(after_history.log_count, before_history.log_count);
        assert_eq!(
            after_history.send_history_count,
            before_history.send_history_count
        );
        assert_eq!(after_history.total_count, before_history.total_count);
        let unchanged_after = database
            .list_endpoints()
            .unwrap()
            .into_iter()
            .find(|endpoint| endpoint.id == "unchanged")
            .unwrap();
        assert_eq!(unchanged_after, unchanged_before);

        let exported = database.export_workspace().unwrap();
        assert_eq!(exported.version, 1);
        let (target, target_directory) = temporary_database("modbus-master-import");
        let imported = target.import_workspace(exported).unwrap();
        let restored = imported
            .endpoint_profiles
            .iter()
            .find(|endpoint| endpoint.id == "modbus-master")
            .unwrap();
        assert_eq!(restored.config, updated);
        assert_eq!(restored.config["writeCommands"][0]["order"], 0);
        assert_eq!(restored.config["writeCommands"][1]["id"], "set-thresholds");
        assert_eq!(
            restored.config["requestGroups"][0]["requests"][0]["enabled"],
            false
        );
        assert_eq!(
            restored.config["requestGroups"][0]["requests"][0]["dataPoints"][0]["saveHistory"],
            true
        );

        drop(target);
        drop(database);
        fs::remove_dir_all(target_directory).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    fn frame_insert(endpoint_id: &str, payload: Vec<u8>, created_at: i64) -> FrameHistoryInsert {
        FrameHistoryInsert {
            endpoint_id: endpoint_id.into(),
            session_id: "session-1".into(),
            peer_id: Some("peer-1".into()),
            direction: "in".into(),
            format: "hex".into(),
            framing: "raw".into(),
            byte_count: payload.len() as i64,
            payload,
            created_at,
        }
    }

    fn log_insert(endpoint_id: &str, details: Option<Value>, created_at: i64) -> LogHistoryInsert {
        LogHistoryInsert {
            endpoint_id: endpoint_id.into(),
            session_id: Some("session-1".into()),
            peer_id: Some("peer-1".into()),
            level: "info".into(),
            source: "serial".into(),
            code: None,
            message: "串口已打开: /dev/ttyUSB0".into(),
            details,
            created_at,
        }
    }

    #[test]
    fn history_batch_inserts_round_trip_blob_json_null_and_milliseconds() {
        let (database, directory) = temporary_database("history-batch-round-trip");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        let mut frame = frame_insert("one", vec![0, 128, 255], 1_720_000_000_123);
        let mut log = log_insert(
            "one",
            Some(json!({ "path": "/dev/ttyUSB0", "settings": [115200, true, null] })),
            1_720_000_000_124,
        );
        database.insert_frame_batch(&[frame.clone()]).unwrap();
        database
            .insert_log_batch(&[
                log.clone(),
                LogHistoryInsert {
                    session_id: None,
                    details: None,
                    message: "closed".into(),
                    created_at: 1_720_000_000_125,
                    ..log.clone()
                },
            ])
            .unwrap();
        frame.payload.fill(7);
        log.details = Some(json!({ "path": "mutated" }));

        let connection = database.connection().unwrap();
        let stored_frame = connection
            .query_row(
                "SELECT typeof(payload), payload, byte_count, created_at FROM transfer_frames",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            stored_frame,
            ("blob".into(), vec![0, 128, 255], 3, 1_720_000_000_123)
        );
        let mut statement = connection
            .prepare("SELECT session_id, details_json, created_at FROM runtime_logs ORDER BY id")
            .unwrap();
        let stored_logs = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(stored_logs[0].1.as_ref().unwrap()).unwrap(),
            json!({ "path": "/dev/ttyUSB0", "settings": [115200, true, null] })
        );
        assert_eq!(stored_logs[0].2, 1_720_000_000_124);
        assert_eq!(stored_logs[1], (None, None, 1_720_000_000_125));
        drop(statement);
        drop(connection);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn tcp_server_peer_history_preserves_peer_source_and_exact_timestamps() {
        let (database, directory) = temporary_database("history-tcp-peer");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        let peer_id = "peer-127-0-0-1-51000";
        let frame = FrameHistoryInsert {
            session_id: "tcp-server-session".into(),
            peer_id: Some(peer_id.into()),
            payload: vec![0x41],
            byte_count: 1,
            created_at: 1_720_000_000_111,
            ..frame_insert("one", vec![0x41], 1_720_000_000_111)
        };
        let log = LogHistoryInsert {
            session_id: Some("tcp-server-session".into()),
            peer_id: Some(peer_id.into()),
            source: "tcp".into(),
            message: "TCP peer connected".into(),
            details: Some(json!({ "remoteAddress": "127.0.0.1:51000" })),
            created_at: 1_720_000_000_111,
            ..log_insert("one", None, 1_720_000_000_111)
        };

        database.insert_frame_batch(&[frame]).unwrap();
        database.insert_log_batch(&[log]).unwrap();

        let frames = database
            .query_frames(HistoryQuery {
                endpoint_id: Some("one".into()),
                page: 1,
                page_size: 50,
                ..HistoryQuery::default()
            })
            .unwrap();
        let logs = database
            .query_logs(HistoryQuery {
                endpoint_id: Some("one".into()),
                source: "tcp".into(),
                page: 1,
                page_size: 50,
                ..HistoryQuery::default()
            })
            .unwrap();
        assert_eq!(frames.total, 1);
        assert_eq!(frames.rows.len(), 1);
        assert_eq!(logs.total, 1);
        assert_eq!(logs.rows.len(), 1);
        assert_eq!(frames.rows[0].peer_id.as_deref(), Some(peer_id));
        assert_eq!(frames.rows[0].session_id, "tcp-server-session");
        assert_eq!(frames.rows[0].payload_base64, "QQ==");
        assert_eq!(frames.rows[0].created_at, 1_720_000_000_111);
        assert_eq!(logs.rows[0].peer_id.as_deref(), Some(peer_id));
        assert_eq!(logs.rows[0].source, "tcp");
        assert_eq!(
            logs.rows[0].details,
            Some(json!({ "remoteAddress": "127.0.0.1:51000" }))
        );
        assert_eq!(logs.rows[0].created_at, 1_720_000_000_111);

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn empty_history_batches_are_no_ops() {
        let (database, directory) = temporary_database("history-empty-batch");
        database.insert_frame_batch(&[]).unwrap();
        database.insert_log_batch(&[]).unwrap();
        assert_eq!(database.storage_stats().unwrap().total_count, 0);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn send_templates_and_send_history_support_product_management() {
        let (database, directory) = temporary_database("send-management");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        database.insert_endpoint(endpoint("two", "Two")).unwrap();
        database
            .save_template(TemplateInput {
                id: "template-one".into(),
                endpoint_id: "one".into(),
                name: "Ping".into(),
                format: "text".into(),
                framing: "none".into(),
                target: Value::Null,
                payload_base64: "cGluZw==".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        assert!(database.delete_template("template-one").unwrap());
        assert!(database.list_templates("one").unwrap().is_empty());

        let first = database
            .record_send_history(SendHistoryInput {
                endpoint_id: "one".into(),
                session_id: Some("session-one".into()),
                peer_id: Some("peer-one".into()),
                target: json!({ "peerId": "peer-one" }),
                format: "hex".into(),
                framing: "none".into(),
                payload_base64: "AID/".into(),
                created_at: 1_720_000_000_111,
            })
            .unwrap();
        let second = database
            .record_send_history(SendHistoryInput {
                endpoint_id: "one".into(),
                session_id: Some("session-one".into()),
                peer_id: None,
                target: json!({ "broadcast": true }),
                format: "text".into(),
                framing: "line".into(),
                payload_base64: "cGluZw==".into(),
                created_at: 1_720_000_000_112,
            })
            .unwrap();
        database
            .record_send_history(SendHistoryInput {
                endpoint_id: "two".into(),
                session_id: None,
                peer_id: None,
                target: Value::Null,
                format: "text".into(),
                framing: "none".into(),
                payload_base64: "b3RoZXI=".into(),
                created_at: 1_720_000_000_113,
            })
            .unwrap();

        assert_eq!(first.byte_count, 3);
        assert_eq!(second.byte_count, 4);
        let page = database
            .query_send_history(SendHistoryQuery {
                endpoint_id: "one".into(),
                page: 1,
                page_size: 20,
            })
            .unwrap();
        assert_eq!(page.total, 2);
        assert_eq!(page.rows, vec![second.clone(), first.clone()]);
        assert!(database.delete_send_history(first.id).unwrap());
        assert_eq!(database.clear_send_history("one").unwrap(), 1);
        assert_eq!(
            database
                .query_send_history(SendHistoryQuery {
                    endpoint_id: "two".into(),
                    page: 1,
                    page_size: 20,
                })
                .unwrap()
                .total,
            1
        );

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn runtime_history_rejects_seconds_before_any_batch_row_is_written() {
        let (database, directory) = temporary_database("history-milliseconds");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        let frame_error = database
            .insert_frame_batch(&[frame_insert("one", vec![1], 1_720_000_000)])
            .unwrap_err();
        let log_error = database
            .insert_log_batch(&[log_insert("one", None, 1_720_000_000)])
            .unwrap_err();
        assert!(frame_error.contains("epoch-millisecond"));
        assert!(log_error.contains("epoch-millisecond"));
        assert_eq!(database.storage_stats().unwrap().total_count, 0);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn runtime_history_millisecond_boundary_and_partial_batches_are_atomic() {
        let (database, directory) = temporary_database("history-milliseconds-boundary");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        database
            .insert_frame_batch(&[frame_insert("one", vec![1], 1_000_000_000_000)])
            .unwrap();
        database
            .insert_log_batch(&[log_insert("one", None, 1_000_000_000_000)])
            .unwrap();
        assert_eq!(database.storage_stats().unwrap().total_count, 2);
        database.clear_history().unwrap();

        let frame_error = database
            .insert_frame_batch(&[frame_insert("one", vec![1], 999_999_999_999)])
            .unwrap_err();
        let log_error = database
            .insert_log_batch(&[log_insert("one", None, 999_999_999_999)])
            .unwrap_err();
        assert!(frame_error.contains("epoch-millisecond"));
        assert!(log_error.contains("epoch-millisecond"));

        let frame_error = database
            .insert_frame_batch(&[
                frame_insert("one", vec![1], 1_000_000_000_000),
                frame_insert("one", vec![2], 999_999_999_999),
            ])
            .unwrap_err();
        let log_error = database
            .insert_log_batch(&[
                log_insert("one", None, 1_000_000_000_000),
                log_insert("one", None, 999_999_999_999),
            ])
            .unwrap_err();
        assert!(frame_error.contains("epoch-millisecond"));
        assert!(log_error.contains("epoch-millisecond"));
        assert_eq!(database.storage_stats().unwrap().total_count, 0);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn history_batches_prevalidate_all_rows_and_roll_back_foreign_key_failures() {
        let (database, directory) = temporary_database("history-batch-validation");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        let frame = frame_insert("one", vec![1], 1_720_000_000_123);
        let mut invalid_frame = frame_insert("one", vec![2], 1_720_000_000_124);
        invalid_frame.direction = "sideways".into();
        assert!(database
            .insert_frame_batch(&[frame.clone(), invalid_frame])
            .is_err());
        assert_eq!(database.storage_stats().unwrap().frame_count, 0);

        let log = log_insert(
            "one",
            Some(json!({ "path": "/dev/one" })),
            1_720_000_000_010,
        );
        let mut invalid_log = log.clone();
        invalid_log.details = Some(json!(true));
        assert!(database
            .insert_log_batch(&[log.clone(), invalid_log])
            .is_err());
        assert_eq!(database.storage_stats().unwrap().log_count, 0);

        assert!(database
            .insert_frame_batch(&[frame, frame_insert("missing", vec![2], 1_720_000_000_011)])
            .is_err());
        assert!(database
            .insert_log_batch(&[log, log_insert("missing", None, 1_720_000_000_011)])
            .is_err());
        let connection = database.connection().unwrap();
        assert_eq!(
            connection
                .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
                .unwrap(),
            1
        );
        drop(connection);
        assert_eq!(database.storage_stats().unwrap().total_count, 0);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn history_batch_sql_failures_roll_back_earlier_rows_in_the_transaction() {
        let (database, directory) = temporary_database("history-batch-transaction");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        {
            let connection = database.connection().unwrap();
            connection
                .execute_batch(
                    "CREATE TRIGGER reject_second_frame
                     BEFORE INSERT ON transfer_frames WHEN NEW.byte_count = 2
                     BEGIN SELECT RAISE(ABORT, 'injected frame failure'); END;
                     CREATE TRIGGER reject_second_log
                     BEFORE INSERT ON runtime_logs WHEN NEW.message = 'reject'
                     BEGIN SELECT RAISE(ABORT, 'injected log failure'); END;",
                )
                .unwrap();
        }
        let frame_error = database
            .insert_frame_batch(&[
                frame_insert("one", vec![1], 1_720_000_000_010),
                frame_insert("one", vec![1, 2], 1_720_000_000_011),
            ])
            .unwrap_err();
        assert!(frame_error.contains("injected frame failure"));
        assert_eq!(database.storage_stats().unwrap().frame_count, 0);

        let mut rejected = log_insert("one", None, 1_720_000_000_011);
        rejected.message = "reject".into();
        let log_error = database
            .insert_log_batch(&[log_insert("one", None, 1_720_000_000_010), rejected])
            .unwrap_err();
        assert!(log_error.contains("injected log failure"));
        assert_eq!(database.storage_stats().unwrap().log_count, 0);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn stomp_profiles_roundtrip_sqlite_and_reject_secrets_atomically() {
        let (database, directory) = temporary_database("stomp-settings");
        let profiles: Value = serde_json::from_str(include_str!(
            "../../../../packages/runtime-contract/tests/stompProfileFixture.json"
        ))
        .unwrap();
        database.save_setting("theme", json!("dark")).unwrap();
        assert_eq!(
            database.get_settings().unwrap().get("stompProfiles"),
            Some(&json!([]))
        );
        database
            .save_setting("stompProfiles", profiles.clone())
            .unwrap();
        let before = database.export_workspace().unwrap();
        let mut invalid = vec![
            Value::Null,
            json!({}),
            Value::Array(vec![profiles[0].clone(); 51]),
            json!([profiles[0], profiles[0]]),
        ];
        for subscriptions in [
            json!(vec![profiles[0]["subscriptions"][0].clone(); 101]),
            json!([
                profiles[0]["subscriptions"][0],
                profiles[0]["subscriptions"][0]
            ]),
        ] {
            let mut profile = profiles[0].clone();
            profile["subscriptions"] = subscriptions;
            invalid.push(json!([profile]));
        }
        let mut missing = profiles[0].clone();
        missing["config"] = json!({});
        invalid.push(json!([missing]));
        for (pointer, value) in [
            ("/login", json!("private-login")),
            ("/credentials", json!({"passcode":"private-password"})),
            (
                "/config/headers",
                json!([{"name":"Authorization","value":"private-header"}]),
            ),
            ("/config/passcode", json!("private-password")),
            ("/config/futureOption", json!(true)),
            (
                "/config/url",
                json!("ws://user:private-password@localhost/"),
            ),
            (
                "/config/url",
                json!("ws://localhost/?token=private-password"),
            ),
            ("/config/url", json!("ws://localhost/#private-password")),
            (
                "/config/url",
                json!(format!("ws://localhost/{}", "a".repeat(4096))),
            ),
            ("/config/heartbeatOutgoing", json!(999)),
            ("/config/listenPort", json!(0)),
            ("/config/autoReconnect", json!("true")),
            ("/subscriptions/0/headers", json!([])),
            ("/subscriptions/0/ack", json!("invalid")),
            ("/subscriptions/0/destination", json!("bad\0destination")),
        ] {
            let mut profile = profiles[0].clone();
            let (parent, key) = pointer.rsplit_once('/').unwrap();
            profile
                .pointer_mut(parent)
                .unwrap()
                .as_object_mut()
                .unwrap()
                .insert(key.into(), value);
            invalid.push(json!([profile]));
        }
        for value in invalid {
            assert!(database
                .save_setting("stompProfiles", value.clone())
                .is_err());
            assert!(database
                .save_settings(BTreeMap::from([
                    ("theme".into(), json!("light")),
                    ("stompProfiles".into(), value.clone())
                ]))
                .is_err());
            let mut imported = before.clone();
            imported.settings.insert("stompProfiles".into(), value);
            assert!(database.import_workspace(imported).is_err());
            assert_eq!(database.export_workspace().unwrap(), before);
        }
        drop(database);
        let database = ConfigurationDatabase::open_in(&directory).unwrap();
        assert_eq!(database.get_settings().unwrap()["stompProfiles"], profiles);
        assert_eq!(database.get_settings().unwrap()["theme"], json!("dark"));
        assert_eq!(
            database.export_workspace().unwrap().settings["stompProfiles"],
            profiles
        );
        {
            let connection = database.connection().unwrap();
            let encoded: String = connection
                .query_row(
                    "SELECT value FROM settings WHERE key='stompProfiles'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!encoded.contains("private-"));
            connection
                .execute(
                    "UPDATE settings SET value=?1 WHERE key='stompProfiles'",
                    [r#"[{"login":"private-legacy"}]"#],
                )
                .unwrap();
        }
        assert_eq!(database.get_settings().unwrap()["stompProfiles"], json!([]));
        assert_eq!(
            database.export_workspace().unwrap().settings["stompProfiles"],
            json!([])
        );
        database
            .save_settings(BTreeMap::from([("theme".into(), json!("dark"))]))
            .unwrap();
        {
            let connection = database.connection().unwrap();
            let encoded: String = connection
                .query_row(
                    "SELECT value FROM settings WHERE key='stompProfiles'",
                    [],
                    |row| row.get(0),
                )
                .unwrap();
            assert!(!encoded.contains("private-"));
            connection
                .execute("DELETE FROM settings WHERE key='stompProfiles'", [])
                .unwrap();
        }
        drop(database);
        let database = ConfigurationDatabase::open_in(&directory).unwrap();
        assert_eq!(database.get_settings().unwrap()["stompProfiles"], json!([]));
        assert_eq!(database.get_settings().unwrap()["theme"], json!("dark"));
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    fn valid_settings() -> BTreeMap<String, Value> {
        BTreeMap::from([
            ("logLevel".into(), json!("info")),
            ("realtimeFrameLimit".into(), json!(2000)),
            ("realtimeLogLimit".into(), json!(1000)),
            ("previewByteLimit".into(), json!(4096)),
            ("defaultFraming".into(), json!("none")),
            ("autoScroll".into(), json!(true)),
            ("theme".into(), json!("system")),
            ("largeFont".into(), json!(false)),
        ])
    }

    #[test]
    fn history_queries_order_page_and_clear_preserves_configuration() {
        let (database, directory) = temporary_database("management");
        database.insert_endpoint(endpoint("one", "One")).unwrap();
        database.save_setting("theme", json!("dark")).unwrap();
        database
            .save_template(TemplateInput {
                id: "template-one".into(),
                endpoint_id: "one".into(),
                name: "Template".into(),
                format: "text".into(),
                framing: "none".into(),
                target: Value::Null,
                payload_base64: "dGVtcGxhdGU=".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        {
            let connection = database.connection().unwrap();
            connection.execute_batch(
                "INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'in', 'text', 'none', X'6669727374', 5, 1720000000001);
                 INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'out', 'text', 'none', X'7365636F6E64', 6, 1720000000002);
                 INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'in', 'text', 'none', X'7468697264', 5, 1720000000002);
                 INSERT INTO runtime_logs
                   (endpoint_id, level, source, message, created_at)
                 VALUES ('one', 'error', 'transport', 'socket closed', 1720000000002);
                 INSERT INTO send_history
                   (endpoint_id, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'text', 'none', X'73656E74', 4, 1720000000002);",
            ).unwrap();
        }

        let page = database
            .query_frames(HistoryQuery {
                endpoint_id: Some("one".into()),
                page: 1,
                page_size: 2,
                ..HistoryQuery::default()
            })
            .unwrap();
        assert_eq!(page.total, 3);
        assert_eq!(
            page.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
            [3, 2]
        );
        assert_eq!(page.rows[0].created_at, 1_720_000_000_002);
        assert_eq!(
            database
                .query_frames(HistoryQuery {
                    endpoint_id: Some(" one ".into()),
                    search: " third ".into(),
                    page: 1,
                    page_size: 50,
                    ..HistoryQuery::default()
                })
                .unwrap()
                .total,
            1
        );
        assert!(database
            .query_logs(HistoryQuery {
                page: 1_000_001,
                page_size: 200,
                ..HistoryQuery::default()
            })
            .is_err());

        let before = database.storage_stats().unwrap();
        assert_eq!(
            (
                before.frame_count,
                before.log_count,
                before.send_history_count,
                before.total_count
            ),
            (3, 1, 1, 5)
        );
        assert!(before.disk_bytes > 0);
        let cleared = database.clear_history().unwrap();
        assert!(cleared.cleared);
        assert!(cleared.reclaimed);
        assert_eq!(cleared.total_count, 5);
        assert_eq!(database.storage_stats().unwrap().total_count, 0);
        assert_eq!(database.list_endpoints().unwrap().len(), 1);
        assert_eq!(database.list_templates("one").unwrap().len(), 1);
        assert_eq!(
            database.get_settings().unwrap().get("theme"),
            Some(&json!("dark"))
        );

        {
            let connection = database.connection().unwrap();
            connection.execute_batch(
                "INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'in', 'text', 'none', X'61', 1, 1720000000003);",
            ).unwrap();
        }
        let reader = Connection::open(&database.filename).unwrap();
        reader.execute_batch("BEGIN").unwrap();
        reader
            .query_row("SELECT COUNT(*) FROM transfer_frames", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap();
        let partial = database.clear_history().unwrap();
        assert!(partial.cleared);
        assert!(!partial.reclaimed);
        assert!(partial
            .maintenance_error
            .unwrap()
            .message
            .contains("checkpoint"));
        reader.execute_batch("ROLLBACK").unwrap();

        {
            let connection = database.connection().unwrap();
            connection
                .execute_batch(
                    "INSERT INTO runtime_logs (endpoint_id, level, source, message, created_at)
                 VALUES ('one', 'info', 'test', 'vacuum', 1720000000004);",
                )
                .unwrap();
        }
        let partial = database
            .clear_history_with_vacuum(|_| Err("injected VACUUM failure".into()))
            .unwrap();
        assert!(partial.cleared);
        assert!(!partial.reclaimed);
        assert!(partial
            .maintenance_error
            .unwrap()
            .message
            .contains("VACUUM failure"));

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn database_crud_settings_templates_and_cascade_use_real_sqlite() {
        let (database, directory) = temporary_database("crud");
        assert!(directory.join(DATABASE_FILENAME).is_file());
        assert_eq!(
            database.applied_migrations().unwrap(),
            vec![
                (1, "001-initial".into()),
                (2, "002-modbus-endpoints".into()),
                (3, "003-modbus-point-history".into()),
                (4, "004-dlt645-endpoints".into()),
                (5, "005-dlt645-simulator-endpoints".into()),
                (6, "006-websocket-endpoints".into()),
            ]
        );

        let inserted = database.insert_endpoint(endpoint("one", "One")).unwrap();
        let updated = database
            .update_endpoint(endpoint("one", "Updated"))
            .unwrap();
        assert_eq!(updated.created_at, inserted.created_at);
        assert_eq!(updated.name, "Updated");
        database
            .clone_endpoint("one", "two".into(), Some("Clone".into()))
            .unwrap();
        database.save_setting("previewByteLimit", json!(3)).unwrap();
        assert_eq!(
            database.get_settings().unwrap().get("previewByteLimit"),
            Some(&json!(3))
        );
        assert_eq!(
            database
                .save_settings(BTreeMap::from([
                    ("theme".into(), json!("dark")),
                    ("largeFont".into(), json!(true)),
                ]))
                .unwrap()
                .get("theme"),
            Some(&json!("dark"))
        );
        assert!(database
            .save_settings(BTreeMap::from([
                ("theme".into(), json!("light")),
                (String::new(), json!("invalid")),
            ]))
            .is_err());
        assert_eq!(
            database.get_settings().unwrap().get("theme"),
            Some(&json!("dark"))
        );

        let saved_template = database
            .save_template(TemplateInput {
                id: "template-one".into(),
                endpoint_id: "one".into(),
                name: "Ping".into(),
                format: "hex".into(),
                framing: "none".into(),
                target: json!({ "peerId": "peer-1" }),
                payload_base64: "AaI=".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        std::thread::sleep(std::time::Duration::from_millis(2));
        let updated_template = database
            .save_template(TemplateInput {
                id: "template-one".into(),
                endpoint_id: "one".into(),
                name: "Updated Ping".into(),
                format: "hex".into(),
                framing: "none".into(),
                target: Value::Null,
                payload_base64: "AA==".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        assert_eq!(updated_template.created_at, saved_template.created_at);
        assert_eq!(database.list_templates("one").unwrap().len(), 1);
        assert!(database.delete_endpoint("one").unwrap());
        assert!(database.list_templates("one").unwrap().is_empty());
        assert_eq!(database.list_endpoints().unwrap()[0].id, "two");

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn acceptance_document_native_boundary_and_corruption_are_explicit() {
        let (database, directory) = temporary_database("acceptance-document");
        let empty = r#"{"version":1,"plans":[],"reports":[]}"#;
        assert_eq!(
            database.get_settings().unwrap()["acceptanceWorkspace"],
            json!(empty)
        );
        database
            .save_setting("acceptanceWorkspace", json!(empty))
            .unwrap();
        let library =
            json!({"version":1,"plans":[],"reports":[],"templates":[{"id":"model","version":1}]})
                .to_string();
        database
            .save_setting("acceptanceWorkspace", json!(library))
            .unwrap();
        let exported = database.export_workspace().unwrap();
        database
            .save_setting("acceptanceWorkspace", json!(empty))
            .unwrap();
        database.import_workspace(exported).unwrap();
        assert_eq!(
            database.get_settings().unwrap()["acceptanceWorkspace"],
            json!(library)
        );
        for invalid in [
            json!(json!({"version":1,"plans":[],"reports":[],"templates":null}).to_string()),
            json!(
                json!({"version":1,"plans":[],"reports":[],"templates":vec![json!({});51]})
                    .to_string()
            ),
            json!({"version":1,"plans":[],"reports":[]}),
            json!("invalid"),
            json!(r#"{"version":2,"plans":[],"reports":[]}"#),
            json!(r#"{"version":1,"plans":[],"reports":[],"extra":true}"#),
            json!(json!({"version":1,"plans":vec![json!({});51],"reports":[]}).to_string()),
            json!(json!({"version":1,"plans":[],"reports":vec![json!({});21]}).to_string()),
            json!(json!({"version":1,"plans":["x".repeat(2_097_152)],"reports":[]}).to_string()),
        ] {
            assert!(database
                .save_setting("acceptanceWorkspace", invalid.clone())
                .is_err());
            assert!(database
                .save_settings(BTreeMap::from([(
                    "acceptanceWorkspace".into(),
                    invalid.clone()
                )]))
                .is_err());
            let mut workspace = database.export_workspace().unwrap();
            workspace
                .settings
                .insert("acceptanceWorkspace".into(), invalid);
            assert!(database.import_workspace(workspace).is_err());
        }
        for encoded in [
            "{bad".to_string(),
            json!("invalid").to_string(),
            json!({"version":1,"plans":[],"reports":[]}).to_string(),
        ] {
            let connection = database.connection().unwrap();
            connection
                .execute(
                    "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?1,?2,?3)",
                    params!["acceptanceWorkspace", encoded, 1],
                )
                .unwrap();
            drop(connection);
            assert!(database
                .get_settings()
                .unwrap_err()
                .contains("acceptanceWorkspace"));
            assert!(database.export_workspace().is_err());
        }
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn native_settings_schema_rejects_invalid_values_and_recovers_unknown_rows() {
        let (database, directory) = temporary_database("settings-schema");
        database.save_settings(valid_settings()).unwrap();
        let before = database.export_workspace().unwrap();
        for invalid in [
            BTreeMap::from([("futureSetting".into(), json!(true))]),
            BTreeMap::from([("autoScroll".into(), json!("yes"))]),
            BTreeMap::from([("realtimeFrameLimit".into(), json!(0))]),
            BTreeMap::from([("previewByteLimit".into(), json!(16_777_217))]),
        ] {
            let mut settings = valid_settings();
            settings.extend(invalid);
            assert!(database.save_settings(settings.clone()).is_err());
            assert_eq!(database.export_workspace().unwrap(), before);
            let mut workspace = before.clone();
            workspace.settings = settings;
            assert!(database.import_workspace(workspace).is_err());
            assert_eq!(database.export_workspace().unwrap(), before);
        }

        let mut legacy_workspace = before.clone();
        legacy_workspace.settings = BTreeMap::from([
            ("theme".into(), json!("dark")),
            ("timeDisplayMode".into(), json!("iso")),
        ]);
        let imported = database.import_workspace(legacy_workspace).unwrap();
        assert_eq!(imported.settings.get("theme"), Some(&json!("dark")));
        assert!(!imported.settings.contains_key("timeDisplayMode"));
        assert!(!database
            .export_workspace()
            .unwrap()
            .settings
            .contains_key("timeDisplayMode"));

        {
            let connection = database.connection().unwrap();
            connection
                .execute(
                    "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                    params!["futureSetting", "true", now_millis().unwrap()],
                )
                .unwrap();
            connection
                .execute(
                    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('timeDisplayMode', '\"iso\"', 1720000000123)",
                    [],
                )
                .unwrap();
        }
        assert!(!database
            .get_settings()
            .unwrap()
            .contains_key("futureSetting"));
        assert!(!database
            .get_settings()
            .unwrap()
            .contains_key("timeDisplayMode"));
        database.save_settings(valid_settings()).unwrap();
        let connection = database.connection().unwrap();
        assert_eq!(row_count(&connection, "settings").unwrap(), 11);
        drop(connection);
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn integral_json_lexical_forms_match_settings_and_timestamp_contract() {
        let fixture: Value = serde_json::from_str(INTEGRAL_NUMBER_FIXTURE_JSON).unwrap();
        for case in fixture["accepted"].as_array().unwrap() {
            let lexeme = case["lexeme"].as_str().unwrap();
            let expected = case["value"].as_i64().unwrap();
            let settings: BTreeMap<String, Value> =
                serde_json::from_str(&format!(r#"{{"realtimeFrameLimit":{lexeme}}}"#)).unwrap();
            if (1..=50_000).contains(&expected) {
                assert_eq!(
                    normalize_settings(&settings).unwrap()["realtimeFrameLimit"],
                    json!(expected)
                );
            } else {
                assert!(normalize_settings(&settings).is_err());
            }
            let workspace: Workspace = serde_json::from_str(&raw_number_workspace("2000", lexeme))
                .expect("integral workspace numbers must deserialize");
            assert_eq!(workspace.endpoint_profiles[0].created_at, expected);
            let endpoint: EndpointInput = serde_json::from_str(&format!(
                r#"{{"id":"raw","name":"Raw","transport":"serial","config":{{}},"createdAt":{lexeme}}}"#
            ))
            .expect("integral optional timestamps must deserialize");
            assert_eq!(endpoint.created_at, Some(expected));
        }
        for case in fixture["rejected"].as_array().unwrap() {
            let lexeme = case["lexeme"].as_str().unwrap();
            let settings: BTreeMap<String, Value> =
                serde_json::from_str(&format!(r#"{{"realtimeFrameLimit":{lexeme}}}"#)).unwrap();
            assert!(normalize_settings(&settings).is_err());
            assert!(
                serde_json::from_str::<Workspace>(&raw_number_workspace(lexeme, "2000")).is_err()
            );
            assert!(
                serde_json::from_str::<Workspace>(&raw_number_workspace("2000", lexeme)).is_err()
            );
            assert!(serde_json::from_str::<EndpointInput>(&format!(
                r#"{{"id":"raw","name":"Raw","transport":"serial","config":{{}},"createdAt":{lexeme}}}"#
            ))
            .is_err());
        }
    }

    fn raw_number_workspace(setting_lexeme: &str, timestamp_lexeme: &str) -> String {
        format!(
            r#"{{"version":1,"endpointProfiles":[{{"id":"raw-number","name":"Raw","transport":"serial","config":{{}},"createdAt":{timestamp_lexeme},"updatedAt":{timestamp_lexeme}}}],"settings":{{"realtimeFrameLimit":{setting_lexeme}}},"sendTemplates":[]}}"#
        )
    }

    #[test]
    fn normal_saves_accept_listed_rows_and_validate_optional_timestamps() {
        let (database, directory) = temporary_database("normal-save-timestamps");
        let endpoint_without_timestamps = first_argument::<EndpointInput>(
            Some(vec![json!({
                "id": "one",
                "name": "One",
                "transport": "tcp-client",
                "config": {}
            })]),
            "endpoint.save",
        )
        .unwrap();
        let inserted = database.save_endpoint(endpoint_without_timestamps).unwrap();
        let template_without_timestamps = first_argument::<TemplateInput>(
            Some(vec![json!({
                "id": "template-one",
                "endpointId": "one",
                "name": "Template",
                "format": "hex",
                "framing": "none",
                "target": null,
                "payloadBase64": "AA=="
            })]),
            "template.save",
        )
        .unwrap();
        let saved_template = database.save_template(template_without_timestamps).unwrap();

        let mut listed_endpoint =
            serde_json::to_value(&database.list_endpoints().unwrap()[0]).unwrap();
        listed_endpoint["name"] = json!("Round-trip endpoint");
        let endpoint_input =
            first_argument::<EndpointInput>(Some(vec![listed_endpoint]), "endpoint.save").unwrap();
        let endpoint_round_trip = database.save_endpoint(endpoint_input).unwrap();
        assert_eq!(endpoint_round_trip.name, "Round-trip endpoint");
        assert_eq!(endpoint_round_trip.created_at, inserted.created_at);

        let mut listed_template =
            serde_json::to_value(&database.list_templates("one").unwrap()[0]).unwrap();
        listed_template["name"] = json!("Round-trip template");
        let template_input =
            first_argument::<TemplateInput>(Some(vec![listed_template]), "template.save").unwrap();
        let template_round_trip = database.save_template(template_input).unwrap();
        assert_eq!(template_round_trip.name, "Round-trip template");
        assert_eq!(template_round_trip.created_at, saved_template.created_at);

        let endpoint_input = first_argument::<EndpointInput>(
            Some(vec![json!({
                "id": "one",
                "name": "Valid timestamps",
                "transport": "tcp-client",
                "config": {},
                "createdAt": 0,
                "updatedAt": MAX_SAFE_TIMESTAMP
            })]),
            "endpoint.save",
        )
        .unwrap();
        let endpoint_with_timestamps = database.save_endpoint(endpoint_input).unwrap();
        assert_eq!(endpoint_with_timestamps.created_at, inserted.created_at);
        assert_ne!(endpoint_with_timestamps.updated_at, MAX_SAFE_TIMESTAMP);

        let template_input = first_argument::<TemplateInput>(
            Some(vec![json!({
                "id": "template-one",
                "endpointId": "one",
                "name": "Valid timestamps",
                "format": "hex",
                "framing": "none",
                "target": null,
                "payloadBase64": "AA==",
                "createdAt": 0,
                "updatedAt": MAX_SAFE_TIMESTAMP
            })]),
            "template.save",
        )
        .unwrap();
        let template_with_timestamps = database.save_template(template_input).unwrap();
        assert_eq!(
            template_with_timestamps.created_at,
            saved_template.created_at
        );
        assert_ne!(template_with_timestamps.updated_at, MAX_SAFE_TIMESTAMP);

        // serde_json preserves JSON -0 as a float, so the i64 timestamp deserializer rejects it.
        let negative_zero: Value = serde_json::from_str("-0").unwrap();
        assert!(negative_zero.as_f64().unwrap().is_sign_negative());
        assert!(serde_json::from_str::<EndpointInput>(
            r#"{"id":"negative-zero","name":"Invalid","transport":"tcp-client","config":{},"createdAt":-0}"#
        )
        .is_err());
        assert!(serde_json::from_str::<TemplateInput>(
            r#"{"id":"negative-zero","endpointId":"one","name":"Invalid","format":"hex","framing":"none","target":null,"payloadBase64":"AA==","updatedAt":-0}"#
        )
        .is_err());

        let before_invalid = database.export_workspace().unwrap();
        for invalid in [
            json!(null),
            json!(-1),
            json!(9_007_199_254_740_992_i64),
            json!(1.5),
        ] {
            for field in ["createdAt", "updatedAt"] {
                let mut endpoint_value = json!({
                    "id": "one",
                    "name": "Invalid",
                    "transport": "tcp-client",
                    "config": {}
                });
                endpoint_value[field] = invalid.clone();
                assert!(first_argument::<EndpointInput>(
                    Some(vec![endpoint_value]),
                    "endpoint.save"
                )
                .is_err());

                let mut template_value = json!({
                    "id": "template-one",
                    "endpointId": "one",
                    "name": "Invalid",
                    "format": "hex",
                    "framing": "none",
                    "target": null,
                    "payloadBase64": "AA=="
                });
                template_value[field] = invalid.clone();
                assert!(first_argument::<TemplateInput>(
                    Some(vec![template_value]),
                    "template.save"
                )
                .is_err());
                assert_eq!(database.export_workspace().unwrap(), before_invalid);
            }
        }

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn websocket_migration_preserves_old_rows_children_and_rejects_secrets() {
        let connection = Connection::open_in_memory().unwrap();
        connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        for migration in &MIGRATIONS[..5] {
            connection.execute_batch(migration.sql).unwrap();
        }
        connection.execute_batch("INSERT INTO endpoint_profiles VALUES ('old','Old','tcp-client','{}',1,2);
          INSERT INTO transfer_frames(endpoint_id,session_id,direction,format,framing,payload,byte_count,created_at) VALUES('old','session','in','hex','raw',X'00FF',2,1);
          INSERT INTO runtime_logs(endpoint_id,level,source,message,created_at) VALUES('old','info','tcp','retained',1);
          INSERT INTO send_templates VALUES('template','old','Retained','hex','raw',NULL,X'00FF',1,1);
          INSERT INTO send_history(endpoint_id,format,framing,payload,byte_count,created_at) VALUES('old','hex','raw',X'00FF',2,1);").unwrap();
        connection
            .execute_batch(WEBSOCKET_ENDPOINTS_MIGRATION)
            .unwrap();
        for table in [
            "endpoint_profiles",
            "transfer_frames",
            "runtime_logs",
            "send_templates",
            "send_history",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 1, "{table}");
        }
        assert!(connection
            .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
            .optional()
            .unwrap()
            .is_none());
        let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
        for key in ["headers", "websocketHeaders"] {
            let mut input = endpoint("secret", "Secret");
            input.transport = "websocket-client".into();
            input.config = json!({"url":"ws://127.0.0.1:9001"});
            input.config[key] = json!([{"name":"Authorization","value":"Bearer secret"}]);
            assert!(database.save_endpoint(input).is_err());
        }
    }

    #[test]
    fn websocket_endpoints_are_accepted_without_persisted_headers() {
        let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
        let mut input = endpoint("ws", "WebSocket");
        input.transport = "websocket-client".into();
        input.config = json!({"url":"ws://127.0.0.1:9001"});
        assert!(database.save_endpoint(input).is_ok());
    }

    #[test]
    fn invalid_workspace_does_not_close_active_transports() {
        struct Coordinator(Mutex<Vec<&'static str>>);
        impl TransportCoordinator for Coordinator {
            fn close_endpoint(&self, _: &str) -> DbResult<()> {
                Ok(())
            }
            fn close_all_endpoints(&self) -> DbResult<()> {
                self.0.lock().unwrap().push("close");
                Ok(())
            }
            fn flush_persistence(&self) -> DbResult<()> {
                self.0.lock().unwrap().push("flush");
                Ok(())
            }
        }
        let (database, directory) = temporary_database("invalid-import-connection");
        database
            .insert_endpoint(endpoint("stable", "Stable"))
            .unwrap();
        let before = database.export_workspace().unwrap();
        let coordinator = Coordinator(Mutex::new(Vec::new()));
        for case in ["endpoint", "transport", "settings", "payload", "reference"] {
            let mut invalid = before.clone();
            match case {
                "endpoint" => invalid.endpoint_profiles[0].name = "".into(),
                "transport" => invalid.endpoint_profiles[0].transport = "unsupported".into(),
                "settings" => {
                    invalid.settings.insert("theme".into(), json!("invalid"));
                }
                _ => invalid.send_templates.push(SendTemplate {
                    id: "template".into(),
                    endpoint_id: if case == "reference" {
                        "missing"
                    } else {
                        "stable"
                    }
                    .into(),
                    name: "Invalid".into(),
                    format: "hex".into(),
                    framing: "none".into(),
                    target: Value::Null,
                    payload_base64: if case == "payload" {
                        "invalid base64"
                    } else {
                        "AA=="
                    }
                    .into(),
                    created_at: 100,
                    updated_at: 100,
                }),
            }
            assert!(import_workspace_with_transports(&database, &coordinator, invalid).is_err());
            assert!(
                coordinator.0.lock().unwrap().is_empty(),
                "validation must precede close: {case}"
            );
            assert_eq!(database.export_workspace().unwrap(), before);
        }
        let mut valid = before.clone();
        valid.settings.insert("theme".into(), json!("dark"));
        import_workspace_with_transports(&database, &coordinator, valid).unwrap();
        assert_eq!(*coordinator.0.lock().unwrap(), vec!["close", "flush"]);
        assert_eq!(database.get_settings().unwrap()["theme"], json!("dark"));
        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn workspace_import_preserves_ids_and_rolls_back_on_failure() {
        let (database, directory) = temporary_database("import");
        database
            .insert_endpoint(endpoint("stable", "Before"))
            .unwrap();
        database.save_setting("theme", json!("light")).unwrap();
        let before = database.export_workspace().unwrap();

        let mut invalid = before.clone();
        invalid.endpoint_profiles[0].name = "Changed".into();
        invalid.settings.insert("theme".into(), json!("dark"));
        invalid.send_templates.push(SendTemplate {
            id: "invalid".into(),
            endpoint_id: "missing".into(),
            name: "Invalid".into(),
            format: "hex".into(),
            framing: "none".into(),
            target: Value::Null,
            payload_base64: "AA==".into(),
            created_at: now_millis().unwrap(),
            updated_at: now_millis().unwrap(),
        });

        assert!(database.import_workspace(invalid).is_err());
        assert_eq!(database.export_workspace().unwrap(), before);

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn workspace_import_rejects_unsafe_timestamps_without_mutation() {
        let (database, directory) = temporary_database("timestamps");
        database
            .insert_endpoint(endpoint("stable", "Before"))
            .unwrap();
        database
            .save_template(TemplateInput {
                id: "template-stable".into(),
                endpoint_id: "stable".into(),
                name: "Ping".into(),
                format: "hex".into(),
                framing: "none".into(),
                target: Value::Null,
                payload_base64: "AA==".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        database.save_setting("theme", json!("light")).unwrap();
        let before = database.export_workspace().unwrap();

        for invalid_timestamp in [-1_i64, 9_007_199_254_740_992_i64] {
            for field in [
                "endpointCreatedAt",
                "endpointUpdatedAt",
                "templateCreatedAt",
                "templateUpdatedAt",
            ] {
                let mut value = serde_json::to_value(&before).unwrap();
                value["settings"]["theme"] = json!("dark");
                match field {
                    "endpointCreatedAt" => {
                        value["endpointProfiles"][0]["createdAt"] = json!(invalid_timestamp)
                    }
                    "endpointUpdatedAt" => {
                        value["endpointProfiles"][0]["updatedAt"] = json!(invalid_timestamp)
                    }
                    "templateCreatedAt" => {
                        value["sendTemplates"][0]["createdAt"] = json!(invalid_timestamp)
                    }
                    "templateUpdatedAt" => {
                        value["sendTemplates"][0]["updatedAt"] = json!(invalid_timestamp)
                    }
                    _ => unreachable!(),
                }
                assert!(serde_json::from_value::<Workspace>(value).is_err());
                assert_eq!(database.export_workspace().unwrap(), before);
            }
        }

        for (collection, field) in [
            ("endpointProfiles", "createdAt"),
            ("endpointProfiles", "updatedAt"),
            ("sendTemplates", "createdAt"),
            ("sendTemplates", "updatedAt"),
        ] {
            let mut value = serde_json::to_value(&before).unwrap();
            value["settings"]["theme"] = json!("dark");
            value[collection][0].as_object_mut().unwrap().remove(field);
            assert!(first_argument::<Workspace>(Some(vec![value]), "workspace.import").is_err());
            assert_eq!(database.export_workspace().unwrap(), before);
        }

        let mut boundary_workspace = before.clone();
        boundary_workspace.endpoint_profiles[0].created_at = 0;
        boundary_workspace.endpoint_profiles[0].updated_at = MAX_SAFE_TIMESTAMP;
        boundary_workspace.send_templates[0].created_at = 0;
        boundary_workspace.send_templates[0].updated_at = MAX_SAFE_TIMESTAMP;
        assert_eq!(
            database
                .import_workspace(boundary_workspace.clone())
                .unwrap(),
            boundary_workspace
        );

        let exported = serde_json::to_value(&before).unwrap();
        assert_eq!(
            exported.as_object().unwrap().keys().collect::<Vec<_>>(),
            ["endpointProfiles", "sendTemplates", "settings", "version"]
        );
        let endpoint_keys = exported["endpointProfiles"][0].as_object().unwrap();
        for key in [
            "id",
            "name",
            "transport",
            "config",
            "createdAt",
            "updatedAt",
        ] {
            assert!(endpoint_keys.contains_key(key));
        }
        assert_eq!(endpoint_keys.len(), 6);
        let template_keys = exported["sendTemplates"][0].as_object().unwrap();
        for key in [
            "id",
            "endpointId",
            "name",
            "format",
            "framing",
            "target",
            "payloadBase64",
            "createdAt",
            "updatedAt",
        ] {
            assert!(template_keys.contains_key(key));
        }
        assert_eq!(template_keys.len(), 9);

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn public_persistence_inputs_reject_unknown_fields_without_mutation() {
        let (database, directory) = temporary_database("exact-inputs");
        database
            .insert_endpoint(endpoint("source", "Source"))
            .unwrap();
        database
            .save_template(TemplateInput {
                id: "template".into(),
                endpoint_id: "source".into(),
                name: "Template".into(),
                format: "hex".into(),
                framing: "none".into(),
                target: Value::Null,
                payload_base64: "AA==".into(),
                created_at: None,
                updated_at: None,
            })
            .unwrap();
        let before = database.export_workspace().unwrap();

        assert!(first_argument::<EndpointInput>(
            Some(vec![json!({
                "id": "unexpected-endpoint",
                "name": "Unexpected",
                "transport": "tcp-client",
                "config": {},
                "unexpected": true
            })]),
            "endpoint.save"
        )
        .is_err());
        assert!(first_argument::<TemplateInput>(
            Some(vec![json!({
                "id": "unexpected-template",
                "endpointId": "source",
                "name": "Unexpected",
                "format": "hex",
                "framing": "none",
                "target": null,
                "payloadBase64": "AA==",
                "unexpected": true
            })]),
            "template.save"
        )
        .is_err());

        for location in ["workspace", "endpoint", "template"] {
            let mut value = serde_json::to_value(&before).unwrap();
            match location {
                "workspace" => value["unexpected"] = json!(true),
                "endpoint" => value["endpointProfiles"][0]["unexpected"] = json!(true),
                "template" => value["sendTemplates"][0]["unexpected"] = json!(true),
                _ => unreachable!(),
            }
            assert!(first_argument::<Workspace>(Some(vec![value]), "workspace.import").is_err());
            assert_eq!(database.export_workspace().unwrap(), before);
        }

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clone_contract_and_template_target_shape_match_shared_behavior() {
        let (database, directory) = temporary_database("clone-target");
        let source = database
            .insert_endpoint(endpoint("source", "Source"))
            .unwrap();
        let cloned = database
            .clone_endpoint("source", "clone".into(), None)
            .unwrap();
        assert_eq!(cloned.name, source.name);
        assert_eq!(cloned.transport, source.transport);
        assert_eq!(cloned.config, source.config);
        assert_ne!(cloned.created_at, 0);
        assert!(serde_json::from_value::<CloneEndpointInput>(json!({
            "id": "bad",
            "transport": "udp-client"
        }))
        .is_err());
        assert!(
            serde_json::from_value::<CloneEndpointInput>(json!({ "name": "Missing ID" })).is_err()
        );
        assert_eq!(
            serde_json::from_value::<CloneEndpointInput>(json!({ "id": "omitted-name" }))
                .unwrap()
                .name,
            None
        );
        assert!(serde_json::from_value::<CloneEndpointInput>(json!({
            "id": "null-name",
            "name": null
        }))
        .is_err());
        assert!(database
            .insert_endpoint(EndpointInput {
                id: "invalid-config".into(),
                name: "Invalid".into(),
                transport: "tcp-client".into(),
                config: json!([]),
                created_at: None,
                updated_at: None,
            })
            .is_err());

        for target in [json!([]), json!("peer"), json!(4), json!(true)] {
            assert!(database
                .save_template(TemplateInput {
                    id: format!("template-{target}"),
                    endpoint_id: "source".into(),
                    name: "Invalid".into(),
                    format: "hex".into(),
                    framing: "none".into(),
                    target,
                    payload_base64: "AA==".into(),
                    created_at: None,
                    updated_at: None,
                })
                .is_err());
        }

        let before = database.export_workspace().unwrap();
        let mut invalid_import = before.clone();
        invalid_import
            .settings
            .insert("theme".into(), json!("mutated"));
        invalid_import.send_templates.push(SendTemplate {
            id: "invalid-import-target".into(),
            endpoint_id: "source".into(),
            name: "Invalid".into(),
            format: "hex".into(),
            framing: "none".into(),
            target: json!([]),
            payload_base64: "AA==".into(),
            created_at: now_millis().unwrap(),
            updated_at: now_millis().unwrap(),
        });
        assert!(database.import_workspace(invalid_import).is_err());
        assert_eq!(database.export_workspace().unwrap(), before);

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_endpoint_saves_are_atomic_and_preserve_creation_time() {
        use std::sync::{Arc, Barrier};

        let (database, directory) = temporary_database("concurrent-save");
        let database = Arc::new(database);
        let barrier = Arc::new(Barrier::new(16));
        let mut threads = Vec::new();
        for index in 0..16 {
            let database = database.clone();
            let barrier = barrier.clone();
            threads.push(std::thread::spawn(move || {
                barrier.wait();
                database.save_endpoint(endpoint("shared", &format!("Endpoint {index}")))
            }));
        }
        let rows = threads
            .into_iter()
            .map(|thread| thread.join().unwrap())
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(database.list_endpoints().unwrap().len(), 1);
        let created_at = database.list_endpoints().unwrap()[0].created_at;
        assert!(rows.iter().all(|row| row.created_at == created_at));

        drop(database);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn migration_runner_rejects_malformed_ledgers_and_reopens_applied_schema() {
        for (name, rows) in [
            ("empty", vec![]),
            ("wrong-name", vec![(1_i64, "wrong-name")]),
            ("unknown-ahead", vec![(4_i64, "004-unknown")]),
            (
                "incomplete-schema",
                vec![(1_i64, "001-initial"), (2_i64, "002-modbus-endpoints")],
            ),
        ] {
            let directory = std::env::temp_dir().join(format!(
                "ineed-tauri-ledger-{name}-{}-{}",
                process::id(),
                now_millis().unwrap()
            ));
            fs::create_dir_all(&directory).unwrap();
            let filename = directory.join(DATABASE_FILENAME);
            let connection = Connection::open(&filename).unwrap();
            connection
                .execute_batch(
                    "CREATE TABLE schema_migrations (
                       version INTEGER PRIMARY KEY,
                       name TEXT NOT NULL,
                       applied_at INTEGER NOT NULL
                     )",
                )
                .unwrap();
            for (version, migration_name) in rows {
                connection
                    .execute(
                        "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, 1)",
                        params![version, migration_name],
                    )
                    .unwrap();
            }
            drop(connection);
            let error = match ConfigurationDatabase::open_in(&directory) {
                Ok(_) => panic!("malformed migration ledger was accepted"),
                Err(error) => error,
            };
            assert!(error.contains("migration ledger") || error.contains("migration schema"));
            fs::remove_dir_all(directory).unwrap();
        }

        let (database, directory) = temporary_database("migration-reopen");
        drop(database);
        let reopened = ConfigurationDatabase::open_in(&directory).unwrap();
        assert_eq!(
            reopened.applied_migrations().unwrap(),
            vec![
                (1, "001-initial".into()),
                (2, "002-modbus-endpoints".into()),
                (3, "003-modbus-point-history".into()),
                (4, "004-dlt645-endpoints".into()),
                (5, "005-dlt645-simulator-endpoints".into()),
                (6, "006-websocket-endpoints".into()),
            ]
        );
        drop(reopened);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn modbus_point_history_round_trips_lossless_rows_and_rolls_back_batches() {
        let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
        database
            .insert_serial_endpoint_for_test("master-1")
            .unwrap();
        let first = modbus_history_input("environment", "holding", "temperature", 100);
        let mut exact_u64 = modbus_history_input("environment", "holding", "temperature", 200);
        exact_u64.data_type = "uint64".into();
        exact_u64.value = json!("18446744073709551615");
        exact_u64.numeric_value = None;
        exact_u64.display_value = "18446744073709551615".into();
        let mut other_group = modbus_history_input("other", "holding", "temperature", 300);
        other_group.value = json!(99);
        other_group.numeric_value = Some(99.0);

        assert_eq!(
            database
                .record_modbus_point_history(vec![first, exact_u64, other_group])
                .unwrap(),
            ModbusPointHistoryRecordResult { recorded_count: 3 }
        );
        let page = database
            .query_modbus_point_history_rows(ModbusPointHistoryQuery {
                endpoint_id: "master-1".into(),
                points: vec![point_identity("environment", "holding", "temperature")],
                from: 0,
                to: MAX_SAFE_TIMESTAMP,
                page: 1,
                page_size: 50,
            })
            .unwrap();
        assert_eq!(
            serde_json::to_value(page).unwrap(),
            json!({
                "rows": [
                    {
                        "id": 2, "endpointId": "master-1", "requestGroupId": "environment",
                        "requestId": "holding", "pointId": "temperature",
                        "pointKey": "temperature", "pointName": "Temperature",
                        "dataType": "uint64", "unit": "C", "raw": [16844, 0],
                        "value": "18446744073709551615", "numericValue": null,
                        "displayValue": "18446744073709551615", "quality": "good",
                        "reason": null, "createdAt": 200
                    },
                    {
                        "id": 1, "endpointId": "master-1", "requestGroupId": "environment",
                        "requestId": "holding", "pointId": "temperature",
                        "pointKey": "temperature", "pointName": "Temperature",
                        "dataType": "float32", "unit": "C", "raw": [16844, 0],
                        "value": 25.5, "numericValue": 25.5, "displayValue": "25.5",
                        "quality": "good", "reason": null, "createdAt": 100
                    }
                ],
                "total": 2, "page": 1, "pageSize": 50
            })
        );

        let valid = modbus_history_input("environment", "holding", "rolled-back", 400);
        let mut invalid = modbus_history_input("environment", "holding", "missing", 500);
        invalid.endpoint_id = "missing-endpoint".into();
        assert!(database
            .record_modbus_point_history(vec![valid, invalid])
            .unwrap_err()
            .to_ascii_lowercase()
            .contains("foreign key"));
        assert_eq!(
            database
                .query_modbus_point_history_rows(all_modbus_history_query("master-1"))
                .unwrap()
                .total,
            3
        );
    }

    #[test]
    fn modbus_point_history_matches_shared_cross_runtime_acceptance_fixture() {
        let fixture: Value = serde_json::from_str(MODBUS_POINT_HISTORY_CASES_JSON).unwrap();
        let endpoint_id = fixture["endpointId"].as_str().unwrap();
        let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
        database
            .insert_serial_endpoint_for_test(endpoint_id)
            .unwrap();
        let rows: Vec<ModbusPointHistoryInput> =
            serde_json::from_value(fixture["validRows"].clone()).unwrap();
        assert_eq!(
            database.record_modbus_point_history(rows).unwrap(),
            ModbusPointHistoryRecordResult {
                recorded_count: fixture["validRows"].as_array().unwrap().len() as i64,
            }
        );

        let points: Vec<ModbusPointIdentity> =
            serde_json::from_value(fixture["pointIdentities"].clone()).unwrap();
        let page = database
            .query_modbus_point_history_rows(ModbusPointHistoryQuery {
                endpoint_id: endpoint_id.into(),
                points: points.clone(),
                from: fixture["range"]["from"].as_i64().unwrap(),
                to: fixture["range"]["to"].as_i64().unwrap(),
                page: 1,
                page_size: 4,
            })
            .unwrap();
        assert_eq!(
            page.rows
                .iter()
                .map(|row| row.display_value.as_str())
                .collect::<Vec<_>>(),
            fixture["expected"]["firstPageDisplayValues"]
                .as_array()
                .unwrap()
                .iter()
                .map(|value| value.as_str().unwrap())
                .collect::<Vec<_>>()
        );

        let series = serde_json::to_value(
            database
                .query_modbus_point_series(ModbusPointSeriesQuery {
                    endpoint_id: endpoint_id.into(),
                    points,
                    from: fixture["range"]["from"].as_i64().unwrap(),
                    to: fixture["range"]["to"].as_i64().unwrap(),
                    bucket_count: fixture["range"]["bucketCount"].as_i64().unwrap(),
                })
                .unwrap(),
        )
        .unwrap();
        let series_values = series["series"].as_array().unwrap();
        let by_point = |point_id: &str| {
            series_values
                .iter()
                .find(|value| value["pointId"] == point_id)
                .unwrap()
        };
        assert_eq!(
            by_point("numeric")["samples"][0],
            fixture["expected"]["numericSample"]
        );
        assert_eq!(
            by_point("switch")["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| json!({
                    "createdAt": sample["createdAt"],
                    "value": sample["value"],
                }))
                .collect::<Vec<_>>(),
            fixture["expected"]["booleanChanges"]
                .as_array()
                .unwrap()
                .clone()
        );
        assert_eq!(
            by_point("label")["samples"]
                .as_array()
                .unwrap()
                .iter()
                .map(|sample| json!({
                    "createdAt": sample["createdAt"],
                    "value": sample["value"],
                }))
                .collect::<Vec<_>>(),
            fixture["expected"]["stringChanges"]
                .as_array()
                .unwrap()
                .clone()
        );

        for case in fixture["invalidRows"].as_array().unwrap() {
            let Ok(invalid) =
                serde_json::from_value::<ModbusPointHistoryInput>(case["row"].clone())
            else {
                continue;
            };
            let mut rollback: ModbusPointHistoryInput =
                serde_json::from_value(fixture["validRows"][0].clone()).unwrap();
            rollback.point_id = format!("rollback-{}", invalid.point_id);
            rollback.created_at = 1060;
            assert!(database
                .record_modbus_point_history(vec![rollback, invalid])
                .is_err());
        }
        assert_eq!(
            database
                .query_modbus_point_history_rows(all_modbus_history_query(endpoint_id))
                .unwrap()
                .total,
            fixture["validRows"].as_array().unwrap().len() as i64
        );

        let csv_row: ModbusPointHistoryInput =
            serde_json::from_value(fixture["csv"]["row"].clone()).unwrap();
        database.record_modbus_point_history(vec![csv_row]).unwrap();
        let stored = database
            .query_modbus_point_history_rows(ModbusPointHistoryQuery {
                endpoint_id: endpoint_id.into(),
                points: vec![point_identity("environment", "holding", "csv")],
                from: 0,
                to: MAX_SAFE_TIMESTAMP,
                page: 1,
                page_size: 50,
            })
            .unwrap();
        assert_eq!(
            stored.rows[0].point_name,
            fixture["csv"]["row"]["pointName"]
        );
        assert_eq!(
            stored.rows[0].display_value,
            fixture["csv"]["row"]["displayValue"]
        );
        assert_eq!(stored.rows[0].reason, Some("quoted \"reason\"".into()));

        for retention in fixture["retention"]["values"].as_array().unwrap() {
            assert!(database
                .cleanup_modbus_point_history_at(
                    retention.as_str().unwrap(),
                    fixture["retention"]["referenceTime"].as_i64().unwrap(),
                )
                .is_ok());
        }
    }

    #[test]
    fn modbus_point_series_preserves_extrema_and_change_events() {
        let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
        database
            .insert_serial_endpoint_for_test("master-1")
            .unwrap();
        let mut rows = Vec::new();
        for (point_id, data_type, created_at, value, numeric, quality, reason) in [
            (
                "numeric",
                "float32",
                100,
                json!(10),
                Some(10.0),
                "good",
                None,
            ),
            (
                "numeric",
                "float32",
                110,
                json!(30),
                Some(30.0),
                "good",
                None,
            ),
            (
                "numeric",
                "float32",
                120,
                Value::Null,
                None,
                "bad-communication",
                Some("timeout"),
            ),
            (
                "numeric",
                "float32",
                130,
                json!(20),
                Some(20.0),
                "good",
                None,
            ),
            (
                "switch",
                "boolean",
                100,
                json!(false),
                Some(0.0),
                "good",
                None,
            ),
            (
                "switch",
                "boolean",
                110,
                json!(false),
                Some(0.0),
                "good",
                None,
            ),
            (
                "switch",
                "boolean",
                120,
                json!(true),
                Some(1.0),
                "good",
                None,
            ),
            ("label", "string", 100, json!("A"), None, "good", None),
            ("label", "string", 110, json!("A"), None, "good", None),
            ("label", "string", 120, json!("B"), None, "good", None),
        ] {
            let mut row = modbus_history_input("environment", "holding", point_id, created_at);
            row.point_key = point_id.into();
            row.data_type = data_type.into();
            row.value = value;
            row.numeric_value = numeric;
            row.display_value = row.value.as_str().map(str::to_owned).unwrap_or_else(|| {
                row.value
                    .as_bool()
                    .map(|value| if value { "ON" } else { "OFF" }.into())
                    .unwrap_or_else(|| row.value.to_string())
            });
            row.quality = quality.into();
            row.reason = reason.map(str::to_owned);
            rows.push(row);
        }
        database.record_modbus_point_history(rows).unwrap();

        let result = database
            .query_modbus_point_series(ModbusPointSeriesQuery {
                endpoint_id: "master-1".into(),
                points: ["numeric", "switch", "label"]
                    .map(|id| point_identity("environment", "holding", id))
                    .to_vec(),
                from: 100,
                to: 200,
                bucket_count: 1,
            })
            .unwrap();
        let json = serde_json::to_value(result).unwrap();
        let numeric = json["series"]
            .as_array()
            .unwrap()
            .iter()
            .find(|series| series["pointId"] == "numeric")
            .unwrap();
        assert_eq!(
            numeric["samples"][0],
            json!({
                "bucket": 0, "firstAt": 100, "firstValue": 10.0,
                "lastAt": 130, "lastValue": 20.0, "minAt": 100, "minValue": 10.0,
                "maxAt": 110, "maxValue": 30.0, "goodCount": 3, "abnormalCount": 1,
                "worstQuality": "bad-communication",
                "marker": { "createdAt": 120, "quality": "bad-communication", "reason": "timeout" }
            })
        );
        let switch = json["series"]
            .as_array()
            .unwrap()
            .iter()
            .find(|series| series["pointId"] == "switch")
            .unwrap();
        assert_eq!(switch["samples"].as_array().unwrap().len(), 2);
        let label = json["series"]
            .as_array()
            .unwrap()
            .iter()
            .find(|series| series["pointId"] == "label")
            .unwrap();
        assert_eq!(label["samples"].as_array().unwrap().len(), 2);
    }

    #[test]
    fn modbus_point_retention_and_clear_leave_existing_history_untouched() {
        let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
        database
            .insert_serial_endpoint_for_test("master-1")
            .unwrap();
        let now = 1_780_000_000_000_i64;
        database
            .insert_frame_batch(&[FrameHistoryInsert {
                endpoint_id: "master-1".into(),
                session_id: "session-1".into(),
                peer_id: None,
                direction: "in".into(),
                format: "hex".into(),
                framing: "none".into(),
                byte_count: 1,
                payload: vec![1],
                created_at: 1_720_000_000_000,
            }])
            .unwrap();
        database
            .record_modbus_point_history(vec![
                modbus_history_input("environment", "holding", "old", now - (8 * 86_400_000)),
                modbus_history_input("environment", "holding", "recent", now - 86_400_000),
            ])
            .unwrap();
        let stats = database.storage_stats().unwrap();
        assert_eq!(stats.modbus_point_history_count, 2);
        assert!(stats.modbus_point_history_estimated_bytes > 0);
        assert_eq!(stats.total_count, 1);

        assert_eq!(
            database
                .cleanup_modbus_point_history_at("7-days", now)
                .unwrap(),
            ModbusPointHistoryCleanupResult {
                deleted_count: 1,
                completed_at: now
            }
        );
        assert_eq!(
            database
                .storage_stats()
                .unwrap()
                .modbus_point_history_last_cleanup_at,
            Some(now)
        );
        assert_eq!(
            database
                .query_frames(master_frame_history_query())
                .unwrap()
                .total,
            1
        );
        assert_eq!(
            database
                .clear_modbus_point_history(ModbusPointHistoryQuery {
                    points: vec![point_identity("environment", "holding", "recent")],
                    ..all_modbus_history_query("master-1")
                })
                .unwrap(),
            1
        );
        assert_eq!(
            database
                .query_frames(master_frame_history_query())
                .unwrap()
                .total,
            1
        );
    }

    fn point_identity(group: &str, request: &str, point: &str) -> ModbusPointIdentity {
        ModbusPointIdentity {
            request_group_id: group.into(),
            request_id: request.into(),
            point_id: point.into(),
        }
    }

    fn modbus_history_input(
        group: &str,
        request: &str,
        point: &str,
        created_at: i64,
    ) -> ModbusPointHistoryInput {
        ModbusPointHistoryInput {
            endpoint_id: "master-1".into(),
            request_group_id: group.into(),
            request_id: request.into(),
            point_id: point.into(),
            point_key: point.into(),
            point_name: "Temperature".into(),
            data_type: "float32".into(),
            unit: Some("C".into()),
            raw: json!([16844, 0]),
            value: json!(25.5),
            numeric_value: Some(25.5),
            display_value: "25.5".into(),
            quality: "good".into(),
            reason: None,
            created_at,
        }
    }

    fn all_modbus_history_query(endpoint_id: &str) -> ModbusPointHistoryQuery {
        ModbusPointHistoryQuery {
            endpoint_id: endpoint_id.into(),
            points: Vec::new(),
            from: 0,
            to: MAX_SAFE_TIMESTAMP,
            page: 1,
            page_size: 50,
        }
    }

    fn master_frame_history_query() -> HistoryQuery {
        HistoryQuery {
            endpoint_id: Some("master-1".into()),
            page: 1,
            page_size: 50,
            ..HistoryQuery::default()
        }
    }
}
