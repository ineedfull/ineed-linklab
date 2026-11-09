mod database;
mod modbus;
pub mod opcua;
mod persistence;
mod runtime;
mod serial;
mod stomp;
mod tcp;
mod transport;
mod udp;
mod websocket;
#[doc(hidden)]
pub use stomp::run_native_harness as run_stomp_harness;
#[doc(hidden)]
pub use websocket::run_native_harness as run_websocket_harness;

use std::{
    fs::create_dir_all,
    io,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc, Condvar, Mutex,
    },
    time::{Duration, Instant},
};

use tauri::{
    menu::{MenuBuilder, PredefinedMenuItem, SubmenuBuilder},
    Emitter, Manager,
};

const SHUTDOWN_ATTEMPTS: usize = 2;
const SHUTDOWN_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Default)]
struct RendererShutdownState {
    request_id: Option<String>,
    acknowledged: bool,
}

#[derive(Default)]
pub(crate) struct RendererShutdownHandshake {
    next_id: AtomicU64,
    state: Mutex<RendererShutdownState>,
    changed: Condvar,
}

impl RendererShutdownHandshake {
    fn begin(&self) -> String {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.request_id.is_some() && !state.acknowledged {
            return state.request_id.clone().expect("pending request ID");
        }
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let request_id = format!("shutdown-{id}");
        state.request_id = Some(request_id.clone());
        state.acknowledged = false;
        request_id
    }

    pub(crate) fn ready(&self, request_id: &str) -> bool {
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        if state.request_id.as_deref() != Some(request_id) || state.acknowledged {
            return false;
        }
        state.acknowledged = true;
        self.changed.notify_all();
        true
    }

    fn wait(&self, request_id: &str, timeout: Duration) -> bool {
        let deadline = Instant::now() + timeout;
        let mut state = self.state.lock().unwrap_or_else(|error| error.into_inner());
        while state.request_id.as_deref() == Some(request_id) && !state.acknowledged {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                break;
            }
            let (next, wait) = self
                .changed
                .wait_timeout(state, remaining)
                .unwrap_or_else(|error| error.into_inner());
            state = next;
            if wait.timed_out() {
                break;
            }
        }
        let acknowledged = state.request_id.as_deref() == Some(request_id) && state.acknowledged;
        if state.request_id.as_deref() == Some(request_id) {
            state.request_id = None;
            state.acknowledged = false;
        }
        acknowledged
    }
}

trait ShutdownTarget: Send + Sync + 'static {
    fn shutdown(&self) -> Result<(), String>;
    fn force_shutdown(&self) -> Vec<String>;
    fn disconnect_event_sink(&self);
}

impl ShutdownTarget for serial::SerialService {
    fn shutdown(&self) -> Result<(), String> {
        serial::SerialService::shutdown(self).map_err(|error| error.to_string())
    }

    fn force_shutdown(&self) -> Vec<String> {
        serial::SerialService::force_shutdown(self)
    }

    fn disconnect_event_sink(&self) {
        serial::SerialService::disconnect_event_sink(self);
    }
}

impl ShutdownTarget for tcp::TcpService {
    fn shutdown(&self) -> Result<(), String> {
        tcp::TcpService::shutdown(self).map_err(|error| error.to_string())
    }

    fn force_shutdown(&self) -> Vec<String> {
        tcp::TcpService::force_shutdown(self)
    }

    fn disconnect_event_sink(&self) {
        tcp::TcpService::disconnect_event_sink(self);
    }
}

impl ShutdownTarget for udp::UdpService {
    fn shutdown(&self) -> Result<(), String> {
        udp::UdpService::shutdown(self).map_err(|error| error.to_string())
    }

    fn force_shutdown(&self) -> Vec<String> {
        udp::UdpService::force_shutdown(self)
    }

    fn disconnect_event_sink(&self) {
        udp::UdpService::disconnect_event_sink(self);
    }
}

trait PersistenceShutdownTarget: Send + Sync + 'static {
    fn flush(&self) -> Result<(), String>;
    fn shutdown(&self) -> Result<(), String>;
}

impl PersistenceShutdownTarget for persistence::TransportPersistence {
    fn flush(&self) -> Result<(), String> {
        persistence::TransportPersistence::flush(self)
    }

    fn shutdown(&self) -> Result<(), String> {
        persistence::TransportPersistence::shutdown(self)
    }
}

