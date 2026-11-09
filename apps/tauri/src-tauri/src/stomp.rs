//! Isolated, ephemeral WebSocket bridge for the shared STOMP implementation.
mod event_batch;
use crate::{
    serial::{
        SerialError, SerialErrorCode, SerialEvent, SerialEventSink, SerialResult, SerialStatus,
    },
    websocket::{WebSocketEndpoint, WebSocketHeader, WebSocketService},
};
pub(crate) use event_batch::StompEventBatcher;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};
fn error(message: &str) -> SerialError {
    SerialError::new(SerialErrorCode::IoError, message)
}
#[derive(Clone)]
struct Slot {
    native_id: String,
    operation_id: String,
    mode: String,
}
#[derive(Default)]
struct Lifecycle {
    stopped: bool,
    slots: HashMap<String, Slot>,
    retired: Vec<String>,
}
struct Sink {
    lifecycle: Arc<Mutex<Lifecycle>>,
    emit: Box<dyn Fn(Value) + Send + Sync>,
}
impl SerialEventSink for Sink {
    fn emit(&self, event: SerialEvent) {
        let (kind, native_id, operation_id, terminal) = match &event {
            SerialEvent::Frames(e) => ("frames", &e.endpoint_id, &e.operation_id, false),
            SerialEvent::Status(e) => (
                "status",
                &e.endpoint_id,
                &e.operation_id,
                matches!(e.status, SerialStatus::Closed | SerialStatus::Error),
            ),
            SerialEvent::Peers(e) => ("peers", &e.endpoint_id, &e.operation_id, false),
        };
        let connection_id = {
            let mut state = self.lifecycle.lock().unwrap();
            let Some(id) = state
                .slots
                .iter()
                .find(|(_, s)| &s.native_id == native_id && &s.operation_id == operation_id)
                .map(|(id, _)| id.clone())
            else {
                return;
            };
            if terminal {
                if let Some(slot) = state.slots.remove(&id) {
                    state.retired.push(slot.native_id);
                }
            }
            id
        };
        let mut payload = match event {
            SerialEvent::Frames(mut e) => {
                e.frames.retain(|f| f.direction == "in");
                if e.frames.is_empty() {
                    return;
                }
                serde_json::to_value(e).unwrap()
            }
            SerialEvent::Status(mut e) => {
                if let Some(log) = &mut e.log {
                    if let Some(details) = &mut log.details {
                        if let Some(object) = details.as_object_mut() {
                            object.insert("closeReason".into(), json!(""));
                        }
                    }
                }
                serde_json::to_value(e).unwrap()
            }
            SerialEvent::Peers(e) => serde_json::to_value(e).unwrap(),
        };
        payload["endpointId"] = json!(connection_id);
        (self.emit)(json!({"type":kind,"payload":payload}));
    }
}
pub(crate) struct StompService {
    native: WebSocketService,
    lifecycle: Arc<Mutex<Lifecycle>>,
    sequence: AtomicU64,
}
impl StompService {
    pub(crate) fn new(emit: impl Fn(Value) + Send + Sync + 'static) -> Self {
        let lifecycle = Arc::new(Mutex::new(Lifecycle::default()));
        let native = WebSocketService::new(Arc::new(Sink {
            lifecycle: lifecycle.clone(),
            emit: Box::new(emit),
        }));
        Self {
            native,
            lifecycle,
            sequence: AtomicU64::new(0),
        }
    }
    fn reap(&self) {
        let retired = std::mem::take(&mut self.lifecycle.lock().unwrap().retired);
        for id in retired {
            let _ = self.native.close(&id);
        }
    }
    pub(crate) fn execute(&self, request: Value) -> SerialResult<Value> {
        self.reap();
        let id = text(&request, "connectionId")?;
        if !uuid(id) {
            return Err(error("A STOMP connection UUID is required"));
        }
        let action = text(&request, "action")?;
        if action == "close" {
            let slot = self.lifecycle.lock().unwrap().slots.remove(id);
            if let Some(slot) = slot {
                self.native.close(&slot.native_id)?;
            }
            return Ok(json!({"endpointId":id,"closed":true}));
        }
        if self.lifecycle.lock().unwrap().stopped {
            return Err(error("STOMP transport is shut down"));
        }
        if action == "open" {
            return self.open(&request, id);
        }
        if !matches!(action, "send" | "disconnectPeer") {
            return Err(error("Unknown STOMP transport action"));
        }
        let slot = self
            .lifecycle
            .lock()
            .unwrap()
            .slots
            .get(id)
            .cloned()
            .ok_or_else(|| error("STOMP transport is not open"))?;
        if action == "disconnectPeer" {
            let peer = peer(&request)?;
            let mut ack = self.native.disconnect_peer(&slot.native_id, peer)?;
            ack["endpointId"] = json!(id);
            return Ok(ack);
        }
        let kind = text(&request, "messageType")?;
        if !matches!(kind, "text" | "binary") {
            return Err(error("STOMP messageType must be text or binary"));
        }
        let bytes: Vec<u8> = serde_json::from_value(request["bytes"].clone())
            .map_err(|_| error("Invalid STOMP byte array"))?;
        let target = if slot.mode == "server" {
            Some(json!({"type":"peer","peerIds":[peer(&request)?]}))
        } else {
            if request.get("peerId").is_some() {
                return Err(error("Client sends cannot specify a peer"));
            }
            None
        };
        let ack = self
            .native
            .send(&slot.native_id, &bytes, target.as_ref(), Some(kind))?;
        if ack.failure_count.unwrap_or(0) > 0 {
            return Err(error("STOMP peer send failed"));
        }
        let mut ack = serde_json::to_value(ack).unwrap();
        ack["endpointId"] = json!(id);
        Ok(ack)
    }
    fn open(&self, request: &Value, id: &str) -> SerialResult<Value> {
        let mode = text(request, "mode")?;
        if !matches!(mode, "client" | "server") {
            return Err(error("Invalid STOMP transport mode"));
        }
        let config = request["config"]
            .as_object()
            .ok_or_else(|| error("Invalid STOMP transport configuration"))?;
        if config.keys().any(|k| {
            !matches!(
                k.as_str(),
                "url"
                    | "listenHost"
                    | "listenPort"
                    | "path"
                    | "subprotocols"
                    | "messageType"
                    | "heartbeat"
                    | "autoReconnect"
            )
        }) {
            return Err(error("Invalid STOMP transport configuration"));
        }
        if let Some(heartbeat) = config.get("heartbeat") {
            if heartbeat.as_object().is_none_or(|o| {
                o.keys()
                    .any(|k| !matches!(k.as_str(), "enabled" | "intervalMs" | "timeoutMs"))
            }) {
                return Err(error("Invalid STOMP transport heartbeat"));
            }
        }
        if mode == "client" {
            let url = url::Url::parse(text(&request["config"], "url")?)
                .map_err(|_| error("Invalid STOMP WebSocket URL"))?;
            if !url.username().is_empty()
                || url.password().is_some()
                || url.query().is_some()
                || url.fragment().is_some()
            {
                return Err(error(
                    "STOMP URL cannot contain credentials, query or fragment",
                ));
            }
        }
        let headers: Vec<WebSocketHeader> =
            serde_json::from_value(request.get("headers").cloned().unwrap_or(json!([])))
                .map_err(|_| error("Invalid STOMP WebSocket headers"))?;
        let transport = format!("websocket-{mode}");
        crate::websocket::validate_config(&transport, &request["config"], false)?;
        crate::websocket::validate_headers(&headers)?;
        if mode == "server" && !headers.is_empty() {
            return Err(error("Headers are only supported by STOMP clients"));
        }
        let generation = self.sequence.fetch_add(1, Ordering::SeqCst);
        let native_id = format!("stomp-native-{generation}");
        let operation_id = format!("stomp-operation-{generation}");
        let slot = Slot {
            native_id: native_id.clone(),
            operation_id: operation_id.clone(),
            mode: mode.into(),
        };
        {
            let mut state = self.lifecycle.lock().unwrap();
            if state.stopped {
                return Err(error("STOMP transport is shut down"));
            }
            if state.slots.contains_key(id) {
                return Err(SerialError::new(
                    SerialErrorCode::PortBusy,
                    "STOMP connection is already active",
                ));
            }
            if state.slots.len() >= 4 {
                return Err(error("STOMP native session limit is 4"));
            }
            state.slots.insert(id.into(), slot);
        }
        let result = self.native.open(
            WebSocketEndpoint {
                endpoint_id: native_id.clone(),
                transport,
                config: request["config"].clone(),
            },
            &operation_id,
            &headers,
        );
        let current = {
            let mut state = self.lifecycle.lock().unwrap();
            let current = !state.stopped
                && state
                    .slots
                    .get(id)
                    .is_some_and(|s| s.native_id == native_id);
            if result.is_err() && current {
                state.slots.remove(id);
            }
            current
        };
        match result {
            Ok(ack) if current => {
                let mut ack = serde_json::to_value(ack).unwrap();
                ack["endpointId"] = json!(id);
                Ok(ack)
            }
            other => {
                let _ = self.native.close(&native_id);
                match other {
                    Err(e) => Err(e),
                    Ok(_) => Err(SerialError::new(
                        SerialErrorCode::OpenCancelled,
                        "STOMP open cancelled",
                    )),
                }
            }
        }
    }
    pub(crate) fn shutdown(&self) -> SerialResult<()> {
        {
            let mut state = self.lifecycle.lock().unwrap();
            state.stopped = true;
            state.slots.clear();
            state.retired.clear();
        }
        self.native.shutdown()
    }
}
fn text<'a>(request: &'a Value, key: &str) -> SerialResult<&'a str> {
    request
        .get(key)
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .ok_or_else(|| error("Invalid STOMP transport request"))
}
fn peer(request: &Value) -> SerialResult<&str> {
    text(request, "peerId").and_then(|s| {
        if s.trim().is_empty() || s.len() > 256 {
            Err(error("A valid STOMP peer ID is required"))
        } else {
            Ok(s)
        }
    })
}
fn uuid(id: &str) -> bool {
    id.len() == 36
        && id.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
#[tauri::command]
pub(crate) async fn stomp_execute(
    window: tauri::WebviewWindow,
    state: tauri::State<'_, crate::AppState>,
    request: Value,
) -> Result<crate::runtime::Envelope, String> {
    if let Some(denied) = crate::runtime::authorize_window(window.label(), "stomp.execute") {
        return Ok(denied);
    }
    let service = state.stomp_service.clone();
    let result = tauri::async_runtime::spawn_blocking(move || service.execute(request)).await;
    Ok(match result {
        Ok(Ok(value)) => crate::runtime::success(value),
        Ok(Err(e)) => crate::runtime::serial_failure("stomp.execute", e),
        Err(_) => {
            crate::runtime::serial_failure("stomp.execute", error("STOMP transport worker failed"))
        }
    })
}
/// Isolated native JSONL acceptance driver; never writes transport history.
#[doc(hidden)]
pub fn run_native_harness() {
    use std::io::BufRead;
    let service = Arc::new(StompService::new(|event| {
        println!("{}", json!({"event":event}))
    }));
    let mut workers = Vec::new();
    for line in std::io::stdin().lock().lines() {
        let Ok(line) = line else { break };
        let service = service.clone();
        workers.push(std::thread::spawn(move || {
            let input: Value = match serde_json::from_str(&line) {
                Ok(v) => v,
                Err(_) => {
                    println!(
                        "{}",
                        json!({"error":{"code":"IO_ERROR","message":"Invalid JSON"}})
                    );
                    return;
                }
            };
            let id = input.get("id").cloned().unwrap_or(Value::Null);
            match service.execute(input["request"].clone()) {
                Ok(result) => println!("{}", json!({"id":id,"result":result})),
                Err(error) => println!("{}", json!({"id":id,"error":error})),
            }
        }));
    }
    let _ = service.shutdown();
    for worker in workers {
        let _ = worker.join();
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use std::{
        net::TcpListener,
        sync::{Arc, Mutex},
        time::{Duration, Instant},
    };
    const SERVER: &str = "00000000-0000-4000-8000-000000000001";
    const CLIENT: &str = "00000000-0000-4000-8000-000000000002";
    fn port() -> u16 {
        TcpListener::bind("127.0.0.1:0")
            .unwrap()
            .local_addr()
            .unwrap()
            .port()
    }
    fn until(check: impl Fn() -> bool) {
        let start = Instant::now();
        while !check() {
            assert!(start.elapsed() < Duration::from_secs(3));
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn stomp_ephemeral_real_loopback_and_no_outbound_events() {
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed = events.clone();
        let service = StompService::new(move |event| observed.lock().unwrap().push(event));
        let port = port();
        let server = service.execute(json!({"action":"open","connectionId":SERVER,"mode":"server","config":{"listenHost":"127.0.0.1","listenPort":port,"path":"/stomp"}})).unwrap();
        service.execute(json!({"action":"open","connectionId":CLIENT,"mode":"client","config":{"url":format!("ws://127.0.0.1:{port}/stomp")}})).unwrap();
        service
            .execute(
                json!({"action":"send","connectionId":CLIENT,"messageType":"text","bytes":[65,0]}),
            )
            .unwrap();
        until(|| events.lock().unwrap().iter().any(|e| e["type"] == "frames"));
        let captured = events.lock().unwrap().clone();
        let received = captured.iter().find(|e| e["type"] == "frames").unwrap();
        assert_eq!(received["payload"]["endpointId"], SERVER);
        assert_eq!(received["payload"]["sessionId"], server["sessionId"]);
        assert_eq!(received["payload"]["frames"][0]["bytes"], json!([65, 0]));
        assert!(captured
            .iter()
            .filter(|e| e["type"] == "frames")
            .all(|e| e["payload"]["frames"]
                .as_array()
                .unwrap()
                .iter()
                .all(|f| f["direction"] == "in")));
        let peer = received["payload"]["frames"][0]["peerId"].clone();
        service.execute(json!({"action":"send","connectionId":SERVER,"peerId":peer,"messageType":"text","bytes":[66]})).unwrap();
        service
            .execute(json!({"action":"disconnectPeer","connectionId":SERVER,"peerId":peer}))
            .unwrap();
        service
            .execute(json!({"action":"close","connectionId":SERVER}))
            .unwrap();
        service.shutdown().unwrap();
    }
    #[test]
    fn stomp_ack_bytes_arrive_before_wire_peer_close() {
        use futures::{SinkExt, StreamExt};
        use tokio_tungstenite::tungstenite::Message;
        let events = Arc::new(Mutex::new(Vec::<Value>::new()));
        let observed = events.clone();
        let batcher = Mutex::new(StompEventBatcher::new(move |event| {
            observed.lock().unwrap().push(event)
        }));
        let service =
            StompService::new(move |event| batcher.lock().unwrap().push(event, Instant::now()));
        let port = port();
        service.execute(json!({"action":"open","connectionId":SERVER,"mode":"server","config":{"listenPort":port}})).unwrap();
        let wire = tokio::runtime::Runtime::new().unwrap();
        wire.block_on(async {
            let (mut socket, _) =
                tokio_tungstenite::connect_async(format!("ws://127.0.0.1:{port}"))
                    .await
                    .unwrap();
            socket
                .send(Message::Text("ACK\nid:ack-1\n\n\0".into()))
                .await
                .unwrap();
            socket.close(None).await.unwrap();
            while socket.next().await.is_some() {}
        });
        until(|| {
            events
                .lock()
                .unwrap()
                .iter()
                .any(|e| e["type"] == "peers" && e["payload"]["peers"] == json!([]))
        });
        let events = events.lock().unwrap();
        let frame = events.iter().position(|e| e["type"] == "frames").unwrap();
        let closed = events
            .iter()
            .position(|e| e["type"] == "peers" && e["payload"]["peers"] == json!([]))
            .unwrap();
        assert!(
            frame < closed,
            "ACK bytes must be observed before peer removal"
        );
        assert_eq!(
            events[frame]["payload"]["frames"][0]["bytes"],
            json!(b"ACK\nid:ack-1\n\n\0".to_vec())
        );
        drop(events);
        service.shutdown().unwrap();
    }

    #[test]
    fn stomp_limits_config_and_shutdown_are_enforced() {
        let service = StompService::new(|_| {});
        for request in [
            json!({}),
            json!({"action":"other","connectionId":SERVER}),
            json!({"action":"open","connectionId":SERVER,"mode":"client","config":{"url":"ws://localhost/?password=secret"}}),
            json!({"action":"open","connectionId":SERVER,"mode":"server","config":{"listenPort":61614,"login":"secret"}}),
        ] {
            assert!(service.execute(request).is_err());
        }
        for n in 1..=4 {
            service.execute(json!({"action":"open","connectionId":format!("00000000-0000-4000-8000-{n:012}"),"mode":"server","config":{"listenHost":"127.0.0.1","listenPort":port()}})).unwrap();
        }
        assert!(service.execute(json!({"action":"open","connectionId":"00000000-0000-4000-8000-000000000005","mode":"server","config":{"listenPort":port()}})).is_err());
        service.shutdown().unwrap();
        assert!(service.execute(json!({"action":"open","connectionId":SERVER,"mode":"server","config":{"listenPort":port()}})).is_err());
    }
    #[test]
    fn stomp_cancelled_open_cannot_resurrect_reused_id() {
        let blackhole = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = blackhole.local_addr().unwrap().port();
        let service = Arc::new(StompService::new(|_| {}));
        let opening = service.clone();
        let worker = std::thread::spawn(move || {
            opening.execute(json!({"action":"open","connectionId":CLIENT,"mode":"client","config":{"url":format!("ws://127.0.0.1:{port}")}}))
        });
        let (socket, _) = blackhole.accept().unwrap();
        service
            .execute(json!({"action":"close","connectionId":CLIENT}))
            .unwrap();
        service.execute(json!({"action":"open","connectionId":CLIENT,"mode":"server","config":{"listenPort":self::port()}})).unwrap();
        assert!(worker.join().unwrap().is_err());
        drop(socket);
        service.shutdown().unwrap();
    }
}
