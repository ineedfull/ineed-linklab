use serde::Deserialize;
use serde_json::{json, Value};
use tauri::{Emitter, State, WebviewWindow};

use std::sync::Arc;

use crate::{
    database, modbus, persistence::TransportPersistence, runtime, serial, tcp, udp, websocket,
    AppState,
};

macro_rules! authorize_command {
    ($window:expr, $method:literal) => {
        if let Some(denied) = runtime::authorize_window($window.label(), $method) {
            return Ok(denied);
        }
    };
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct OperationOptions {
    operation_id: String,
    #[serde(default)]
    websocket_headers: Vec<websocket::WebSocketHeader>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SendRequest {
    endpoint_id: String,
    bytes: Vec<u8>,
    #[serde(default)]
    target: Option<Value>,
    #[serde(default)]
    framing: Option<String>,
    #[serde(default)]
    message_type: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct DisconnectPeerRequest {
    endpoint_id: String,
    #[serde(default)]
    peer_id: Option<String>,
    #[serde(default)]
    target: Option<Value>,
}

impl DisconnectPeerRequest {
    fn peer_id(&self) -> serial::SerialResult<&str> {
        self.peer_id
            .as_deref()
            .or_else(|| {
                self.target
                    .as_ref()
                    .and_then(|target| target.get("peerId"))
                    .and_then(Value::as_str)
            })
            .map(str::trim)
            .filter(|peer_id| !peer_id.is_empty())
            .ok_or_else(|| argument_error("peerId must be a nonblank string"))
    }
}

pub(crate) struct TauriSerialEventSink {
    app: tauri::AppHandle,
    dispatch: PersistenceEventDispatch,
}

pub(crate) struct PersistenceEventDispatch {
    persistence: Arc<TransportPersistence>,
}

impl PersistenceEventDispatch {
    fn emit<F>(&self, event: serial::SerialEvent, forward: F)
    where
        F: FnOnce(serial::SerialEvent),
    {
        self.persistence.handle_then_forward(event, forward);
    }
}

pub(crate) struct TauriTransportWiring {
    persistence: Arc<TransportPersistence>,
}

impl TauriTransportWiring {
    pub(crate) fn new(database: Arc<database::ConfigurationDatabase>) -> Self {
        Self {
            persistence: Arc::new(TransportPersistence::new(database)),
        }
    }

    pub(crate) fn persistence(&self) -> Arc<TransportPersistence> {
        self.persistence.clone()
    }

    pub(crate) fn event_dispatch(&self) -> PersistenceEventDispatch {
        PersistenceEventDispatch {
            persistence: self.persistence.clone(),
        }
    }

    pub(crate) fn event_sink(&self, app: tauri::AppHandle) -> TauriSerialEventSink {
        TauriSerialEventSink {
            app,
            dispatch: self.event_dispatch(),
        }
    }

    pub(crate) fn coordinator(
        &self,
        serial_service: Arc<serial::SerialService>,
        tcp_service: Arc<tcp::TcpService>,
        udp_service: Arc<udp::UdpService>,
    ) -> TauriTransportCoordinator {
        TauriTransportCoordinator::new(
            serial_service,
            tcp_service,
            udp_service,
            self.persistence.clone(),
        )
    }
}

impl serial::SerialEventSink for TauriSerialEventSink {
    fn emit(&self, event: serial::SerialEvent) {
        self.dispatch.emit(event, |event| {
            let result = match event {
                serial::SerialEvent::Status(status) => {
                    self.app.emit_to("main", "transport:status", status)
                }
                serial::SerialEvent::Frames(batch) => {
                    self.app.emit_to("main", "transport:frames", batch)
                }
                serial::SerialEvent::Peers(peers) => {
                    self.app.emit_to("main", "transport:peers", peers)
                }
            };
            if let Err(error) = result {
                eprintln!("failed to emit transport event: {error}");
            }
        });
    }
}

impl modbus::ModbusEventSink for TauriSerialEventSink {
    fn emit(&self, transaction: modbus::ModbusTransaction) {
        if let Err(error) = self.app.emit_to("main", "modbus:transaction", transaction) {
            eprintln!("failed to emit Modbus transaction: {error}");
        }
    }
}

#[tauri::command]
pub(crate) async fn transport_scan_serial_ports(
    window: WebviewWindow,
    state: State<'_, AppState>,
    _args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "transport.scanSerialPorts");
    let service = state.serial_service.clone();
    Ok(
        match runtime::spawn_blocking(move || Ok(service.scan())).await {
            Ok(Ok(records)) => {
                runtime::success(serde_json::to_value(records).unwrap_or_else(|_| json!([])))
            }
            Ok(Err(error)) => runtime::serial_failure("transport.scanSerialPorts", error),
            Err(error) => runtime::serial_failure(
                "transport.scanSerialPorts",
                serial::SerialError::new(serial::SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn transport_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "transport.open");
    let (endpoint_id, operation) = match open_arguments(args) {
        Ok(arguments) => arguments,
        Err(error) => return Ok(runtime::serial_failure("transport.open", error)),
    };
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    Ok(
        match runtime::spawn_blocking(move || {
            let snapshot = match database.endpoint_snapshot(&endpoint_id) {
                Ok(snapshot) => snapshot,
                Err(message) => {
                    return Ok(Err(serial::SerialError::new(
                        serial::SerialErrorCode::IoError,
                        message,
                    )))
                }
            };
            let Some(snapshot) = snapshot else {
                return Ok(Err(serial::SerialError::new(
                    serial::SerialErrorCode::PortNotFound,
                    format!("Endpoint {endpoint_id} was not found"),
                )));
            };
            Ok(coordinator.open_with_headers(
                snapshot,
                &operation.operation_id,
                &operation.websocket_headers,
            ))
        })
        .await
        {
            Ok(Ok(value)) => runtime::success(serde_json::to_value(value).unwrap_or(Value::Null)),
            Ok(Err(error)) => runtime::serial_failure("transport.open", error),
            Err(error) => runtime::serial_failure(
                "transport.open",
                serial::SerialError::new(serial::SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn transport_cancel_open(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "transport.cancelOpen");
    let (endpoint_id, operation) = match open_arguments(args) {
        Ok(arguments) => arguments,
        Err(error) => return Ok(runtime::serial_failure("transport.cancelOpen", error)),
    };
    let service = state.transport_coordinator.clone();
    Ok(
        match runtime::spawn_blocking(move || {
            Ok(service.cancel_open(&endpoint_id, &operation.operation_id))
        })
        .await
        {
            Ok(Ok(value)) => runtime::success(serde_json::to_value(value).unwrap_or(Value::Null)),
            Ok(Err(error)) => runtime::serial_failure("transport.cancelOpen", error),
            Err(error) => runtime::serial_failure(
                "transport.cancelOpen",
                serial::SerialError::new(serial::SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn transport_close(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "transport.close");
    let endpoint_id = match first_string(args, "transport.close endpointId") {
        Ok(value) => value,
        Err(error) => return Ok(runtime::serial_failure("transport.close", error)),
    };
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    Ok(
        match runtime::spawn_blocking(move || {
            let snapshot = match database.endpoint_snapshot(&endpoint_id) {
                Ok(snapshot) => snapshot,
                Err(message) => {
                    return Ok(Err(serial::SerialError::new(
                        serial::SerialErrorCode::IoError,
                        message,
                    )))
                }
            };
            let Some(snapshot) = snapshot else {
                return Ok(Err(serial::SerialError::new(
                    serial::SerialErrorCode::PortNotFound,
                    format!("Endpoint {endpoint_id} was not found"),
                )));
            };
            Ok(coordinator.close(snapshot))
        })
        .await
        {
            Ok(Ok(value)) => runtime::success(serde_json::to_value(value).unwrap_or(Value::Null)),
            Ok(Err(error)) => runtime::serial_failure("transport.close", error),
            Err(error) => runtime::serial_failure(
                "transport.close",
                serial::SerialError::new(serial::SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn transport_send(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "transport.send");
    let request = match first_argument::<SendRequest>(args, "transport.send request") {
        Ok(value) => value,
        Err(error) => return Ok(runtime::serial_failure("transport.send", error)),
    };
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    Ok(
        match runtime::spawn_blocking(move || {
            let snapshot = match database.endpoint_snapshot(&request.endpoint_id) {
                Ok(snapshot) => snapshot,
                Err(message) => {
                    return Ok(Err(serial::SerialError::new(
                        serial::SerialErrorCode::IoError,
                        message,
                    )))
                }
            };
            let Some(snapshot) = snapshot else {
                return Ok(Err(serial::SerialError::new(
                    serial::SerialErrorCode::PortNotFound,
                    format!("Endpoint {} was not found", request.endpoint_id),
                )));
            };
            let _renderer_framing = request.framing;
            Ok(coordinator.send_with_message_type(
                snapshot,
                &request.bytes,
                request.target.as_ref(),
                request.message_type.as_deref(),
            ))
        })
        .await
        {
            Ok(Ok(value)) => runtime::success(serde_json::to_value(value).unwrap_or(Value::Null)),
            Ok(Err(error)) => runtime::serial_failure("transport.send", error),
            Err(error) => runtime::serial_failure(
                "transport.send",
                serial::SerialError::new(serial::SerialErrorCode::IoError, error),
            ),
        },
    )
}

#[tauri::command]
pub(crate) async fn transport_disconnect_peer(
    window: WebviewWindow,
    state: State<'_, AppState>,
    args: Option<Vec<Value>>,
) -> Result<runtime::Envelope, String> {
    authorize_command!(window, "transport.disconnectPeer");
    let request =
        match first_argument::<DisconnectPeerRequest>(args, "transport.disconnectPeer request") {
            Ok(value) => value,
            Err(error) => return Ok(runtime::serial_failure("transport.disconnectPeer", error)),
        };
    let peer_id = match request.peer_id() {
        Ok(value) => value.to_owned(),
        Err(error) => return Ok(runtime::serial_failure("transport.disconnectPeer", error)),
    };
    let database = state.database.clone();
    let coordinator = state.transport_coordinator.clone();
    Ok(
        match runtime::spawn_blocking(move || {
            let snapshot = match database.endpoint_snapshot(&request.endpoint_id) {
                Ok(snapshot) => snapshot,
                Err(message) => {
                    return Ok(Err(serial::SerialError::new(
                        serial::SerialErrorCode::IoError,
                        message,
                    )))
                }
            };
            let Some(snapshot) = snapshot else {
                return Ok(Err(serial::SerialError::new(
                    serial::SerialErrorCode::PortNotFound,
                    format!("Endpoint {} was not found", request.endpoint_id),
                )));
            };
            Ok(coordinator.disconnect_peer(snapshot, &peer_id))
        })
        .await
        {
            Ok(Ok(value)) => runtime::success(value),
            Ok(Err(error)) => runtime::serial_failure("transport.disconnectPeer", error),
            Err(error) => runtime::serial_failure(
                "transport.disconnectPeer",
                serial::SerialError::new(serial::SerialErrorCode::IoError, error),
            ),
        },
    )
}

pub(crate) struct TauriTransportCoordinator {
    serial_service: Arc<serial::SerialService>,
    tcp_service: Arc<tcp::TcpService>,
    udp_service: Arc<udp::UdpService>,
    modbus_service: Option<Arc<modbus::ModbusService>>,
    websocket_service: Option<Arc<websocket::WebSocketService>>,
    persistence: Arc<TransportPersistence>,
}

impl TauriTransportCoordinator {
    pub(crate) fn new(
        serial_service: Arc<serial::SerialService>,
        tcp_service: Arc<tcp::TcpService>,
        udp_service: Arc<udp::UdpService>,
        persistence: Arc<TransportPersistence>,
    ) -> Self {
        Self {
            serial_service,
            tcp_service,
            udp_service,
            modbus_service: None,
            websocket_service: None,
            persistence,
        }
    }

    pub(crate) fn with_websocket(mut self, service: Arc<websocket::WebSocketService>) -> Self {
        self.websocket_service = Some(service);
        self
    }

    pub(crate) fn with_modbus(mut self, service: Arc<modbus::ModbusService>) -> Self {
        self.modbus_service = Some(service);
        self
    }

    pub(crate) fn cancel_open(
        &self,
        endpoint_id: &str,
        operation_id: &str,
    ) -> serial::SerialResult<serial::CancelAcknowledgement> {
        if let Some(service) = &self.websocket_service {
            let result = service.cancel_open(endpoint_id, operation_id)?;
            if result.cancelled {
                return Ok(result);
            }
        }
        let tcp = self.tcp_service.cancel_open(endpoint_id, operation_id)?;
        if tcp.cancelled {
            return Ok(tcp);
        }
        let udp = self.udp_service.cancel_open(endpoint_id, operation_id)?;
        if udp.cancelled {
            return Ok(udp);
        }
        if let Some(service) = &self.modbus_service {
            let modbus = service.cancel_open(endpoint_id, operation_id)?;
            if modbus.cancelled {
                return Ok(modbus);
            }
        }
        match self.serial_service.cancel_open(endpoint_id, operation_id) {
            Err(error) if error.code == serial::SerialErrorCode::OpenCancelled => {
                Ok(serial::CancelAcknowledgement {
                    endpoint_id: endpoint_id.into(),
                    operation_id: operation_id.into(),
                    cancelled: false,
                })
            }
            result => result,
        }
    }

    #[cfg(test)]
    pub(crate) fn open(
        &self,
        snapshot: database::EndpointSnapshot,
        operation_id: &str,
    ) -> serial::SerialResult<serial::OpenAcknowledgement> {
        self.open_with_headers(snapshot, operation_id, &[])
    }

    pub(crate) fn open_with_headers(
        &self,
        snapshot: database::EndpointSnapshot,
        operation_id: &str,
        headers: &[websocket::WebSocketHeader],
    ) -> serial::SerialResult<serial::OpenAcknowledgement> {
        if !snapshot.transport.starts_with("websocket-") && !headers.is_empty() {
            return Err(argument_error(
                "websocketHeaders require a WebSocket client",
            ));
        }
        match snapshot.transport.as_str() {
            "websocket-client" | "websocket-server" => self
                .websocket_service
                .as_ref()
                .ok_or_else(|| unavailable_transport_error(&snapshot.transport))?
                .open(
                    websocket::WebSocketEndpoint {
                        endpoint_id: snapshot.id,
                        transport: snapshot.transport,
                        config: snapshot.config,
                    },
                    operation_id,
                    headers,
                ),
            "serial" | "dlt645-master" | "dlt645-slave" => {
                let config = serial::SerialConfig::from_value(&snapshot.config)?;
                self.serial_service.open(
                    serial::SerialEndpoint {
                        endpoint_id: snapshot.id,
                        config,
                    },
                    operation_id,
                )
            }
            "tcp-client" | "tcp-server" => self.tcp_service.open(
                tcp::TcpEndpoint {
                    endpoint_id: snapshot.id,
                    transport: snapshot.transport,
                    config: snapshot.config,
                },
                operation_id,
            ),
            "udp-client" | "udp-server" => self.udp_service.open(
                udp::UdpEndpoint {
                    endpoint_id: snapshot.id,
                    transport: snapshot.transport,
                    config: snapshot.config,
                },
                operation_id,
            ),
            "modbus-tcp-master" | "modbus-tcp-slave" | "modbus-rtu-master" | "modbus-rtu-slave" => {
                let service = self
                    .modbus_service
                    .as_ref()
                    .ok_or_else(|| unavailable_transport_error(&snapshot.transport))?;
                service.open(
                    modbus::ModbusEndpoint {
                        endpoint_id: snapshot.id,
                        transport: snapshot.transport,
                        config: snapshot.config,
                    },
                    operation_id,
                )
            }
            transport => Err(unavailable_transport_error(transport)),
        }
    }

    #[cfg(test)]
    pub(crate) fn send(
        &self,
        snapshot: database::EndpointSnapshot,
        bytes: &[u8],
        target: Option<&Value>,
    ) -> serial::SerialResult<serial::SendAcknowledgement> {
        self.send_with_message_type(snapshot, bytes, target, None)
    }

    pub(crate) fn send_with_message_type(
        &self,
        snapshot: database::EndpointSnapshot,
        bytes: &[u8],
        target: Option<&Value>,
        message_type: Option<&str>,
    ) -> serial::SerialResult<serial::SendAcknowledgement> {
        match snapshot.transport.as_str() {
            "websocket-client" | "websocket-server" => self
                .websocket_service
                .as_ref()
                .ok_or_else(|| unavailable_transport_error(&snapshot.transport))?
                .send(&snapshot.id, bytes, target, message_type),
            "serial" | "dlt645-master" | "dlt645-slave" => {
                let expected = target.and_then(|target| target.get("expectedSessionId"));
                let expected = expected
                    .map(|value| {
                        value.as_str().ok_or_else(|| {
                            argument_error("target.expectedSessionId must be a nonblank string")
                        })
                    })
                    .transpose()?;
                match expected {
                    Some(expected) => {
                        self.serial_service
                            .send_for_session(&snapshot.id, bytes, Some(expected))
                    }
                    None => self.serial_service.send(&snapshot.id, bytes),
                }
            }
            "tcp-client" | "tcp-server" => self.tcp_service.send(&snapshot.id, bytes, target),
            "udp-client" | "udp-server" => self.udp_service.send(&snapshot.id, bytes, target),
            transport => Err(unavailable_transport_error(transport)),
        }
    }

    pub(crate) fn disconnect_peer(
        &self,
        snapshot: database::EndpointSnapshot,
        peer_id: &str,
    ) -> serial::SerialResult<Value> {
        match snapshot.transport.as_str() {
            "websocket-client" | "websocket-server" => self
                .websocket_service
                .as_ref()
                .ok_or_else(|| unavailable_transport_error(&snapshot.transport))?
                .disconnect_peer(&snapshot.id, peer_id),
            "tcp-client" | "tcp-server" => self.tcp_service.disconnect_peer(&snapshot.id, peer_id),
            "udp-client" | "udp-server" => self.udp_service.disconnect_peer(&snapshot.id, peer_id),
            "serial" | "dlt645-master" | "dlt645-slave" => Err(serial::SerialError::new(
                serial::SerialErrorCode::IoError,
                "serial peer disconnect is unavailable",
            )),
            transport => Err(unavailable_transport_error(transport)),
        }
    }

    pub(crate) fn close(
        &self,
        snapshot: database::EndpointSnapshot,
    ) -> serial::SerialResult<serial::CloseAcknowledgement> {
        let close_result = match snapshot.transport.as_str() {
            "websocket-client" | "websocket-server" => self
                .websocket_service
                .as_ref()
                .ok_or_else(|| unavailable_transport_error(&snapshot.transport))?
                .close(&snapshot.id),
            "serial" | "dlt645-master" | "dlt645-slave" => self.serial_service.close(&snapshot.id),
            "tcp-client" | "tcp-server" => self.tcp_service.close(&snapshot.id),
            "udp-client" | "udp-server" => self.udp_service.close(&snapshot.id),
            "modbus-tcp-master" | "modbus-tcp-slave" | "modbus-rtu-master" | "modbus-rtu-slave" => {
                self.modbus_service
                    .as_ref()
                    .ok_or_else(|| unavailable_transport_error(&snapshot.transport))?
                    .close(&snapshot.id)
            }
            transport => return Err(unavailable_transport_error(transport)),
        };
        let acknowledgement = close_result?;
        match self.persistence.flush() {
            Ok(()) => Ok(acknowledgement),
            Err(error) => Err(serial::SerialError::new(
                serial::SerialErrorCode::IoError,
                format!("Failed to persist transport close history: {error}"),
            )),
        }
    }

    fn close_registered_endpoint(
        &self,
        endpoint_id: &str,
    ) -> serial::SerialResult<serial::CloseAcknowledgement> {
        if let Some(service) = &self.websocket_service {
            service.close(endpoint_id)?;
        }
        let serial_result = self.serial_service.close(endpoint_id);
        let tcp_result = self.tcp_service.close(endpoint_id);
        let udp_result = self.udp_service.close(endpoint_id);
        let modbus_result = self.modbus_service.as_ref().map_or_else(
            || {
                Ok(serial::CloseAcknowledgement {
                    endpoint_id: endpoint_id.to_owned(),
                    closed: true,
                })
            },
            |service| service.close(endpoint_id),
        );
        let close_result = match (serial_result, tcp_result, udp_result, modbus_result) {
            (Ok(_), Ok(_), Ok(_), Ok(acknowledgement)) => Ok(acknowledgement),
            (Err(error), _, _, _)
            | (_, Err(error), _, _)
            | (_, _, Err(error), _)
            | (_, _, _, Err(error)) => Err(error),
        };
        let acknowledgement = close_result?;
        match self.persistence.flush() {
            Ok(()) => Ok(acknowledgement),
            Err(error) => Err(serial::SerialError::new(
                serial::SerialErrorCode::IoError,
                format!("Failed to persist transport close history: {error}"),
            )),
        }
    }
}

impl database::TransportCoordinator for TauriTransportCoordinator {
    fn close_endpoint(&self, endpoint_id: &str) -> Result<(), String> {
        self.close_registered_endpoint(endpoint_id)
            .map(|_| ())
            .map_err(|error| error.to_string())
    }

    fn flush_persistence(&self) -> Result<(), String> {
        self.persistence.flush()
    }

    fn close_all_endpoints(&self) -> Result<(), String> {
        let mut first_error = None;
        for result in [
            self.serial_service.close_all(),
            self.tcp_service.close_all(),
            self.udp_service.close_all(),
            self.websocket_service
                .as_ref()
                .map_or(Ok(()), |service| service.close_all()),
            self.modbus_service
                .as_ref()
                .map_or(Ok(()), |service| service.close_all()),
        ] {
            if let Err(error) = result {
                first_error.get_or_insert_with(|| error.to_string());
            }
        }
        first_error.map_or(Ok(()), Err)
    }
}

fn open_arguments(args: Option<Vec<Value>>) -> serial::SerialResult<(String, OperationOptions)> {
    let mut args = args.ok_or_else(|| argument_error("transport open arguments are required"))?;
    if args.len() != 2 {
        return Err(argument_error(
            "transport open requires endpointId and operation options",
        ));
    }
    let options = serde_json::from_value(args.pop().unwrap())
        .map_err(|error| argument_error(error.to_string()))?;
    let endpoint_id = serde_json::from_value(args.pop().unwrap())
        .map_err(|error| argument_error(error.to_string()))?;
    Ok((endpoint_id, options))
}

fn first_string(args: Option<Vec<Value>>, label: &str) -> serial::SerialResult<String> {
    first_argument(args, label)
}

fn first_argument<T: for<'de> Deserialize<'de>>(
    args: Option<Vec<Value>>,
    label: &str,
) -> serial::SerialResult<T> {
    let mut args = args.ok_or_else(|| argument_error(format!("{label} is required")))?;
    if args.len() != 1 {
        return Err(argument_error(format!(
            "{label} requires exactly one value"
        )));
    }
    serde_json::from_value(args.pop().unwrap()).map_err(|error| argument_error(error.to_string()))
}

fn argument_error(message: impl Into<String>) -> serial::SerialError {
    serial::SerialError::new(serial::SerialErrorCode::IoError, message)
}

fn unavailable_transport_error(transport: &str) -> serial::SerialError {
    serial::SerialError::new(
        serial::SerialErrorCode::IoError,
        format!("{transport} transport is unavailable"),
    )
}

#[cfg(test)]
mod tests {
    use std::{
        fs, io,
        net::TcpListener,
        process,
        sync::{
            atomic::{AtomicBool, AtomicUsize, Ordering},
            Arc, Mutex,
        },
        time::{Duration, SystemTime, UNIX_EPOCH},
    };

    use serde_json::{json, Value};

    use crate::{
        database::{
            self, ConfigurationDatabase, EndpointSnapshot, FrameHistoryInsert, LogHistoryInsert,
            TransportCoordinator,
        },
        persistence::{PersistenceConfig, PersistenceStore, TransportPersistence},
        serial::{
            DataBits, FlowControl, Parity, RealSerialBackend, ReceiveFraming, SerialBackend,
            SerialConfig, SerialConnection, SerialEndpoint, SerialEvent, SerialEventSink,
            SerialPortRecord, SerialResult, SerialService, StopBits,
        },
        tcp::TcpService,
        udp::UdpService,
    };

    use super::TauriTransportWiring;

    #[test]
    fn shared_send_fixture_passes_strict_parser_and_native_tcp_wire() {
        use std::io::Read;
        let fixture: Vec<Value> =
            serde_json::from_str(include_str!("../tests/fixtures/shared-send-wire.json")).unwrap();
        let requests: Vec<super::SendRequest> = fixture
            .into_iter()
            .map(|entry| {
                let args: Vec<Value> = serde_json::from_value(entry["args"].clone()).unwrap();
                super::first_argument(Some(args), "transport.send request").unwrap()
            })
            .collect();
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let coordinator = super::TauriTransportCoordinator::new(
            Arc::new(SerialService::new(
                Arc::new(RealSerialBackend),
                Arc::new(NoopSink),
            )),
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );
        let snapshot = tcp_client_snapshot("tcp-route", address);
        coordinator.open(snapshot.clone(), "fixture-open").unwrap();
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(2)))
            .unwrap();
        for request in requests {
            assert_eq!(request.endpoint_id, "tcp-route");
            assert_eq!(request.framing.as_deref(), Some("length-prefix"));
            let sent = coordinator
                .send(snapshot.clone(), &request.bytes, request.target.as_ref())
                .unwrap();
            assert_eq!(sent.sent, 8);
            let mut wire = [0; 8];
            socket.read_exact(&mut wire).unwrap();
            assert_eq!(wire, [0, 0, 0, 4, 112, 105, 110, 103]);
        }
        coordinator.close(snapshot).unwrap();
        persistence.shutdown().unwrap();
        assert!(super::first_argument::<super::SendRequest>(
            Some(vec![json!({
                "endpointId": "tcp-route", "bytes": [1], "unexpected": true
            })]),
            "transport.send request"
        )
        .is_err());
    }

    struct NoopSink;

    impl SerialEventSink for NoopSink {
        fn emit(&self, _event: SerialEvent) {}
    }

    struct PersistenceSink {
        persistence: Arc<TransportPersistence>,
    }

    impl SerialEventSink for PersistenceSink {
        fn emit(&self, event: SerialEvent) {
            self.persistence.handle(event);
        }
    }

    struct TestConnection {
        closed: AtomicBool,
    }

    impl SerialConnection for TestConnection {
        fn read(&self, _bytes: &mut [u8]) -> io::Result<usize> {
            std::thread::yield_now();
            Err(io::Error::from(io::ErrorKind::TimedOut))
        }

        fn write_all(&self, _bytes: &[u8]) -> io::Result<()> {
            Ok(())
        }

        fn close(&self) -> io::Result<()> {
            self.closed.store(true, Ordering::SeqCst);
            Ok(())
        }

        fn force_close(&self) -> bool {
            self.closed.store(true, Ordering::SeqCst);
            true
        }
    }

    struct TestBackend {
        connection: Arc<TestConnection>,
        open_calls: AtomicUsize,
    }

    struct FailingPersistenceStore;

    impl PersistenceStore for FailingPersistenceStore {
        fn endpoint_receive_mode(&self, _endpoint_id: &str) -> Result<String, String> {
            Ok("raw".into())
        }

        fn insert_frame_batch(&self, _rows: &[FrameHistoryInsert]) -> Result<(), String> {
            Err("injected frame persistence failure".into())
        }

        fn insert_log_batch(&self, _rows: &[LogHistoryInsert]) -> Result<(), String> {
            Err("injected log persistence failure".into())
        }
    }

    impl SerialBackend for TestBackend {
        fn scan(&self) -> SerialResult<Vec<SerialPortRecord>> {
            Ok(Vec::new())
        }

        fn open(&self, _config: &SerialConfig) -> SerialResult<Arc<dyn SerialConnection>> {
            self.open_calls.fetch_add(1, Ordering::SeqCst);
            Ok(self.connection.clone())
        }
    }

    fn serial_endpoint(endpoint_id: &str) -> SerialEndpoint {
        SerialEndpoint {
            endpoint_id: endpoint_id.into(),
            config: SerialConfig {
                path: format!("/dev/{endpoint_id}"),
                baud_rate: 115_200,
                data_bits: DataBits::Eight,
                parity: Parity::None,
                stop_bits: StopBits::One,
                flow_control: FlowControl::None,
                receive_framing: ReceiveFraming::Raw,
            },
        }
    }

    fn serial_snapshot(endpoint_id: &str) -> EndpointSnapshot {
        EndpointSnapshot {
            id: endpoint_id.into(),
            transport: "serial".into(),
            config: json!({
                "path": format!("/dev/{endpoint_id}"),
                "baudRate": 115200,
                "dataBits": 8,
                "parity": "none",
                "stopBits": 1,
                "flowControl": "none",
                "receiveFraming": { "mode": "raw" }
            }),
        }
    }

    fn dlt645_snapshot(endpoint_id: &str, transport: &str) -> EndpointSnapshot {
        EndpointSnapshot {
            id: endpoint_id.into(),
            transport: transport.into(),
            config: json!({
                "path": format!("/dev/{endpoint_id}"),
                "baudRate": 2400,
                "dataBits": 8,
                "parity": "even",
                "stopBits": 1,
                "flowControl": "none",
                "receiveFraming": { "mode": "raw" }
            }),
        }
    }

    fn tcp_client_snapshot(endpoint_id: &str, address: std::net::SocketAddr) -> EndpointSnapshot {
        EndpointSnapshot {
            id: endpoint_id.into(),
            transport: "tcp-client".into(),
            config: json!({
                "host": address.ip().to_string(),
                "port": address.port(),
                "receiveFraming": { "mode": "raw" }
            }),
        }
    }

    fn udp_server_snapshot(endpoint_id: &str) -> EndpointSnapshot {
        EndpointSnapshot {
            id: endpoint_id.into(),
            transport: "udp-server".into(),
            config: json!({
                "bindHost": "127.0.0.1",
                "bindPort": 0,
                "receiveFraming": { "mode": "raw" }
            }),
        }
    }

    struct RecordingCoordinator {
        order: Arc<Mutex<Vec<&'static str>>>,
        flush_error: Option<&'static str>,
    }

    impl TransportCoordinator for RecordingCoordinator {
        fn close_endpoint(&self, _endpoint_id: &str) -> Result<(), String> {
            Ok(())
        }

        fn close_all_endpoints(&self) -> Result<(), String> {
            self.order.lock().unwrap().push("close-all");
            Ok(())
        }

        fn flush_persistence(&self) -> Result<(), String> {
            self.order.lock().unwrap().push("flush");
            self.flush_error.map_or(Ok(()), |error| Err(error.into()))
        }
    }

    #[test]
    fn setup_wiring_shares_one_persistence_between_sink_and_coordinator() {
        let directory = std::env::temp_dir().join(format!(
            "ineed-tauri-transport-wiring-{}-{}",
            process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&directory).unwrap();
        let database = Arc::new(ConfigurationDatabase::open_in(&directory).unwrap());
        let wiring = TauriTransportWiring::new(database);
        let sink_dispatch = wiring.event_dispatch();
        let serial_service = Arc::new(SerialService::new(
            Arc::new(RealSerialBackend),
            Arc::new(NoopSink),
        ));
        let tcp_service = Arc::new(TcpService::new(Arc::new(NoopSink)));
        let udp_service = Arc::new(UdpService::new(Arc::new(NoopSink)));
        let coordinator = wiring.coordinator(serial_service, tcp_service, udp_service);

        assert!(Arc::ptr_eq(
            &sink_dispatch.persistence,
            &coordinator.persistence
        ));
        assert!(Arc::ptr_eq(&wiring.persistence(), &coordinator.persistence));

        wiring.persistence().shutdown().unwrap();
        drop(coordinator);
        drop(wiring);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clear_and_import_mutations_run_after_their_required_transport_barriers() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let coordinator = RecordingCoordinator {
            order: order.clone(),
            flush_error: None,
        };

        database::after_persistence_flush(&coordinator, || {
            order.lock().unwrap().push("clear");
            Ok(())
        })
        .unwrap();
        database::after_transport_close_and_flush(&coordinator, || {
            order.lock().unwrap().push("import");
            Ok(())
        })
        .unwrap();

        assert_eq!(
            *order.lock().unwrap(),
            vec!["flush", "clear", "close-all", "flush", "import"]
        );
    }

    #[test]
    fn flush_failure_isolated_from_mutation() {
        let order = Arc::new(Mutex::new(Vec::new()));
        let coordinator = RecordingCoordinator {
            order: order.clone(),
            flush_error: Some("injected flush failure"),
        };

        let error = database::after_persistence_flush(&coordinator, || {
            order.lock().unwrap().push("mutation");
            Ok(())
        })
        .unwrap_err();

        assert_eq!(error, "injected flush failure");
        assert_eq!(*order.lock().unwrap(), vec!["flush"]);
    }

    #[test]
    fn close_returns_only_after_final_frames_and_logs_are_queryable() {
        let database = Arc::new(ConfigurationDatabase::open_in_memory_for_test().unwrap());
        database
            .insert_serial_endpoint_for_test("serial-1")
            .unwrap();
        let persistence = Arc::new(TransportPersistence::new(database.clone()));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let backend = Arc::new(TestBackend {
            connection: connection.clone(),
            open_calls: AtomicUsize::new(0),
        });
        let serial_service = Arc::new(SerialService::new(
            backend.clone(),
            Arc::new(PersistenceSink {
                persistence: persistence.clone(),
            }),
        ));
        let coordinator = super::TauriTransportCoordinator::new(
            serial_service.clone(),
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );
        serial_service
            .open(serial_endpoint("serial-1"), "open-1")
            .unwrap();
        serial_service.send("serial-1", &[0xde, 0xad]).unwrap();

        let acknowledgement = coordinator.close(serial_snapshot("serial-1")).unwrap();
        let (frames, logs) = database.history_for_test("serial-1").unwrap();

        assert!(acknowledgement.closed);
        assert_eq!(frames, vec![vec![0xde, 0xad]]);
        assert!(logs.iter().any(|message| message.contains("正在关闭串口")));
        assert!(logs.iter().any(|message| message.contains("串口已关闭")));
        assert!(connection.closed.load(Ordering::SeqCst));
        assert_eq!(backend.open_calls.load(Ordering::SeqCst), 1);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn close_flush_failure_is_reported_without_reopening_serial() {
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = Arc::new(TransportPersistence::with_config(
            Arc::new(FailingPersistenceStore),
            {
                let reports = reports.clone();
                move |report| reports.lock().unwrap().push(report)
            },
            PersistenceConfig {
                max_retries: 0,
                retry_delay: Arc::new(|_| {}),
                ..PersistenceConfig::default()
            },
        ));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let backend = Arc::new(TestBackend {
            connection: connection.clone(),
            open_calls: AtomicUsize::new(0),
        });
        let serial_service = Arc::new(SerialService::new(
            backend.clone(),
            Arc::new(PersistenceSink {
                persistence: persistence.clone(),
            }),
        ));
        let coordinator = super::TauriTransportCoordinator::new(
            serial_service.clone(),
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );
        serial_service
            .open(serial_endpoint("serial-failure"), "open-failure")
            .unwrap();
        serial_service
            .send("serial-failure", &[0xca, 0xfe])
            .unwrap();

        let error = coordinator
            .close(serial_snapshot("serial-failure"))
            .unwrap_err();

        assert_eq!(error.code, crate::serial::SerialErrorCode::IoError);
        assert!(error
            .message
            .contains("Failed to persist transport close history"));
        assert!(connection.closed.load(Ordering::SeqCst));
        assert_eq!(backend.open_calls.load(Ordering::SeqCst), 1);
        assert!(serial_service.send("serial-failure", &[1]).is_err());
        let reports = reports.lock().unwrap();
        assert!(reports
            .iter()
            .any(|report| report.context == "frame batch write"));
        assert!(reports
            .iter()
            .any(|report| report.context == "log batch write"));
        drop(reports);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn coordinator_cancel_open_routes_to_the_owned_udp_operation() {
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let backend = Arc::new(TestBackend {
            connection: Arc::new(TestConnection {
                closed: AtomicBool::new(false),
            }),
            open_calls: AtomicUsize::new(0),
        });
        let udp = Arc::new(UdpService::new(Arc::new(NoopSink)));
        let coordinator = super::TauriTransportCoordinator::new(
            Arc::new(SerialService::new(backend.clone(), Arc::new(NoopSink))),
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            udp.clone(),
            persistence.clone(),
        );
        coordinator
            .open(udp_server_snapshot("udp-cancel"), "open-new")
            .unwrap();
        assert!(
            !coordinator
                .cancel_open("udp-cancel", "old-open")
                .unwrap()
                .cancelled
        );
        assert!(
            coordinator
                .cancel_open("udp-cancel", "open-new")
                .unwrap()
                .cancelled
        );
        assert!(udp.send("udp-cancel", &[1], None).is_err());
        assert_eq!(backend.open_calls.load(Ordering::SeqCst), 0);
        assert!(
            !coordinator
                .cancel_open("udp-cancel", "open-new")
                .unwrap()
                .cancelled
        );
        persistence.shutdown().unwrap();
    }

    #[test]
    fn coordinator_routes_tcp_open_to_tcp_service() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let address = listener.local_addr().unwrap();
        let server = std::thread::spawn(move || {
            let (_socket, _) = listener.accept().unwrap();
        });
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let backend = Arc::new(TestBackend {
            connection,
            open_calls: AtomicUsize::new(0),
        });
        let serial_service = Arc::new(SerialService::new(backend.clone(), Arc::new(NoopSink)));
        let tcp_service = Arc::new(TcpService::new(Arc::new(NoopSink)));
        let coordinator = super::TauriTransportCoordinator::new(
            serial_service,
            tcp_service.clone(),
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );

        let acknowledgement = coordinator
            .open(tcp_client_snapshot("tcp-route", address), "open-tcp")
            .unwrap();

        assert_eq!(acknowledgement.endpoint_id, "tcp-route");
        assert_eq!(acknowledgement.operation_id, "open-tcp");
        assert_eq!(backend.open_calls.load(Ordering::SeqCst), 0);
        coordinator
            .close(tcp_client_snapshot("tcp-route", address))
            .unwrap();
        server.join().unwrap();
        persistence.shutdown().unwrap();
    }

    #[test]
    fn coordinator_routes_dlt645_master_lifecycle_to_serial_service() {
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let backend = Arc::new(TestBackend {
            connection: connection.clone(),
            open_calls: AtomicUsize::new(0),
        });
        let coordinator = super::TauriTransportCoordinator::new(
            Arc::new(SerialService::new(backend.clone(), Arc::new(NoopSink))),
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );
        let snapshot = dlt645_snapshot("meter-bus-1", "dlt645-master");

        let opened = coordinator.open(snapshot.clone(), "open-meter").unwrap();
        let sent = coordinator
            .send(snapshot.clone(), &[0x68, 0x12, 0x90, 0x68, 0x11], None)
            .unwrap();
        let closed = coordinator.close(snapshot).unwrap();

        assert_eq!(opened.endpoint_id, "meter-bus-1");
        assert_eq!(opened.operation_id, "open-meter");
        assert_eq!(sent.sent, 5);
        assert!(closed.closed);
        assert_eq!(backend.open_calls.load(Ordering::SeqCst), 1);
        assert!(connection.closed.load(Ordering::SeqCst));
        persistence.shutdown().unwrap();
    }

    #[test]
    fn coordinator_routes_dlt645_simulator_lifecycle_to_serial_service() {
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let backend = Arc::new(TestBackend {
            connection: connection.clone(),
            open_calls: AtomicUsize::new(0),
        });
        let coordinator = super::TauriTransportCoordinator::new(
            Arc::new(SerialService::new(backend.clone(), Arc::new(NoopSink))),
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );
        let snapshot = dlt645_snapshot("meter-simulator-1", "dlt645-slave");

        let opened = coordinator
            .open(snapshot.clone(), "open-simulator")
            .unwrap();
        let sent = coordinator
            .send(snapshot.clone(), &[0x68, 0x12, 0x90, 0x68, 0x91], None)
            .unwrap();
        let closed = coordinator.close(snapshot).unwrap();

        assert_eq!(opened.endpoint_id, "meter-simulator-1");
        assert_eq!(opened.operation_id, "open-simulator");
        assert_eq!(sent.sent, 5);
        assert!(closed.closed);
        assert_eq!(backend.open_calls.load(Ordering::SeqCst), 1);
        assert!(connection.closed.load(Ordering::SeqCst));
        persistence.shutdown().unwrap();
    }

    #[test]
    fn registered_endpoint_close_releases_udp_sessions() {
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let serial_service = Arc::new(SerialService::new(
            Arc::new(TestBackend {
                connection: Arc::new(TestConnection {
                    closed: AtomicBool::new(false),
                }),
                open_calls: AtomicUsize::new(0),
            }),
            Arc::new(NoopSink),
        ));
        let udp_service = Arc::new(UdpService::new(Arc::new(NoopSink)));
        let coordinator = super::TauriTransportCoordinator::new(
            serial_service,
            Arc::new(TcpService::new(Arc::new(NoopSink))),
            udp_service.clone(),
            persistence.clone(),
        );
        coordinator
            .open(udp_server_snapshot("udp-registered-close"), "open-udp")
            .unwrap();

        crate::database::TransportCoordinator::close_endpoint(&coordinator, "udp-registered-close")
            .unwrap();

        let error = udp_service
            .send("udp-registered-close", &[1], None)
            .unwrap_err();
        assert_eq!(error.code, crate::serial::SerialErrorCode::PortNotFound);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn coordinator_reports_udp_transport_as_controlled_unavailable_error() {
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let serial_service = Arc::new(SerialService::new(
            Arc::new(TestBackend {
                connection,
                open_calls: AtomicUsize::new(0),
            }),
            Arc::new(NoopSink),
        ));
        let tcp_service = Arc::new(TcpService::new(Arc::new(NoopSink)));
        let coordinator = super::TauriTransportCoordinator::new(
            serial_service,
            tcp_service,
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );

        let error = coordinator
            .open(
                EndpointSnapshot {
                    id: "udp-route".into(),
                    transport: "udp".into(),
                    config: json!({}),
                },
                "open-udp",
            )
            .unwrap_err();

        assert_eq!(error.code, crate::serial::SerialErrorCode::IoError);
        assert_eq!(error.message, "udp transport is unavailable");
        persistence.shutdown().unwrap();
    }

    #[test]
    fn coordinator_reports_udp_close_as_controlled_unavailable_error() {
        let persistence = Arc::new(TransportPersistence::new(Arc::new(
            ConfigurationDatabase::open_in_memory_for_test().unwrap(),
        )));
        let connection = Arc::new(TestConnection {
            closed: AtomicBool::new(false),
        });
        let serial_service = Arc::new(SerialService::new(
            Arc::new(TestBackend {
                connection,
                open_calls: AtomicUsize::new(0),
            }),
            Arc::new(NoopSink),
        ));
        let tcp_service = Arc::new(TcpService::new(Arc::new(NoopSink)));
        let coordinator = super::TauriTransportCoordinator::new(
            serial_service,
            tcp_service,
            Arc::new(UdpService::new(Arc::new(NoopSink))),
            persistence.clone(),
        );

        let error = coordinator
            .close(EndpointSnapshot {
                id: "udp-close".into(),
                transport: "udp".into(),
                config: json!({}),
            })
            .unwrap_err();

        assert_eq!(error.code, crate::serial::SerialErrorCode::IoError);
        assert_eq!(error.message, "udp transport is unavailable");
        persistence.shutdown().unwrap();
    }
}
