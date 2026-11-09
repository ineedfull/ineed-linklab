use super::*;
use serde_json::json;
use std::{net::TcpListener, thread, time::Instant};
use tokio_tungstenite::connect_async_with_config;

#[derive(Default)]
struct Events(Mutex<Vec<SerialEvent>>);
impl SerialEventSink for Events {
    fn emit(&self, event: SerialEvent) {
        self.0.lock().unwrap().push(event);
    }
}
fn wait_for(events: &Events, predicate: impl Fn(&[SerialEvent]) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(6);
    loop {
        if predicate(&events.0.lock().unwrap()) {
            return;
        }
        assert!(
            Instant::now() < deadline,
            "events: {:?}",
            events.0.lock().unwrap()
        );
        thread::sleep(Duration::from_millis(10));
    }
}
fn port() -> u16 {
    TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port()
}
fn server(id: &str, port: u16) -> WebSocketEndpoint {
    WebSocketEndpoint {
        endpoint_id: id.into(),
        transport: "websocket-server".into(),
        config: json!({"listenHost":"127.0.0.1","listenPort":port,"path":"/socket","subprotocols":["chat"]}),
    }
}
fn client(id: &str, port: u16) -> WebSocketEndpoint {
    WebSocketEndpoint {
        endpoint_id: id.into(),
        transport: "websocket-client".into(),
        config: json!({"url":format!("ws://127.0.0.1:{port}/socket?token=secret"),"subprotocols":["chat"]}),
    }
}
fn peers(events: &Events, id: &str) -> Vec<PeerRecord> {
    events
        .0
        .lock()
        .unwrap()
        .iter()
        .rev()
        .find_map(|e| match e {
            SerialEvent::Peers(p) if p.endpoint_id == id => Some(p.peers.clone()),
            _ => None,
        })
        .unwrap_or_default()
}
#[test]
fn websocket_config_rejects_secrets_invalid_urls_protocols_and_headers() {
    for value in [
        json!({"url":"ws://user:pass@localhost/"}),
        json!({"url":"ws://localhost/#x"}),
        json!({"url":"http://localhost/"}),
        json!({"url":"ws://localhost","headers":{}}),
        json!({"url":"ws://localhost","websocketHeaders":[]}),
        json!({"url":"ws://localhost","subprotocols":["a","a"]}),
        json!({"url":"ws://localhost","heartbeat":{"enabled":true,"intervalMs":1}}),
    ] {
        assert!(
            validate_config("websocket-client", &value, false).is_err(),
            "{value}"
        );
    }
    for (name, value) in [
        ("Host", "evil"),
        ("sec-websocket-key", "evil"),
        ("Authorization", "secret\r\nX: y"),
        ("X-Test", "snowman \u{2603}"),
        ("X-Test", "\u{7f}"),
    ] {
        assert!(validate_headers(&[WebSocketHeader {
            name: name.into(),
            value: value.into()
        }])
        .is_err());
    }
    assert!(validate_headers(&[WebSocketHeader {
        name: "Authorization".into(),
        value: "Bearer secret".into()
    }])
    .is_ok());
    assert!(validate_config("websocket-client", &json!({"url":"wss://localhost/","heartbeat":{"enabled":true,"intervalMs":1000,"timeoutMs":1000}}),false).is_ok());
}
#[test]
fn websocket_real_client_server_preserve_messages_broadcast_and_disconnect() {
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    service.open(server("s", port), "s-op", &[]).unwrap();
    service.open(client("a", port), "a-op", &[]).unwrap();
    service.open(client("b", port), "b-op", &[]).unwrap();
    wait_for(&events, |ev| {
        ev.iter()
            .any(|e| matches!(e, SerialEvent::Peers(p) if p.endpoint_id == "s" && p.peers.len()==2))
    });
    service.send("a", b"hello", None, Some("text")).unwrap();
    service
        .send("a", &[0, 255, 1], None, Some("binary"))
        .unwrap();
    wait_for(&events, |ev| {
        ev.iter()
            .filter_map(|e| match e {
                SerialEvent::Frames(b) if b.endpoint_id == "s" => Some(&b.frames),
                _ => None,
            })
            .flatten()
            .filter(|f| f.direction == "in")
            .count()
            == 2
    });
    let frames: Vec<_> = events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            SerialEvent::Frames(b) if b.endpoint_id == "s" => Some(b.frames.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(frames[0].bytes, b"hello");
    assert_eq!(frames[0].message_type.as_deref(), Some("text"));
    assert_eq!(frames[1].bytes, [0, 255, 1]);
    assert_eq!(frames[1].message_type.as_deref(), Some("binary"));
    let ack = service
        .send(
            "s",
            b"broadcast",
            Some(&json!({"type":"broadcast"})),
            Some("text"),
        )
        .unwrap();
    assert_eq!(ack.success_count, Some(2));
    let peer = peers(&events, "s")[0].id.clone();
    service.disconnect_peer("s", &peer).unwrap();
    wait_for(&events, |ev| {
        ev.iter()
            .rev()
            .find_map(|e| match e {
                SerialEvent::Peers(p) if p.endpoint_id == "s" => Some(p.peers.len() == 1),
                _ => None,
            })
            .unwrap_or(false)
    });
    let healthy = peers(&events, "s")[0].id.clone();
    let mixed = service
        .send(
            "s",
            b"partial",
            Some(&json!({"type":"peer","peerIds":[peer,healthy]})),
            Some("text"),
        )
        .unwrap();
    assert_eq!(mixed.success_count, Some(1));
    assert_eq!(mixed.failure_count, Some(1));
    assert!(service
        .send(
            "s",
            b"still listening",
            Some(&json!({"type":"broadcast"})),
            Some("text")
        )
        .is_ok());
    assert!(service
        .send(
            "s",
            &[255],
            Some(&json!({"type":"broadcast"})),
            Some("text")
        )
        .is_err());
    assert!(service
        .send("s", &vec![0; MAX_MESSAGE_BYTES + 1], None, Some("binary"))
        .is_err());
    service.close_all().unwrap();
}

#[test]
fn websocket_cancel_pending_handshake_is_bounded_and_redacts_errors() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let events = Arc::new(Events::default());
    let service = Arc::new(WebSocketService::new(events.clone()));
    let worker = service.clone();
    let open = thread::spawn(move || {
        worker.open(
            client("pending", port),
            "old",
            &[WebSocketHeader {
                name: "Authorization".into(),
                value: "Bearer secret".into(),
            }],
        )
    });
    let (_stream, _) = listener.accept().unwrap();
    assert!(
        !service
            .cancel_open("pending", "unrelated")
            .unwrap()
            .cancelled
    );
    let start = Instant::now();
    assert!(service.cancel_open("pending", "old").unwrap().cancelled);
    assert_eq!(
        open.join().unwrap().unwrap_err().code,
        SerialErrorCode::OpenCancelled
    );
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(!format!("{:?}", events.0.lock().unwrap()).contains("secret"));
    service.shutdown().unwrap();
}
#[test]
fn websocket_handshake_checks_path_subprotocol_and_session_headers() {
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    service.open(server("s", port), "server", &[]).unwrap();
    let mut bad = client("bad", port);
    bad.config["subprotocols"] = json!(["other"]);
    assert!(service.open(bad, "bad-op", &[]).is_err());
    let mut bad = client("path", port);
    bad.config["url"] = json!(format!("ws://127.0.0.1:{port}/wrong"));
    assert!(service.open(bad, "bad-path", &[]).is_err());
    service.open(client("good", port), "ok", &[]).unwrap();
    service.close_all().unwrap();
}

