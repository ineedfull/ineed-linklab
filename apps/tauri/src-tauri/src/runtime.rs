use std::fmt::Write as _;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const RUNTIME_NAME: &str = "tauri";

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ErrorDetails {
    name: &'static str,
    method: &'static str,
    runtime_name: &'static str,
    code: &'static str,
    message: String,
}

#[derive(Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Envelope {
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    value: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ErrorDetails>,
}

pub(crate) fn success(value: Value) -> Envelope {
    Envelope {
        ok: true,
        value: Some(value),
        error: None,
    }
}

pub(crate) fn opcua_failure(message: String) -> Envelope {
    Envelope {
        ok: false,
        value: None,
        error: Some(ErrorDetails {
            name: "OpcuaError",
            method: "opcua.execute",
            runtime_name: RUNTIME_NAME,
            code: "OPCUA_ERROR",
            message,
        }),
    }
}

pub(crate) fn database_failure(method: &'static str, message: String) -> Envelope {
    Envelope {
        ok: false,
        value: None,
        error: Some(ErrorDetails {
            name: "PersistenceError",
            method,
            runtime_name: RUNTIME_NAME,
            code: "PERSISTENCE_ERROR",
            message,
        }),
    }
}

pub(crate) fn serial_failure(method: &'static str, error: crate::serial::SerialError) -> Envelope {
    let code = match error.code {
        crate::serial::SerialErrorCode::PortNotFound => "PORT_NOT_FOUND",
        crate::serial::SerialErrorCode::PortBusy => "PORT_BUSY",
        crate::serial::SerialErrorCode::PermissionDenied => "PERMISSION_DENIED",
        crate::serial::SerialErrorCode::OpenCancelled => "OPEN_CANCELLED",
        crate::serial::SerialErrorCode::DeviceRemoved => "DEVICE_REMOVED",
        crate::serial::SerialErrorCode::ModbusException => "MODBUS_EXCEPTION",
        crate::serial::SerialErrorCode::IoError => "IO_ERROR",
    };
    Envelope {
        ok: false,
        value: None,
        error: Some(ErrorDetails {
            name: "SerialError",
            method,
            runtime_name: RUNTIME_NAME,
            code,
            message: error.message,
        }),
    }
}

fn is_history_window_label(label: &str) -> bool {
    let Some(scope) = label
        .strip_prefix("history-frames-")
        .or_else(|| label.strip_prefix("history-logs-"))
    else {
        return false;
    };
    if scope == "scope-none" {
        return true;
    }
    let Some(hex) = scope.strip_prefix("id-") else {
        return false;
    };
    !hex.is_empty()
        && hex.len() % 2 == 0
        && hex
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

pub(crate) fn authorize_window(label: &str, method: &'static str) -> Option<Envelope> {
    if label == "main" {
        return None;
    }
    let (code, message) = if !is_history_window_label(label) {
        (
            "UNTRUSTED_WINDOW",
            format!("Window {label:?} is not trusted for {method}"),
        )
    } else if matches!(
        method,
        "history.queryFrames" | "history.queryLogs" | "settings.getAll"
    ) {
        return None;
    } else {
        (
            "UNAUTHORIZED_METHOD",
            format!("Window {label:?} is not authorized for {method}"),
        )
    };
    Some(Envelope {
        ok: false,
        value: None,
        error: Some(ErrorDetails {
            name: "SecurityError",
            method,
            runtime_name: RUNTIME_NAME,
            code,
            message,
        }),
    })
}

pub(crate) async fn spawn_blocking<F, T>(operation: F) -> Result<T, String>
where
    F: FnOnce() -> Result<T, String> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(operation)
        .await
        .map_err(|error| format!("background database task failed: {error}"))?
}

pub(crate) fn unavailable(method: &'static str) -> Envelope {
    Envelope {
        ok: false,
        value: None,
        error: Some(ErrorDetails {
            name: "RuntimeUnavailableError",
            method,
            runtime_name: RUNTIME_NAME,
            code: "RUNTIME_UNAVAILABLE",
            message: format!("Runtime method \"{method}\" is unavailable in {RUNTIME_NAME}"),
        }),
    }
}

