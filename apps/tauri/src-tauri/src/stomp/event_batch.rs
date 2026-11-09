use serde_json::Value;
use std::time::{Duration, Instant};

const MAX_FRAMES: usize = 200;
const MAX_BYTES: usize = 65536;
const MAX_DELAY: Duration = Duration::from_millis(16);

/// Coalesces native inbound events before they cross the WKWebView boundary.
pub(crate) struct StompEventBatcher {
    emit: Box<dyn Fn(Value) + Send + Sync>,
    pending: Option<Value>,
    bytes: usize,
    started: Option<Instant>,
}
impl StompEventBatcher {
    pub(crate) fn new(emit: impl Fn(Value) + Send + Sync + 'static) -> Self {
        Self {
            emit: Box::new(emit),
            pending: None,
            bytes: 0,
            started: None,
        }
    }
    pub(crate) fn push(&mut self, mut event: Value, now: Instant) {
        self.flush_due(now);
        if event["type"] != "frames" || !event["payload"]["frames"].is_array() {
            // In particular, ACK bytes must cross the bridge before peer removal.
            self.flush();
            (self.emit)(event);
            return;
        }
        let Value::Array(frames) = event["payload"]["frames"].take() else {
            unreachable!()
        };
        event["payload"]["frames"] = Value::Array(Vec::new());
        for frame in frames {
            let size = frame["bytes"].as_array().map_or(0, Vec::len);
            let compatible = self.pending.as_ref().is_none_or(|pending| {
                ["endpointId", "operationId", "sessionId"]
                    .iter()
                    .all(|key| pending["payload"][key] == event["payload"][key])
            });
            if !compatible || self.bytes + size > MAX_BYTES {
                self.flush();
            }
            if self.pending.is_none() {
                self.pending = Some(event.clone());
                self.started = Some(now);
            }
            let pending = self.pending.as_mut().unwrap()["payload"]["frames"]
                .as_array_mut()
                .unwrap();
            pending.push(frame);
            self.bytes += size;
            // A legal frame larger than the coalescing budget travels alone.
            if pending.len() >= MAX_FRAMES || self.bytes >= MAX_BYTES {
                self.flush();
            }
        }
    }
    pub(crate) fn flush_due(&mut self, now: Instant) {
        if self
            .started
            .is_some_and(|start| now.saturating_duration_since(start) >= MAX_DELAY)
        {
            self.flush();
        }
    }
    fn flush(&mut self) {
        self.bytes = 0;
        self.started = None;
        if let Some(event) = self.pending.take() {
            (self.emit)(event);
        }
    }
}
impl Drop for StompEventBatcher {
    fn drop(&mut self) {
        self.flush();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::{
        sync::{Arc, Mutex},
        time::Duration,
    };

    fn frame(id: usize, bytes: usize) -> Value {
        json!({"type":"frames","payload":{"endpointId":"connection","operationId":"attempt","sessionId":"session","frames":[{"peerId":"peer","bytes":vec![id;bytes],"createdAt":id}]}})
    }
    fn fixture() -> (StompEventBatcher, Arc<Mutex<Vec<Value>>>) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let output = events.clone();
        (
            StompEventBatcher::new(move |e| output.lock().unwrap().push(e)),
            events,
        )
    }
    #[test]
    fn inbound_frames_share_one_bounded_bridge_event_without_postponing_the_deadline() {
        let (mut batch, events) = fixture();
        let start = Instant::now();
        batch.push(frame(1, 1), start);
        batch.push(frame(2, 1), start + Duration::from_millis(15));
        assert!(events.lock().unwrap().is_empty());
        batch.flush_due(start + Duration::from_millis(15));
        assert!(events.lock().unwrap().is_empty());
        batch.flush_due(start + Duration::from_millis(16));
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 1);
        let frames = events[0]["payload"]["frames"].as_array().unwrap();
        assert_eq!(
            frames
                .iter()
                .map(|f| f["bytes"][0].as_u64().unwrap())
                .collect::<Vec<_>>(),
            vec![1, 2]
        );
        assert_eq!(events[0]["payload"]["operationId"], "attempt");
    }
    #[test]
    fn acknowledgement_frames_precede_peer_removal_and_terminal_status() {
        let (mut batch, events) = fixture();
        let now = Instant::now();
        batch.push(frame(1, 1), now);
        batch.push(
            json!({"type":"peers","payload":{"endpointId":"connection","peers":[]}}),
            now,
        );
        batch.push(frame(2, 1), now);
        batch.push(
            json!({"type":"status","payload":{"endpointId":"connection","status":"closed"}}),
            now,
        );
        let events = events.lock().unwrap();
        assert_eq!(
            events
                .iter()
                .map(|e| e["type"].as_str().unwrap())
                .collect::<Vec<_>>(),
            vec!["frames", "peers", "frames", "status"]
        );
    }
    #[test]
    fn batching_never_combines_connection_or_session_identities() {
        let (mut batch, events) = fixture();
        let now = Instant::now();
        batch.push(frame(1, 1), now);
        let mut next = frame(2, 1);
        next["payload"]["sessionId"] = json!("replacement");
        batch.push(next, now);
        let mut next = frame(3, 1);
        next["payload"]["endpointId"] = json!("other");
        batch.push(next, now);
        batch.flush_due(now + Duration::from_millis(16));
        let events = events.lock().unwrap();
        assert_eq!(events.len(), 3);
        assert!(events
            .iter()
            .all(|e| e["payload"]["frames"].as_array().unwrap().len() == 1));
    }
    #[test]
    fn bridge_batches_remain_bounded_by_frame_count_and_encoded_bytes() {
        let (mut batch, events) = fixture();
        let now = Instant::now();
        for id in 0..401 {
            batch.push(frame(id, 1), now);
        }
        batch.flush_due(now + Duration::from_millis(16));
        {
            let events = events.lock().unwrap();
            assert_eq!(events.len(), 3);
            assert!(events
                .iter()
                .all(|e| e["payload"]["frames"].as_array().unwrap().len() <= 200));
        }
        events.lock().unwrap().clear();
        for id in 0..3 {
            batch.push(frame(id, 40000), now);
        }
        batch.flush_due(now + Duration::from_millis(16));
        assert_eq!(events.lock().unwrap().len(), 3);
    }
    #[test]
    fn a_large_legal_frame_is_forwarded_alone_and_drop_flushes_the_last_small_frame() {
        let (mut batch, events) = fixture();
        let now = Instant::now();
        batch.push(frame(1, 1), now);
        batch.push(frame(2, 1048576), now);
        assert_eq!(events.lock().unwrap().len(), 2);
        batch.push(frame(3, 1), now);
        drop(batch);
        assert_eq!(events.lock().unwrap().len(), 3);
    }
}