#[test]
fn websocket_server_rejects_invalid_or_duplicate_handshake_keys() {
    use std::io::{Read, Write};
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    service
        .open(server("key-validation", port), "server", &[])
        .unwrap();
    let mut responses = Vec::new();
    for key_headers in [
        "Sec-WebSocket-Key: invalid\r\n",
        "Sec-WebSocket-Key: \r\n",
        "Sec-WebSocket-Key: YQ==\r\n",
        "Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAAA=\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZR==\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n",
        "Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==, dGhlIHNhbXBsZSBub25jZQ==\r\n",
    ] {
        let mut socket = std::net::TcpStream::connect(("127.0.0.1", port)).unwrap();
        socket.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        write!(socket,"GET /socket HTTP/1.1\r\nHost: 127.0.0.1:{port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Protocol: chat\r\n{key_headers}\r\n").unwrap();
        let mut bytes = [0; 1024];
        let count = socket.read(&mut bytes).unwrap();
        responses.push((key_headers, String::from_utf8_lossy(&bytes[..count]).into_owned()));
    }
    // The listener remains usable after rejected handshakes.
    service
        .open(client("good-key", port), "valid-key", &[])
        .unwrap();
    service.close_all().unwrap();
    for (key_headers, response) in responses {
        assert!(
            response.starts_with("HTTP/1.1 400"),
            "accepted {key_headers:?}: {response:?}"
        );
    }
}