#[cfg(test)]
fn read(_args: Option<Vec<Value>>, value: Value) -> Envelope {
    success(value)
}

fn reject(_args: Option<Vec<Value>>, method: &'static str) -> Envelope {
    unavailable(method)
}

macro_rules! authorize_command {
    ($window:expr, $method:literal) => {
        if let Some(denied) = authorize_window($window.label(), $method) {
            return denied;
        }
    };
}

#[cfg(test)]
pub(crate) fn endpoint_list(args: Option<Vec<Value>>) -> Envelope {
    read(args, json!([]))
}
#[cfg(test)]
pub(crate) fn endpoint_save(args: Option<Vec<Value>>) -> Envelope {
    reject(args, "endpoint.save")
}
#[cfg(test)]
pub(crate) fn endpoint_delete(args: Option<Vec<Value>>) -> Envelope {
    reject(args, "endpoint.delete")
}
#[cfg(test)]
pub(crate) fn history_query_frames(args: Option<Vec<Value>>) -> Envelope {
    read(args, empty_page())
}
#[cfg(test)]
pub(crate) fn history_query_logs(args: Option<Vec<Value>>) -> Envelope {
    read(args, empty_page())
}
#[tauri::command]
pub(crate) fn history_delete(window: WebviewWindow, args: Option<Vec<Value>>) -> Envelope {
    authorize_command!(window, "history.delete");
    reject(args, "history.delete")
}
#[tauri::command]
pub(crate) fn history_clear(window: WebviewWindow, args: Option<Vec<Value>>) -> Envelope {
    authorize_command!(window, "history.clear");
    reject(args, "history.clear")
}