#[derive(Debug, PartialEq, Eq)]
enum ShutdownOutcome {
    Graceful {
        attempts: usize,
    },
    ForcedAfterError {
        attempts: usize,
        error: String,
        process_exit_fallback: Vec<String>,
    },
    ForcedAfterTimeout {
        process_exit_fallback: Vec<String>,
    },
}

struct TransportShutdownResult {
    serial: ShutdownOutcome,
    tcp: ShutdownOutcome,
    udp: ShutdownOutcome,
    persistence_errors: Vec<String>,
}

fn run_bounded_shutdown(
    target: Arc<dyn ShutdownTarget>,
    attempts: usize,
    timeout: Duration,
) -> ShutdownOutcome {
    let attempts = attempts.max(1);
    let worker_target = target.clone();
    let (result_tx, result_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        for attempt in 1..=attempts {
            match worker_target.shutdown() {
                Ok(()) => {
                    let _ = result_tx.send(Ok(attempt));
                    return;
                }
                Err(error) if attempt == attempts => {
                    let _ = result_tx.send(Err((attempt, error)));
                    return;
                }
                Err(_) => {}
            }
        }
    });

    match result_rx.recv_timeout(timeout) {
        Ok(Ok(attempts)) => ShutdownOutcome::Graceful { attempts },
        Ok(Err((attempts, error))) => {
            let process_exit_fallback = target.force_shutdown();
            ShutdownOutcome::ForcedAfterError {
                attempts,
                error,
                process_exit_fallback,
            }
        }
        Err(mpsc::RecvTimeoutError::Timeout) => {
            let process_exit_fallback = target.force_shutdown();
            ShutdownOutcome::ForcedAfterTimeout {
                process_exit_fallback,
            }
        }
        Err(mpsc::RecvTimeoutError::Disconnected) => {
            let process_exit_fallback = target.force_shutdown();
            ShutdownOutcome::ForcedAfterError {
                attempts: 0,
                error: "serial shutdown worker disconnected".into(),
                process_exit_fallback,
            }
        }
    }
}

fn run_transport_shutdown(
    serial: Arc<dyn ShutdownTarget>,
    tcp: Arc<dyn ShutdownTarget>,
    udp: Arc<dyn ShutdownTarget>,
    persistence: Arc<dyn PersistenceShutdownTarget>,
    attempts: usize,
    timeout: Duration,
) -> TransportShutdownResult {
    let serial_outcome = run_bounded_shutdown(serial.clone(), attempts, timeout);
    let tcp_outcome = run_bounded_shutdown(tcp.clone(), attempts, timeout);
    let udp_outcome = run_bounded_shutdown(udp.clone(), attempts, timeout);
    let mut persistence_errors = Vec::new();
    if let Err(error) = persistence.flush() {
        persistence_errors.push(format!("flush: {error}"));
    }
    if let Err(error) = persistence.shutdown() {
        persistence_errors.push(format!("shutdown: {error}"));
    }
    serial.disconnect_event_sink();
    tcp.disconnect_event_sink();
    udp.disconnect_event_sink();
    TransportShutdownResult {
        serial: serial_outcome,
        tcp: tcp_outcome,
        udp: udp_outcome,
        persistence_errors,
    }
}

pub struct AppState {
    pub app_data_dir: PathBuf,
    pub(crate) database: Arc<database::ConfigurationDatabase>,
    pub(crate) serial_service: Arc<serial::SerialService>,
    pub(crate) tcp_service: Arc<tcp::TcpService>,
    pub(crate) udp_service: Arc<udp::UdpService>,
    pub(crate) modbus_service: Arc<modbus::ModbusService>,
    pub(crate) stomp_service: Arc<stomp::StompService>,
    pub(crate) opcua_service: Arc<opcua::OpcUaService>,
    pub(crate) websocket_service: Arc<websocket::WebSocketService>,
    pub(crate) persistence: Arc<persistence::TransportPersistence>,
    pub(crate) transport_coordinator: Arc<transport::TauriTransportCoordinator>,
    pub(crate) renderer_shutdown: Arc<RendererShutdownHandshake>,
    shutdown_started: AtomicBool,
    shutdown_finished: AtomicBool,
}

pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .on_window_event(|window, event| {
            if window.label() == "main" {
                if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                    api.prevent_close();
                    start_shutdown(window.app_handle(), 0);
                }
            }
        })
        .setup(|app| {
            let app_data_dir = app.path().app_data_dir()?;
            create_dir_all(&app_data_dir)?;
            let database_directory = app_data_dir.clone();
            let database = tauri::async_runtime::block_on(runtime::spawn_blocking(move || {
                database::ConfigurationDatabase::open_in(&database_directory)
            }))
            .map_err(io::Error::other)?;
            let database = Arc::new(database);
            let transport_wiring = transport::TauriTransportWiring::new(database.clone());
            let persistence = transport_wiring.persistence();
            let serial_service = Arc::new(serial::SerialService::new(
                Arc::new(serial::RealSerialBackend),
                Arc::new(transport_wiring.event_sink(app.handle().clone())),
            ));
            let tcp_service = Arc::new(tcp::TcpService::new(Arc::new(
                transport_wiring.event_sink(app.handle().clone()),
            )));
            let udp_service = Arc::new(udp::UdpService::new(Arc::new(
                transport_wiring.event_sink(app.handle().clone()),
            )));
            let modbus_service = Arc::new(modbus::ModbusService::new(
                Arc::new(transport_wiring.event_sink(app.handle().clone())),
                Arc::new(transport_wiring.event_sink(app.handle().clone())),
            ));
            let websocket_service = Arc::new(websocket::WebSocketService::new(Arc::new(
                transport_wiring.event_sink(app.handle().clone()),
            )));
            let transport_coordinator = Arc::new(
                transport_wiring
                    .coordinator(
                        serial_service.clone(),
                        tcp_service.clone(),
                        udp_service.clone(),
                    )
                    .with_modbus(modbus_service.clone())
                    .with_websocket(websocket_service.clone()),
            );
            let opcua_handle = app.handle().clone();
            let opcua_service = Arc::new(opcua::OpcUaService::new(
                app_data_dir.clone(),
                move |event| {
                    let _ = opcua_handle.emit("opcua:event", event);
                },
            ));
            let stomp_handle = app.handle().clone();
            let stomp_events = Arc::new(Mutex::new(stomp::StompEventBatcher::new(move |event| {
                if let Some(window) = stomp_handle.get_webview_window("main") {
                    let _ = window.emit("stomp:event", event);
                }
            })));
            // Keep protocol input intact while avoiding one WKWebView task per
            // WebSocket message. The weak timer ends with this service's sink.
            let pending_events = Arc::downgrade(&stomp_events);
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(Duration::from_millis(8)).await;
                    let Some(events) = pending_events.upgrade() else {
                        break;
                    };
                    events.lock().unwrap().flush_due(Instant::now());
                }
            });
            let stomp_service = Arc::new(stomp::StompService::new(move |event| {
                stomp_events.lock().unwrap().push(event, Instant::now());
            }));
            app.manage(AppState {
                stomp_service,
                app_data_dir,
                opcua_service,
                websocket_service,
                database,
                serial_service: serial_service.clone(),
                tcp_service: tcp_service.clone(),
                udp_service: udp_service.clone(),
                modbus_service: modbus_service.clone(),
                persistence,
                transport_coordinator,
                renderer_shutdown: Arc::new(RendererShutdownHandshake::default()),
                shutdown_started: AtomicBool::new(false),
                shutdown_finished: AtomicBool::new(false),
            });
            app.set_menu(build_menu(app)?)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            database::endpoint_list,
            database::endpoint_save,
            database::endpoint_clone,
            database::endpoint_delete,
            transport::transport_scan_serial_ports,
            transport::transport_open,
            transport::transport_cancel_open,
            transport::transport_close,
            transport::transport_send,
            transport::transport_disconnect_peer,
            opcua::opcua_execute,
            stomp::stomp_execute,
            modbus::modbus_execute,
            modbus::modbus_read_map,
            modbus::modbus_write_map,
            database::modbus_history_record_batch,
            database::modbus_history_query_series,
            database::modbus_history_query_rows,
            database::modbus_history_export_csv,
            database::modbus_history_clear,
            database::modbus_history_cleanup,
            database::modbus_history_flush,
            database::history_query_frames,
            database::history_query_logs,
            database::template_list,
            database::template_save,
            database::template_delete,
            database::send_history_record,
            database::send_history_query,
            database::send_history_delete,
            database::send_history_clear,
            runtime::history_delete,
            runtime::history_clear,
            database::settings_get_all,
            database::settings_save,
            database::settings_save_all,
            database::workspace_export,
            database::workspace_import,
            database::storage_stats,
            database::storage_clear_history,
            runtime::window_open_history,
            runtime::window_open_website,
            runtime::lifecycle_ready_for_shutdown,
        ])
        .build(tauri::generate_context!())
        .expect("failed to build Ineed LinkLab");
    app.run(|app_handle, event| {
        if let tauri::RunEvent::ExitRequested { api, code, .. } = event {
            let state = app_handle.state::<AppState>();
            if !state.shutdown_finished.load(Ordering::SeqCst) {
                api.prevent_exit();
                start_shutdown(app_handle, code.unwrap_or(0));
            }
        }
    });
}