#[test]
fn websocket_auth_headers_and_remote_close_are_protocol_frames_and_redacted() {
    use tokio_tungstenite::tungstenite;
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let remote = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let mut socket =
            tungstenite::accept_hdr(stream, |request: &Request, mut response: Response| {
                assert_eq!(request.headers()["authorization"], "Bearer secret-token");
                assert_eq!(request.headers()["sec-websocket-protocol"], "chat");
                response
                    .headers_mut()
                    .insert("sec-websocket-protocol", HeaderValue::from_static("chat"));
                Ok(response)
            })
            .unwrap();
        socket.send(Message::Text("one".into())).unwrap();
        socket.send(Message::Binary(vec![0, 255].into())).unwrap();
        socket
            .close(Some(CloseFrame {
                code: CloseCode::Away,
                reason: "secret-token".into(),
            }))
            .unwrap();
        let _ = socket.read();
    });
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    service
        .open(
            client("auth", port),
            "auth-op",
            &[WebSocketHeader {
                name: "Authorization".into(),
                value: "Bearer secret-token".into(),
            }],
        )
        .unwrap();
    wait_for(&events, |ev| {
        ev.iter()
            .any(|e| matches!(e,SerialEvent::Status(s) if s.status==SerialStatus::Closed))
    });
    let wire = format!("{:?}", events.0.lock().unwrap());
    assert!(!wire.contains("secret-token"), "{wire}");
    assert!(wire.contains("1001"));
    let frames: Vec<_> = events
        .0
        .lock()
        .unwrap()
        .iter()
        .filter_map(|e| match e {
            SerialEvent::Frames(b) => Some(b.frames.clone()),
            _ => None,
        })
        .flatten()
        .collect();
    assert_eq!(frames.len(), 2);
    assert_eq!(frames[0].message_type.as_deref(), Some("text"));
    assert_eq!(frames[1].message_type.as_deref(), Some("binary"));
    remote.join().unwrap();
    service.shutdown().unwrap();
}
#[test]
fn websocket_heartbeat_pong_survives_and_missing_pong_closes() {
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    let mut s = server("heart-server", port);
    s.config["heartbeat"] = json!({"enabled":true,"intervalMs":1000,"timeoutMs":1000});
    service.open(s, "server", &[]).unwrap();
    service.open(client("alive", port), "alive", &[]).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let stalled = runtime.block_on(async {
        let mut request = format!("ws://127.0.0.1:{port}/socket")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("sec-websocket-protocol", HeaderValue::from_static("chat"));
        connect_async_with_config(request, None, false)
            .await
            .unwrap()
            .0
    });
    wait_for(&events, |ev| {
        ev.iter().any(|e|matches!(e,SerialEvent::Status(s) if s.log.as_ref().is_some_and(|l|l.details.as_ref().is_some_and(|d|d["reason"]=="HEARTBEAT_TIMEOUT"))))
    });
    assert!(service
        .send("alive", b"still alive", None, Some("text"))
        .is_ok());
    drop(stalled);
    service.shutdown().unwrap();
}
#[test]
fn websocket_wss_rejects_a_real_untrusted_certificate() {
    use std::{
        io::{BufRead, BufReader},
        process::{Command, Stdio},
    };
    let fixtures = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tooling/websocket-test/fixtures");
    let mut child=Command::new("node").arg("-e").arg("const tls=require('node:tls'),fs=require('node:fs');const s=tls.createServer({key:fs.readFileSync(process.argv[1]),cert:fs.readFileSync(process.argv[2])},c=>c.end());s.on('tlsClientError',()=>{});s.listen(0,'127.0.0.1',()=>console.log(s.address().port));")
        .arg(fixtures.join("localhost-key.pem")).arg(fixtures.join("localhost-cert.pem")).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
    let mut port = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut port)
        .unwrap();
    let port: u16 = port.trim().parse().unwrap();
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let mut endpoint = client("secure", port);
    endpoint.config["url"] = json!(format!("wss://127.0.0.1:{port}/socket?token=super-secret"));
    let result = service.open(endpoint, "secure", &[]);
    child.kill().unwrap();
    child.wait().unwrap();
    assert_eq!(
        result.as_ref().unwrap_err().message,
        "WebSocket connection or TLS handshake failed"
    );
    assert!(!format!("{result:?} {:?}", events.0.lock().unwrap()).contains("super-secret"));
    service.shutdown().unwrap();
}
#[test]
fn websocket_capacity_includes_pending_handshakes_and_shutdown_releases_listener() {
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    service.open(server("s", port), "cap", &[]).unwrap();
    let sockets: Vec<_> = (0..MAX_PEERS)
        .map(|_| std::net::TcpStream::connect(("127.0.0.1", port)).unwrap())
        .collect();
    thread::sleep(Duration::from_millis(100));
    assert!(service
        .open(client("overflow", port), "cap-overflow", &[])
        .is_err());
    let start = Instant::now();
    service.shutdown().unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    drop(sockets);
    assert!(TcpListener::bind(("127.0.0.1", port)).is_ok());
}