#[tauri::command]
pub(crate) fn lifecycle_ready_for_shutdown(
    window: WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    args: Option<Vec<Value>>,
) -> Envelope {
    authorize_command!(window, "lifecycle.readyForShutdown");
    let request_id = args
        .and_then(|values| values.into_iter().next())
        .and_then(|value| value.as_str().map(str::to_owned));
    let Some(request_id) = request_id else {
        return database_failure(
            "lifecycle.readyForShutdown",
            "lifecycle.readyForShutdown requires a request ID".into(),
        );
    };
    success(json!({ "acknowledged": state.renderer_shutdown.ready(&request_id) }))
}
#[cfg(test)]
pub(crate) fn settings_get_all(args: Option<Vec<Value>>) -> Envelope {
    read(args, json!({}))
}
#[cfg(test)]
pub(crate) fn settings_save(args: Option<Vec<Value>>) -> Envelope {
    reject(args, "settings.save")
}
#[cfg(test)]
pub(crate) fn workspace_export(args: Option<Vec<Value>>) -> Envelope {
    reject(args, "workspace.export")
}
#[cfg(test)]
pub(crate) fn workspace_import(args: Option<Vec<Value>>) -> Envelope {
    reject(args, "workspace.import")
}
#[cfg(test)]
pub(crate) fn storage_stats(args: Option<Vec<Value>>) -> Envelope {
    read(
        args,
        json!({ "frameCount": 0, "logCount": 0, "sendHistoryCount": 0, "totalCount": 0, "diskBytes": 0 }),
    )
}
#[cfg(test)]
pub(crate) fn storage_clear_history(args: Option<Vec<Value>>) -> Envelope {
    reject(args, "storage.clearHistory")
}
#[derive(Debug, Clone, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct HistoryWindowRequest {
    kind: String,
    endpoint_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct HistoryWindowSpec {
    label: String,
    url: String,
    title: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum HistoryWindowOutcome {
    Created,
    Focused,
}

trait HistoryWindowHost {
    fn focus_existing(&mut self, label: &str) -> Result<bool, String>;
    fn create(&mut self, spec: &HistoryWindowSpec) -> Result<(), String>;
}

fn history_window_spec(request: &HistoryWindowRequest) -> Result<HistoryWindowSpec, String> {
    if !matches!(request.kind.as_str(), "frames" | "logs") {
        return Err("history kind must be frames or logs".into());
    }
    let scope = match request.endpoint_id.as_deref() {
        None => "scope-none".to_owned(),
        Some(endpoint_id) => {
            validate_endpoint_id(endpoint_id)?;
            let mut encoded = String::with_capacity(3 + endpoint_id.len() * 2);
            encoded.push_str("id-");
            for byte in endpoint_id.as_bytes() {
                write!(encoded, "{byte:02x}").map_err(|error| error.to_string())?;
            }
            encoded
        }
    };
    let mut url = Url::parse("https://local/index.html").map_err(|error| error.to_string())?;
    {
        let mut query = url.query_pairs_mut();
        query.append_pair("view", "history");
        query.append_pair("kind", &request.kind);
        if let Some(endpoint_id) = &request.endpoint_id {
            query.append_pair("endpointId", endpoint_id);
        }
    }
    let query = url
        .query()
        .ok_or_else(|| "history query is missing".to_owned())?;
    Ok(HistoryWindowSpec {
        label: format!("history-{}-{scope}", request.kind),
        url: format!("index.html?{query}"),
        title: if request.kind == "frames" {
            "历史消息".into()
        } else {
            "历史日志".into()
        },
    })
}

fn validate_endpoint_id(endpoint_id: &str) -> Result<(), String> {
    if endpoint_id.trim().is_empty() {
        return Err("endpoint ID must be nonblank".into());
    }
    if endpoint_id.len() > 128 {
        return Err("endpoint ID must be at most 128 bytes".into());
    }
    if endpoint_id
        .chars()
        .any(|character| character == '/' || character == '\\' || character.is_control())
    {
        return Err("endpoint ID contains invalid characters".into());
    }
    Ok(())
}

fn open_history_window<H: HistoryWindowHost>(
    host: &mut H,
    request: &HistoryWindowRequest,
) -> Result<HistoryWindowOutcome, String> {
    let spec = history_window_spec(request)?;
    if host.focus_existing(&spec.label)? {
        return Ok(HistoryWindowOutcome::Focused);
    }
    host.create(&spec)?;
    Ok(HistoryWindowOutcome::Created)
}

fn history_window_envelope(result: Result<HistoryWindowOutcome, String>) -> Envelope {
    match result {
        Ok(HistoryWindowOutcome::Created) => success(json!({ "focused": false })),
        Ok(HistoryWindowOutcome::Focused) => success(json!({ "focused": true })),
        Err(error) => database_failure("window.openHistory", error),
    }
}

struct TauriHistoryWindowHost<'a> {
    app: &'a AppHandle,
}

impl HistoryWindowHost for TauriHistoryWindowHost<'_> {
    fn focus_existing(&mut self, label: &str) -> Result<bool, String> {
        let Some(window) = self.app.get_webview_window(label) else {
            return Ok(false);
        };
        window.set_focus().map_err(|error| error.to_string())?;
        Ok(true)
    }

    fn create(&mut self, spec: &HistoryWindowSpec) -> Result<(), String> {
        WebviewWindowBuilder::new(
            self.app,
            &spec.label,
            WebviewUrl::App(spec.url.clone().into()),
        )
        .title(&spec.title)
        .inner_size(1180.0, 760.0)
        .min_inner_size(820.0, 520.0)
        .build()
        .map_err(|error| error.to_string())?;
        Ok(())
    }
}

#[tauri::command]
pub(crate) fn window_open_history(
    window: WebviewWindow,
    app: AppHandle,
    args: Option<Vec<Value>>,
) -> Envelope {
    authorize_command!(window, "window.openHistory");
    let result = (|| -> Result<HistoryWindowOutcome, String> {
        let request_value = args
            .and_then(|values| values.into_iter().next())
            .ok_or_else(|| "window.openHistory requires an argument".to_owned())?;
        let request: HistoryWindowRequest =
            serde_json::from_value(request_value).map_err(|error| error.to_string())?;
        open_history_window(&mut TauriHistoryWindowHost { app: &app }, &request)
    })();
    history_window_envelope(result)
}