fn start_shutdown(app_handle: &tauri::AppHandle, exit_code: i32) {
    let state = app_handle.state::<AppState>();
    if state.shutdown_started.swap(true, Ordering::SeqCst) {
        return;
    }
    let serial_service = state.serial_service.clone();
    let tcp_service = state.tcp_service.clone();
    let udp_service = state.udp_service.clone();
    let modbus_service = state.modbus_service.clone();
    let stomp_service = state.stomp_service.clone();
    let opcua_service = state.opcua_service.clone();
    let websocket_service = state.websocket_service.clone();
    let persistence = state.persistence.clone();
    let renderer_shutdown = state.renderer_shutdown.clone();
    let app_handle = app_handle.clone();
    std::thread::spawn(move || {
        let request_id = renderer_shutdown.begin();
        if let Some(window) = app_handle.get_webview_window("main") {
            let emitted = window
                .emit(
                    "lifecycle:before-shutdown",
                    serde_json::json!({ "requestId": request_id }),
                )
                .is_ok();
            if emitted {
                renderer_shutdown.wait(&request_id, SHUTDOWN_TIMEOUT);
            }
        }
        let _ = stomp_service.shutdown();
        let _ = websocket_service.shutdown();
        tauri::async_runtime::block_on(opcua_service.shutdown());
        if let Err(error) = modbus_service.shutdown() {
            eprintln!("Modbus shutdown failed: {error}");
            for fallback in modbus_service.force_shutdown() {
                eprintln!("Modbus resource unrecovered; process exit fallback: {fallback}");
            }
        }
        let serial_target: Arc<dyn ShutdownTarget> = serial_service.clone();
        let tcp_target: Arc<dyn ShutdownTarget> = tcp_service.clone();
        let udp_target: Arc<dyn ShutdownTarget> = udp_service.clone();
        let persistence: Arc<dyn PersistenceShutdownTarget> = persistence;
        let result = run_transport_shutdown(
            serial_target,
            tcp_target,
            udp_target,
            persistence,
            SHUTDOWN_ATTEMPTS,
            SHUTDOWN_TIMEOUT,
        );
        for error in result.persistence_errors {
            eprintln!("transport persistence shutdown failed: {error}");
        }
        record_shutdown_outcome("serial", &result.serial);
        record_shutdown_outcome("tcp", &result.tcp);
        record_shutdown_outcome("udp", &result.udp);
        app_handle
            .state::<AppState>()
            .shutdown_finished
            .store(true, Ordering::SeqCst);
        app_handle.exit(exit_code);
    });
}

fn record_shutdown_outcome(transport: &str, outcome: &ShutdownOutcome) {
    let process_exit_fallback = match outcome {
        ShutdownOutcome::Graceful { .. } => return,
        ShutdownOutcome::ForcedAfterError {
            attempts,
            error,
            process_exit_fallback,
        } => {
            eprintln!(
                "{transport} shutdown failed after {attempts} attempts; forced cleanup: {error}"
            );
            process_exit_fallback
        }
        ShutdownOutcome::ForcedAfterTimeout {
            process_exit_fallback,
        } => {
            eprintln!("{transport} shutdown exceeded 2 seconds; forced cleanup");
            process_exit_fallback
        }
    };
    for failure in process_exit_fallback {
        eprintln!("{transport} resource unrecovered; process exit fallback: {failure}");
    }
}

