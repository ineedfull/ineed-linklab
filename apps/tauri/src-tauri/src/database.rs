mod configuration;
mod file_io;
mod history;
mod point_history;
mod schema;
mod settings;
use file_io::*;
use history::*;
use point_history::*;
use schema::*;
use settings::*;

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
#[path = "database/tests.rs"]
mod tests;