// No renderer-provided URL or shell command is accepted here.
#[tauri::command]
pub(crate) async fn window_open_website(window: WebviewWindow) -> Envelope {
    authorize_command!(window, "window.openWebsite");
    let result = tauri::async_runtime::spawn_blocking(open_product_website).await;
    match result {
        Ok(Ok(())) => success(Value::Null),
        error => Envelope {
            ok: false,
            value: None,
            error: Some(ErrorDetails {
                name: "BrowserOpenError",
                method: "window.openWebsite",
                runtime_name: RUNTIME_NAME,
                code: "BROWSER_OPEN_FAILED",
                message: format!("Unable to open the product website: {error:?}"),
            }),
        },
    }
}

fn open_product_website() -> Result<(), String> {
    const WEBSITE: &str = "https://linklab.ineedfull.com/";
    #[cfg(target_os = "macos")]
    let mut command = std::process::Command::new("/usr/bin/open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = std::process::Command::new("rundll32.exe");
        command.arg("url.dll,FileProtocolHandler");
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = std::process::Command::new("xdg-open");
    let status = command
        .arg(WEBSITE)
        .status()
        .map_err(|error| error.to_string())?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("Browser launcher exited with {status}"))
    }
}

#[cfg(test)]
fn empty_page() -> Value {
    json!({ "rows": [], "total": 0, "page": 1, "pageSize": 100 })
}

#[cfg(test)]
mod tests {
    use std::collections::{BTreeMap, BTreeSet};

    use super::*;

    #[derive(Default)]
    struct FakeHistoryWindowHost {
        windows: BTreeMap<String, HistoryWindowSpec>,
        creates: Vec<HistoryWindowSpec>,
        focuses: Vec<String>,
        focus_error: Option<String>,
        create_error: Option<String>,
    }

    impl HistoryWindowHost for FakeHistoryWindowHost {
        fn focus_existing(&mut self, label: &str) -> Result<bool, String> {
            if self.windows.contains_key(label) {
                self.focuses.push(label.to_owned());
                if let Some(error) = self.focus_error.take() {
                    return Err(error);
                }
                return Ok(true);
            }
            Ok(false)
        }

        fn create(&mut self, spec: &HistoryWindowSpec) -> Result<(), String> {
            if let Some(error) = self.create_error.take() {
                return Err(error);
            }
            self.creates.push(spec.clone());
            self.windows.insert(spec.label.clone(), spec.clone());
            Ok(())
        }
    }

    #[test]
    fn history_window_specs_have_injective_labels_and_round_trip_queries() {
        let cases = [
            None,
            Some("all"),
            Some("a.b"),
            Some("a_b"),
            Some("a:b"),
            Some("Unicode-中文"),
            Some("space value"),
            Some("a&b"),
            Some("a?b"),
            Some("a#b"),
            Some("a%b"),
        ];
        let mut labels = BTreeSet::new();

        for endpoint_id in cases {
            let request = HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: endpoint_id.map(str::to_owned),
            };
            let spec = history_window_spec(&request).unwrap();
            assert!(
                labels.insert(spec.label.clone()),
                "duplicate label: {}",
                spec.label
            );
            assert!(spec
                .label
                .chars()
                .all(|character| character.is_ascii_lowercase()
                    || character.is_ascii_digit()
                    || character == '-'));
            let parsed = Url::parse(&format!("https://local/{}", spec.url)).unwrap();
            let query = parsed
                .query_pairs()
                .into_owned()
                .collect::<BTreeMap<_, _>>();
            assert_eq!(query.get("view").map(String::as_str), Some("history"));
            assert_eq!(query.get("kind").map(String::as_str), Some("frames"));
            assert_eq!(query.get("endpointId").map(String::as_str), endpoint_id);
            assert_eq!(spec.title, "历史消息");
        }