fn build_menu<R: tauri::Runtime>(app: &tauri::App<R>) -> tauri::Result<tauri::menu::Menu<R>> {
    let app_menu = SubmenuBuilder::new(app, "Ineed LinkLab")
        .item(&PredefinedMenuItem::quit(app, Some("退出 Ineed LinkLab"))?)
        .build()?;
    let edit_menu = SubmenuBuilder::new(app, "编辑")
        .item(&PredefinedMenuItem::undo(app, Some("撤销"))?)
        .item(&PredefinedMenuItem::redo(app, Some("重做"))?)
        .separator()
        .item(&PredefinedMenuItem::cut(app, Some("剪切"))?)
        .item(&PredefinedMenuItem::copy(app, Some("复制"))?)
        .item(&PredefinedMenuItem::paste(app, Some("粘贴"))?)
        .item(&PredefinedMenuItem::select_all(app, Some("全选"))?)
        .build()?;

    MenuBuilder::new(app)
        .items(&[&app_menu, &edit_menu])
        .build()
}

#[cfg(test)]
mod shutdown_tests {
    use super::*;
    use std::{
        collections::VecDeque,
        sync::{atomic::AtomicUsize, Condvar, Mutex},
        time::{Duration, Instant},
    };

    #[test]
    fn renderer_shutdown_handshake_joins_requests_and_accepts_only_the_matching_id() {
        let handshake = RendererShutdownHandshake::default();
        let first = handshake.begin();
        assert_eq!(handshake.begin(), first);
        assert!(!handshake.ready("stale"));
        assert!(handshake.ready(&first));
        assert!(handshake.wait(&first, Duration::from_millis(1)));

        let second = handshake.begin();
        assert_ne!(second, first);
        assert!(!handshake.wait(&second, Duration::from_millis(1)));
    }

    struct FakeShutdownTarget {
        outcomes: Mutex<VecDeque<Result<(), String>>>,
        attempts: AtomicUsize,
        force_calls: AtomicUsize,
        force_failures: Mutex<Vec<String>>,
        block: Option<Arc<(Mutex<bool>, Condvar)>>,
    }

    impl FakeShutdownTarget {
        fn new(outcomes: Vec<Result<(), &str>>) -> Self {
            Self {
                outcomes: Mutex::new(
                    outcomes
                        .into_iter()
                        .map(|result| result.map_err(str::to_owned))
                        .collect(),
                ),
                attempts: AtomicUsize::new(0),
                force_calls: AtomicUsize::new(0),
                force_failures: Mutex::new(Vec::new()),
                block: None,
            }
        }

        fn blocked() -> Self {
            Self {
                outcomes: Mutex::new(VecDeque::from([Ok(())])),
                attempts: AtomicUsize::new(0),
                force_calls: AtomicUsize::new(0),
                force_failures: Mutex::new(Vec::new()),
                block: Some(Arc::new((Mutex::new(false), Condvar::new()))),
            }
        }
    }

    impl ShutdownTarget for FakeShutdownTarget {
        fn shutdown(&self) -> Result<(), String> {
            self.attempts.fetch_add(1, Ordering::SeqCst);
            if let Some(block) = &self.block {
                let (released, changed) = &**block;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
            }
            self.outcomes.lock().unwrap().pop_front().unwrap_or(Ok(()))
        }

        fn force_shutdown(&self) -> Vec<String> {
            self.force_calls.fetch_add(1, Ordering::SeqCst);
            if let Some(block) = &self.block {
                *block.0.lock().unwrap() = true;
                block.1.notify_all();
            }
            self.force_failures.lock().unwrap().clone()
        }

        fn disconnect_event_sink(&self) {}
    }

    struct OrderedShutdownTarget {
        order: Arc<Mutex<Vec<&'static str>>>,
        close_label: &'static str,
        force_label: &'static str,
        disconnect_label: &'static str,
    }

    impl ShutdownTarget for OrderedShutdownTarget {
        fn shutdown(&self) -> Result<(), String> {
            self.order.lock().unwrap().push(self.close_label);
            Ok(())
        }

        fn force_shutdown(&self) -> Vec<String> {
            self.order.lock().unwrap().push(self.force_label);
            Vec::new()
        }

        fn disconnect_event_sink(&self) {
            self.order.lock().unwrap().push(self.disconnect_label);
        }
    }

    struct OrderedPersistenceTarget {
        order: Arc<Mutex<Vec<&'static str>>>,
    }