#[test]
fn websocket_inbound_oversize_is_rejected_without_blocking_another_endpoint() {
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    service.open(server("s", port), "size", &[]).unwrap();
    service
        .open(client("healthy", port), "healthy", &[])
        .unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    runtime.block_on(async {
        let mut request = format!("ws://127.0.0.1:{port}/socket")
            .into_client_request()
            .unwrap();
        request
            .headers_mut()
            .insert("sec-websocket-protocol", HeaderValue::from_static("chat"));
        let (mut socket, _) = connect_async_with_config(request, None, false)
            .await
            .unwrap();
        // The receiver may reject the advertised length before the payload finishes writing.
        let _ = socket
            .send(Message::Binary(vec![0; MAX_MESSAGE_BYTES + 1].into()))
            .await;
        let _ = timeout(Duration::from_secs(2), socket.next()).await;
    });
    wait_for(&events, |ev| {
        ev.iter().any(|e|matches!(e,SerialEvent::Status(s) if s.log.as_ref().is_some_and(|l|l.message.contains("protocol limit exceeded"))))
    });
    assert!(service
        .send("healthy", b"survived", None, Some("text"))
        .is_ok());
    assert!(!events.0.lock().unwrap().iter().any(|e|matches!(e,SerialEvent::Frames(b) if b.frames.iter().any(|f|f.bytes.len()>MAX_MESSAGE_BYTES))));
    service.shutdown().unwrap();
}
#[test]
fn websocket_slow_peer_bounds_queue_and_keeps_other_sessions_responsive() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let (release_tx, release_rx) = std::sync::mpsc::channel();
    let remote = thread::spawn(move || {
        let (stream, _) = listener.accept().unwrap();
        let _socket = tokio_tungstenite::tungstenite::accept(stream).unwrap();
        let _ = release_rx.recv_timeout(Duration::from_secs(8));
    });
    let events = Arc::new(Events::default());
    let service = Arc::new(WebSocketService::new(events.clone()));
    let mut endpoint = client("slow", port);
    endpoint.config["subprotocols"] = json!([]);
    service.open(endpoint, "slow", &[]).unwrap();
    let good_port = super::tests::port();
    service.open(server("s", good_port), "good-s", &[]).unwrap();
    service
        .open(client("fast", good_port), "good-c", &[])
        .unwrap();
    let barrier = Arc::new(std::sync::Barrier::new(17));
    let workers: Vec<_> = (0..16)
        .map(|_| {
            let service = service.clone();
            let barrier = barrier.clone();
            thread::spawn(move || {
                barrier.wait();
                service.send("slow", &vec![1; MAX_MESSAGE_BYTES], None, Some("binary"))
            })
        })
        .collect();
    barrier.wait();
    let start = Instant::now();
    service
        .send("fast", b"independent", None, Some("text"))
        .unwrap();
    assert!(start.elapsed() < Duration::from_secs(1));
    let results: Vec<_> = workers.into_iter().map(|w| w.join().unwrap()).collect();
    assert!(results.iter().any(|r| r
        .as_ref()
        .is_err_and(|e| e.message.contains("4 MiB") || e.message.contains("queue"))));
    assert!(start.elapsed() < Duration::from_secs(4));
    let _ = release_tx.send(());
    remote.join().unwrap();
    service.shutdown().unwrap();
}