        assert_eq!(
            history_window_spec(&HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: None
            })
            .unwrap()
            .label,
            "history-frames-scope-none",
        );
        assert_eq!(
            history_window_spec(&HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: Some("all".into())
            })
            .unwrap()
            .label,
            "history-frames-id-616c6c",
        );
    }

    #[test]
    fn history_window_specs_validate_kind_and_endpoint_bounds_before_encoding() {
        for request in [
            HistoryWindowRequest {
                kind: "other".into(),
                endpoint_id: None,
            },
            HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: Some(String::new()),
            },
            HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: Some("   ".into()),
            },
            HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: Some("../settings".into()),
            },
            HistoryWindowRequest {
                kind: "frames".into(),
                endpoint_id: Some("x\\y".into()),
            },
            HistoryWindowRequest {
                kind: "logs".into(),
                endpoint_id: Some("x".repeat(129)),
            },
        ] {
            assert!(history_window_spec(&request).is_err());
        }
    }

    #[test]
    fn history_endpoint_validation_matches_cross_runtime_cases() {
        #[derive(Deserialize)]
        struct EndpointIdCases {
            accepted: Vec<String>,
            rejected: Vec<String>,
        }
        let cases: EndpointIdCases = serde_json::from_str(include_str!(
            "../../../../packages/runtime-contract/tests/historyEndpointIdCases.json"
        ))
        .unwrap();
        for endpoint_id in cases.accepted {
            assert!(
                validate_endpoint_id(&endpoint_id).is_ok(),
                "{endpoint_id:?}"
            );
        }
        for endpoint_id in cases.rejected {
            assert!(
                validate_endpoint_id(&endpoint_id).is_err(),
                "{endpoint_id:?}"
            );
        }
    }

    #[test]
    fn history_window_boundary_creates_then_focuses_without_duplicates() {
        let mut host = FakeHistoryWindowHost::default();
        let first = HistoryWindowRequest {
            kind: "frames".into(),
            endpoint_id: Some("a.b".into()),
        };
        let first_spec = history_window_spec(&first).unwrap();
        assert_eq!(
            first_spec,
            HistoryWindowSpec {
                label: "history-frames-id-612e62".into(),
                url: "index.html?view=history&kind=frames&endpointId=a.b".into(),
                title: "历史消息".into(),
            },
        );

        assert_eq!(
            open_history_window(&mut host, &first).unwrap(),
            HistoryWindowOutcome::Created
        );
        assert_eq!(host.creates.as_slice(), std::slice::from_ref(&first_spec));
        assert_eq!(
            open_history_window(&mut host, &first).unwrap(),
            HistoryWindowOutcome::Focused
        );
        assert_eq!(host.creates, [first_spec]);
        assert_eq!(host.focuses.len(), 1);

        let other_endpoint = HistoryWindowRequest {
            kind: "frames".into(),
            endpoint_id: Some("a_b".into()),
        };
        let other_kind = HistoryWindowRequest {
            kind: "logs".into(),
            endpoint_id: Some("a.b".into()),
        };
        assert_eq!(history_window_spec(&other_kind).unwrap().title, "历史日志");
        assert_eq!(
            open_history_window(&mut host, &other_endpoint).unwrap(),
            HistoryWindowOutcome::Created
        );
        assert_eq!(
            open_history_window(&mut host, &other_kind).unwrap(),
            HistoryWindowOutcome::Created
        );
        assert_eq!(host.creates.len(), 3);
        assert_eq!(host.windows.len(), 3);
    }

    #[test]
    fn history_window_boundary_returns_focus_and_create_failures() {
        let request = HistoryWindowRequest {
            kind: "logs".into(),
            endpoint_id: None,
        };
        let spec = history_window_spec(&request).unwrap();
        let mut focus_host = FakeHistoryWindowHost::default();
        focus_host.windows.insert(spec.label.clone(), spec);
        focus_host.focus_error = Some("focus failed".into());
        assert_eq!(
            open_history_window(&mut focus_host, &request),
            Err("focus failed".into())
        );

        let mut create_host = FakeHistoryWindowHost {
            create_error: Some("create failed".into()),
            ..Default::default()
        };
        assert_eq!(
            open_history_window(&mut create_host, &request),
            Err("create failed".into())
        );
    }

    #[test]
    fn history_window_failures_use_controlled_command_envelopes() {
        assert_eq!(
            serde_json::to_value(history_window_envelope(Err("focus failed".into()))).unwrap(),
            json!({
                "ok": false,
                "error": {
                    "name": "PersistenceError",
                    "method": "window.openHistory",
                    "runtimeName": "tauri",
                    "code": "PERSISTENCE_ERROR",
                    "message": "focus failed"
                }
            }),
        );
    }

    #[test]
    fn history_window_authorization_allows_only_queries_and_settings_reads() {
        for label in ["history-frames-scope-none", "history-logs-id-612e62"] {
            for method in [
                "history.queryFrames",
                "history.queryLogs",
                "settings.getAll",
            ] {
                assert_eq!(authorize_window(label, method), None, "{label} {method}");
            }
            for method in [
                "endpoint.list",
                "settings.save",
                "settings.saveAll",
                "workspace.import",
                "storage.stats",
                "storage.clearHistory",
                "window.openHistory",
                "window.openWebsite",
                "transport.scanSerialPorts",
                "modbusHistory.recordBatch",
                "modbusHistory.exportCsv",
                "modbusHistory.clear",
                "modbusHistory.cleanup",
            ] {
                let denied = authorize_window(label, method).expect("method must be denied");
                assert_eq!(
                    serde_json::to_value(denied).unwrap(),
                    json!({
                        "ok": false,
                        "error": {
                            "name": "SecurityError",
                            "method": method,
                            "runtimeName": "tauri",
                            "code": "UNAUTHORIZED_METHOD",
                            "message": format!("Window {label:?} is not authorized for {method}")
                        }
                    }),
                );
            }
        }
    }

    #[test]
    fn window_authorization_rejects_unowned_labels_and_accepts_main_commands() {
        for method in ["endpoint.save", "workspace.export", "storage.clearHistory"] {
            assert_eq!(authorize_window("main", method), None);
        }
        for label in [
            "other",
            "history-frames",
            "history-frames-id-",
            "history-frames-id-xyz",
            "history-other-scope-none",
        ] {
            let denied = authorize_window(label, "history.queryFrames").unwrap();
            assert_eq!(denied.error.unwrap().code, "UNTRUSTED_WINDOW");
        }
    }

    #[test]
    fn read_envelopes_have_phase_one_defaults() {
        assert_eq!(endpoint_list(None), success(json!([])));
        assert_eq!(history_query_frames(None), success(empty_page()));
        assert_eq!(history_query_logs(None), success(empty_page()));
        assert_eq!(settings_get_all(None), success(json!({})));
        assert_eq!(
            storage_stats(None),
            success(
                json!({ "frameCount": 0, "logCount": 0, "sendHistoryCount": 0, "totalCount": 0, "diskBytes": 0 })
            ),
        );
    }

    #[test]
    fn unavailable_envelope_serializes_consistent_camel_case_metadata() {
        let envelope = endpoint_save(None);
        assert_eq!(envelope, unavailable("endpoint.save"));
        assert_eq!(
            serde_json::to_value(envelope).unwrap(),
            json!({
                "ok": false,
                "error": {
                    "name": "RuntimeUnavailableError",
                    "method": "endpoint.save",
                    "runtimeName": "tauri",
                    "code": "RUNTIME_UNAVAILABLE",
                    "message": "Runtime method \"endpoint.save\" is unavailable in tauri"
                }
            })
        );
    }

    #[test]
    fn every_command_maps_to_its_dotted_runtime_method() {
        type StubCommand = fn(Option<Vec<Value>>) -> Envelope;
        let mutations: [(&str, StubCommand); 6] = [
            ("endpoint.save", endpoint_save),
            ("endpoint.delete", endpoint_delete),
            ("settings.save", settings_save),
            ("workspace.export", workspace_export),
            ("workspace.import", workspace_import),
            ("storage.clearHistory", storage_clear_history),
        ];

        for (method, command) in mutations {
            assert_eq!(command(None), unavailable(method));
        }
    }
}