    impl PersistenceShutdownTarget for OrderedPersistenceTarget {
        fn flush(&self) -> Result<(), String> {
            self.order.lock().unwrap().push("persistence-flush");
            Err("injected flush failure".into())
        }

        fn shutdown(&self) -> Result<(), String> {
            self.order.lock().unwrap().push("persistence-shutdown");
            Err("injected shutdown failure".into())
        }
    }

    #[test]
    fn bounded_shutdown_retries_once_then_finishes_gracefully() {
        let target = Arc::new(FakeShutdownTarget::new(vec![Err("first"), Ok(())]));
        let outcome = run_bounded_shutdown(target.clone(), 2, Duration::from_secs(1));

        assert_eq!(outcome, ShutdownOutcome::Graceful { attempts: 2 });
        assert_eq!(target.attempts.load(Ordering::SeqCst), 2);
        assert_eq!(target.force_calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn bounded_shutdown_forces_cleanup_after_retry_errors() {
        let target = Arc::new(FakeShutdownTarget::new(vec![Err("first"), Err("second")]));
        let outcome = run_bounded_shutdown(target.clone(), 2, Duration::from_secs(1));

        assert_eq!(
            outcome,
            ShutdownOutcome::ForcedAfterError {
                attempts: 2,
                error: "second".into(),
                process_exit_fallback: Vec::new(),
            }
        );
        assert_eq!(target.force_calls.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn bounded_shutdown_forces_cleanup_at_deadline_without_hanging() {
        let target = Arc::new(FakeShutdownTarget::blocked());
        let started = Instant::now();
        let outcome = run_bounded_shutdown(target.clone(), 2, Duration::from_millis(30));

        assert_eq!(
            outcome,
            ShutdownOutcome::ForcedAfterTimeout {
                process_exit_fallback: Vec::new(),
            }
        );
        assert_eq!(target.force_calls.load(Ordering::SeqCst), 1);
        assert!(started.elapsed() < Duration::from_millis(500));
    }

    #[test]
    fn bounded_shutdown_preserves_unrecovered_force_handles_for_exit_logging() {
        let target = Arc::new(FakeShutdownTarget::new(vec![Err("first"), Err("second")]));
        *target.force_failures.lock().unwrap() = vec!["serial-1: force close failed".into()];

        let outcome = run_bounded_shutdown(target.clone(), 2, Duration::from_secs(1));

        assert_eq!(target.force_calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            outcome,
            ShutdownOutcome::ForcedAfterError {
                attempts: 2,
                error: "second".into(),
                process_exit_fallback: vec!["serial-1: force close failed".into()],
            }
        );
    }

    #[test]
    fn transport_shutdown_orders_cleanup_and_isolates_persistence_errors() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let result = run_transport_shutdown(
            Arc::new(OrderedShutdownTarget {
                order: order.clone(),
                close_label: "serial-close",
                force_label: "serial-force",
                disconnect_label: "serial-sink-disconnect",
            }),
            Arc::new(OrderedShutdownTarget {
                order: order.clone(),
                close_label: "tcp-close",
                force_label: "tcp-force",
                disconnect_label: "tcp-sink-disconnect",
            }),
            Arc::new(OrderedShutdownTarget {
                order: order.clone(),
                close_label: "udp-close",
                force_label: "udp-force",
                disconnect_label: "udp-sink-disconnect",
            }),
            Arc::new(OrderedPersistenceTarget {
                order: order.clone(),
            }),
            1,
            Duration::from_secs(1),
        );

        assert_eq!(result.serial, ShutdownOutcome::Graceful { attempts: 1 });
        assert_eq!(result.tcp, ShutdownOutcome::Graceful { attempts: 1 });
        assert_eq!(result.udp, ShutdownOutcome::Graceful { attempts: 1 });
        assert_eq!(
            result.persistence_errors,
            vec![
                "flush: injected flush failure".to_owned(),
                "shutdown: injected shutdown failure".to_owned(),
            ]
        );
        assert_eq!(
            *order.lock().unwrap(),
            vec![
                "serial-close",
                "tcp-close",
                "udp-close",
                "persistence-flush",
                "persistence-shutdown",
                "serial-sink-disconnect",
                "tcp-sink-disconnect",
                "udp-sink-disconnect",
            ]
        );
    }
}