#[test]
fn websocket_abandoned_queued_send_never_reaches_the_wire() {
    let events = Arc::new(Events::default());
    let service = WebSocketService::new(events.clone());
    let port = port();
    service.open(server("s", port), "s", &[]).unwrap();
    service.open(client("a", port), "a", &[]).unwrap();
    let session = service.session("a").unwrap();
    let peer = session
        .peers
        .lock()
        .unwrap()
        .values()
        .next()
        .unwrap()
        .clone();
    let (reply, receiver) = oneshot::channel();
    drop(receiver);
    peer.tx
        .blocking_send(SendCommand {
            message: Message::Text("cancelled-payload".into()),
            bytes: b"cancelled-payload".to_vec(),
            message_type: "text".into(),
            deadline: tokio::time::Instant::now() + WRITE_TIMEOUT,
            reply,
            _budget: peer.budget.clone().try_acquire_owned().unwrap(),
        })
        .unwrap();
    let (reply, receiver) = oneshot::channel();
    peer.tx
        .blocking_send(SendCommand {
            message: Message::Text("expired-payload".into()),
            bytes: b"expired-payload".to_vec(),
            message_type: "text".into(),
            deadline: tokio::time::Instant::now() - Duration::from_millis(1),
            reply,
            _budget: peer.budget.clone().try_acquire_owned().unwrap(),
        })
        .unwrap();
    assert!(service
        .runtime
        .block_on(receiver)
        .unwrap()
        .unwrap_err()
        .message
        .contains("expired"));
    service.send("a", b"fresh", None, Some("text")).unwrap();
    wait_for(&events, |ev| {
        ev.iter().any(|e|matches!(e,SerialEvent::Frames(b) if b.endpoint_id=="s" && b.frames.iter().any(|f|f.bytes==b"fresh")))
    });
    assert!(!events.0.lock().unwrap().iter().any(|e|matches!(e,SerialEvent::Frames(b) if b.frames.iter().any(|f|f.bytes==b"cancelled-payload" || f.bytes==b"expired-payload"))));
    service.shutdown().unwrap();
}
