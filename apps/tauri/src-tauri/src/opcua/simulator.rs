//! Local, anonymous OPC UA simulation. Client PKI and profiles are independent.
mod manager;
mod validation;
use super::*;
use opcua::server::{
    address_space::{AccessLevel, VariableBuilder},
    diagnostics::NamespaceMetadata,
    ServerBuilder, ServerEndpoint, ServerHandle, ANONYMOUS_USER_TOKEN_ID,
};

struct Node {
    spec: Value,
    initial: Variant,
}
#[derive(Clone)]
struct RuntimeNode {
    id: NodeId,
    spec: Value,
}
struct LiveServer {
    id: String,
    manager: Arc<manager::Manager>,
    handle: ServerHandle,
    nodes: Vec<RuntimeNode>,
    task: AsyncMutex<Option<JoinHandle<()>>>,
}
struct ServerEntry {
    generation: u64,
    token: CancellationToken,
    finished: CancellationToken,
    live: Option<Arc<LiveServer>>,
}
pub(super) struct Simulators {
    entries: Arc<Mutex<HashMap<String, ServerEntry>>>,
    profiles_lock: Mutex<()>,
}
impl Default for Simulators {
    fn default() -> Self {
        Self {
            entries: Arc::new(Mutex::new(HashMap::new())),
            profiles_lock: Mutex::new(()),
        }
    }
}
struct Reservation {
    entries: Arc<Mutex<HashMap<String, ServerEntry>>>,
    connection: String,
    generation: u64,
    token: CancellationToken,
    finished: CancellationToken,
    committed: bool,
}
impl Drop for Reservation {
    fn drop(&mut self) {
        self.finished.cancel();
        if !self.committed {
            self.token.cancel();
            let mut entries = self.entries.lock().unwrap();
            if entries
                .get(&self.connection)
                .is_some_and(|e| e.generation == self.generation)
            {
                entries.remove(&self.connection);
            }
        }
    }
}
impl Simulators {
    pub(super) async fn dispatch(
        &self,
        service: &OpcUaService,
        action: &str,
        r: &Value,
    ) -> Result<Value, String> {
        match action {
            "serverProfiles" | "saveServerProfiles" => {
                let _lock = self.profiles_lock.lock().unwrap();
                let path = service.directory.join("server-profiles.json");
                let profiles = if action == "saveServerProfiles" {
                    let profiles = validation::profiles(&r["profiles"])?;
                    fs::create_dir_all(&service.directory).map_err(err)?;
                    atomic_write(&path, &serde_json::to_vec_pretty(&profiles).map_err(err)?)?;
                    profiles
                } else if path.exists() {
                    if fs::metadata(&path).map_err(err)?.len() > 1024 * 1024 {
                        return Err("Server profiles exceed 1 MiB".into());
                    }
                    validation::profiles(
                        &serde_json::from_slice::<Value>(&fs::read(path).map_err(err)?)
                            .map_err(err)?,
                    )?
                } else {
                    json!([])
                };
                Ok(json!({"profiles":profiles}))
            }
            "startServer" => self.start(service, r).await,
            "stopServer" => {
                let connection = text(r, "connectionId")?;
                let session_id = r
                    .get("sessionId")
                    .map(|_| text(r, "sessionId"))
                    .transpose()?;
                let entry = {
                    let mut entries = self.entries.lock().unwrap();
                    if entries.get(connection).is_some_and(|e| {
                        session_id.is_none_or(|id| format!("opcua-server-{}", e.generation) == id)
                    }) {
                        entries.remove(connection)
                    } else {
                        None
                    }
                };
                if let Some(entry) = entry {
                    Self::close(entry).await;
                }
                Ok(json!({"stopped":true}))
            }
            "serverSnapshot" | "setServerValue" => {
                let connection = text(r, "connectionId")?;
                let id = text(r, "sessionId")?;
                // Keep this lock until the local operation finishes, fencing concurrent stop/restart.
                let entries = self.entries.lock().unwrap();
                let live = entries
                    .get(connection)
                    .filter(|e| !e.token.is_cancelled())
                    .and_then(|e| e.live.as_ref())
                    .filter(|l| l.id == id)
                    .ok_or("Stale or stopped OPC UA server session")?;
                if action == "serverSnapshot" {
                    let values = live
                        .nodes
                        .iter()
                        .map(|n| {
                            manager::read(&live.manager, &n.id)
                                .map(|value| data_value(&n.id.to_string(), &value))
                        })
                        .collect::<Result<Vec<_>, _>>()?;
                    Ok(json!({"values":values}))
                } else {
                    let target = text(r, "nodeId")?;
                    let node = live
                        .nodes
                        .iter()
                        .find(|n| n.id.to_string() == target)
                        .ok_or("Unknown simulator nodeId")?;
                    let spec = &node.spec;
                    let value = validation::value(
                        text(spec, "dataType")?,
                        text(spec, "arrayType")?,
                        &r["value"],
                    )?;
                    let data = DataValue::new_now(value);
                    live.manager
                        .set_value(live.handle.subscriptions(), &node.id, None, data)
                        .map_err(err)?;
                    Ok(json!({"updated":true}))
                }
            }
            _ => unreachable!(),
        }
    }
    async fn start(&self, service: &OpcUaService, r: &Value) -> Result<Value, String> {
        let connection = text(r, "connectionId")?.to_owned();
        let config = validation::config(&r["config"])?;
        let nodes = validation::nodes(&r["nodes"])?;
        let generation = NEXT.fetch_add(1, Ordering::SeqCst);
        let token = CancellationToken::new();
        let finished = CancellationToken::new();
        let mut reservation = Reservation {
            entries: self.entries.clone(),
            connection: connection.clone(),
            generation,
            token: token.clone(),
            finished: finished.clone(),
            committed: false,
        };
        {
            let mut entries = self.entries.lock().unwrap();
            if service.stopped.load(Ordering::SeqCst) {
                return Err("OPC UA service has shut down".into());
            }
            if entries.contains_key(&connection) {
                return Err("OPC UA simulator is already starting or running".into());
            }
            if entries.len() >= 4 {
                return Err("At most 4 simultaneous OPC UA simulators".into());
            }
            entries.insert(
                connection.clone(),
                ServerEntry {
                    generation,
                    token: token.clone(),
                    finished,
                    live: None,
                },
            );
        }
        let host = text(&config, "listenHost")?;
        let port = config["listenPort"].as_u64().unwrap() as u16;
        let listener = tokio::net::TcpListener::bind((host, port))
            .await
            .map_err(|e| format!("Cannot listen on {host}:{port}: {e}"))?;
        let cfg = config.clone();
        let build_token = token.clone();
        let pki = service.directory.join("server-pki");
        let mut build = tokio::task::spawn_blocking(move || {
            ServerBuilder::new()
                .application_name("Ineed LinkLab OPC UA Simulator")
                .application_uri("urn:ineedfull:linklab:simulator:server")
                .product_uri("urn:ineedfull:linklab")
                .host(cfg["listenHost"].as_str().unwrap())
                .port(port)
                .pki_dir(pki)
                .create_sample_keypair(false)
                .trust_client_certs(false)
                .add_endpoint(
                    "none",
                    ServerEndpoint::new_none(
                        cfg["path"].as_str().unwrap(),
                        &[ANONYMOUS_USER_TOKEN_ID.to_string()],
                    ),
                )
                .discovery_urls(vec![cfg["path"].as_str().unwrap().to_owned()])
                .with_node_manager(manager::builder(
                    cfg["namespaceUri"].as_str().unwrap().to_owned(),
                ))
                .max_array_length(100)
                .max_string_length(4096 * 4)
                .max_byte_string_length(4096)
                .max_sessions(16)
                .max_message_size(2 * 1024 * 1024)
                .max_chunk_count(40)
                .token(build_token)
                .build()
        });
        let (server, handle) = tokio::select! {
            _=token.cancelled()=>{drop(listener);let _=build.await;return Err("OPC UA server start cancelled".into());},
            result=&mut build=>result.map_err(err)??,
        };
        if token.is_cancelled() || service.stopped.load(Ordering::SeqCst) {
            return Err("OPC UA server start cancelled".into());
        }
        let ns = handle
            .get_namespace_index(text(&config, "namespaceUri")?)
            .ok_or("Simulator namespace missing")?;
        let manager = handle
            .node_managers()
            .get_of_type::<manager::Manager>()
            .ok_or("Simulator node manager missing")?;
        let folder = NodeId::new(ns, "LinkLab");
        let mut owned = Vec::new();
        {
            let mut space = manager.address_space().write();
            space.add_folder(
                &folder,
                QualifiedName::new(ns, "LinkLab"),
                "LinkLab",
                &ObjectId::ObjectsFolder.into(),
            );
            for node in nodes {
                let id = NodeId::new(ns, format!("LinkLab.{}", text(&node.spec, "id")?));
                let access = if node.spec["writable"] == true {
                    AccessLevel::CURRENT_READ | AccessLevel::CURRENT_WRITE
                } else {
                    AccessLevel::CURRENT_READ
                };
                let mut variable = VariableBuilder::new(
                    &id,
                    QualifiedName::new(ns, text(&node.spec, "name")?),
                    text(&node.spec, "name")?,
                )
                .data_type(NodeId::new(
                    0,
                    node.initial.scalar_type_id().ok_or("Missing scalar type")? as u32,
                ))
                .value(node.initial.clone())
                .access_level(access)
                .user_access_level(access)
                .value_rank(if node.spec["arrayType"] == "Array" {
                    1
                } else {
                    -1
                })
                .organized_by(&folder);
                if node.spec["arrayType"] == "Array" {
                    variable = variable.array_dimensions(&[0]);
                }
                variable.insert(&mut *space);
                owned.push(RuntimeNode {
                    id,
                    spec: node.spec,
                });
            }
        }
        for node in &owned {
            manager.inner().register(node.id.clone(), node.spec.clone());
        }
        let id = format!("opcua-server-{generation}");
        let live = Arc::new(LiveServer {
            id: id.clone(),
            manager: manager.clone(),
            handle: handle.clone(),
            nodes: owned,
            task: AsyncMutex::new(None),
        });
        let result = json!({"sessionId":id,"endpointUrl":format!("opc.tcp://{host}:{port}{}",text(&config,"path")?),"namespaceIndex":ns,"nodes":live.nodes.iter().map(|n|json!({"id":n.spec["id"],"nodeId":n.id.to_string()})).collect::<Vec<_>>()});
        let timer_nodes = live.nodes.clone();
        let timer_token = token.clone();
        let sink = service.sink.clone();
        let entries = self.entries.clone();
        let cid = connection.clone();
        let sid = id.clone();
        let mut entries_guard = self.entries.lock().unwrap();
        if token.is_cancelled()
            || entries_guard
                .get(&connection)
                .is_none_or(|e| e.generation != generation)
        {
            return Err("OPC UA server start cancelled".into());
        }
        let task = tokio::spawn(async move {
            let timer = run_simulation(manager, handle, timer_nodes, timer_token.clone());
            let (result, ()) = tokio::join!(
                async {
                    let result = server.run_with(listener).await;
                    timer_token.cancel();
                    result
                },
                timer
            );
            {
                let mut map = entries.lock().unwrap();
                if map.get(&cid).is_some_and(|e| e.generation == generation) {
                    map.remove(&cid);
                }
            }
            sink(
                json!({"type":"serverStatus","connectionId":cid,"sessionId":sid,"status":if result.is_err(){"error"}else{"stopped"},"message":result.err().unwrap_or_else(||"OPC UA simulator stopped".into())}),
            );
        });
        *live.task.try_lock().unwrap() = Some(task);
        entries_guard.get_mut(&connection).unwrap().live = Some(live);
        reservation.committed = true;
        Ok(result)
    }
    async fn close(entry: ServerEntry) {
        entry.token.cancel();
        if let Some(live) = entry.live {
            if let Some(mut task) = live.task.lock().await.take() {
                if timeout(Duration::from_secs(3), &mut task).await.is_err() {
                    task.abort();
                    let _ = task.await;
                }
            }
        } else {
            let _ = timeout(Duration::from_secs(3), entry.finished.cancelled()).await;
        }
    }
    pub(super) async fn shutdown(&self) {
        let entries = self
            .entries
            .lock()
            .unwrap()
            .drain()
            .map(|(_, e)| e)
            .collect::<Vec<_>>();
        futures::future::join_all(entries.into_iter().map(Self::close)).await;
    }
}
async fn run_simulation(
    manager: Arc<manager::Manager>,
    handle: ServerHandle,
    nodes: Vec<RuntimeNode>,
    token: CancellationToken,
) {
    let start = tokio::time::Instant::now();
    let mut due = nodes
        .iter()
        .map(|n| {
            start + Duration::from_millis(n.spec["simulation"]["intervalMs"].as_u64().unwrap())
        })
        .collect::<Vec<_>>();
    let mut tick = tokio::time::interval(Duration::from_millis(25));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    loop {
        tokio::select! {_=token.cancelled()=>break,_=tick.tick()=>{}}
        let now = tokio::time::Instant::now();
        for (i, node) in nodes.iter().enumerate() {
            let spec = &node.spec;
            let sim = &spec["simulation"];
            let mode = sim["mode"].as_str().unwrap();
            if mode == "manual" || now < due[i] {
                continue;
            }
            due[i] = now + Duration::from_millis(sim["intervalMs"].as_u64().unwrap());
            let current = manager::read(&manager, &node.id).ok().and_then(|v| v.value);
            let Some(current) = current else {
                continue;
            };
            let value = super::value::variant_json(&current);
            let next = if mode == "toggle" {
                json!(!value.as_bool().unwrap_or(false))
            } else {
                let min = sim["min"].as_f64().unwrap();
                let max = sim["max"].as_f64().unwrap();
                let step = sim["step"].as_f64().unwrap();
                let n = value.as_f64().unwrap_or(min);
                let next = if n + step < min || n + step > max {
                    min
                } else {
                    n + step
                };
                if matches!(spec["dataType"].as_str().unwrap(), "Float" | "Double") {
                    json!(next)
                } else {
                    json!(next as i64)
                }
            };
            if let Ok(value) =
                validation::value(spec["dataType"].as_str().unwrap(), "Scalar", &next)
            {
                let data = DataValue::new_now(value);
                let _ = manager.set_value(handle.subscriptions(), &node.id, None, data);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::*;
    #[tokio::test]
    async fn server_profiles_have_independent_validated_storage() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-server-profiles-{}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let service = OpcUaService::new(&dir, |_| {});
        let profile = json!({"id":"sim","name":"Simulator","config":{"listenHost":"127.0.0.1","listenPort":4840,"path":"/LinkLab","namespaceUri":"urn:ineedfull:linklab:simulator"},"nodes":[{"id":"counter","name":"Counter","dataType":"Int32","arrayType":"Scalar","value":0,"writable":true,"simulation":{"mode":"manual","intervalMs":1000,"min":0,"max":100,"step":1}}]});
        let result = service
            .execute(json!({"action":"saveServerProfiles","profiles":[profile.clone()]}))
            .await
            .expect("server profiles must be supported");
        assert_eq!(result["profiles"], json!([profile]));
        assert!(dir.join("opcua/server-profiles.json").exists());
        assert!(!dir.join("opcua/profiles.json").exists());
        let mut invalid = result["profiles"].clone();
        invalid[0]["config"]["listenHost"] = json!("192.168.1.1");
        assert!(service
            .execute(json!({"action":"saveServerProfiles","profiles":invalid}))
            .await
            .is_err());
        assert_eq!(
            service
                .execute(json!({"action":"serverProfiles"}))
                .await
                .unwrap(),
            result
        );
        service.shutdown().await;
        fs::remove_dir_all(dir).unwrap();
    }
    #[tokio::test]
    async fn server_lifecycle_values_capacity_and_old_session_fences() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-server-life-{}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let service = OpcUaService::new(&dir, |_| {});
        let node = json!({"id":"counter","name":"Counter","dataType":"Int32","arrayType":"Scalar","value":0,"writable":false,"simulation":{"mode":"manual","intervalMs":1000,"min":0,"max":100,"step":1}});
        let mut starts = Vec::new();
        for i in 0..4 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            let config = json!({"listenHost":"127.0.0.1","listenPort":port,"path":"/LinkLab","namespaceUri":"urn:ineedfull:linklab:simulator"});
            let request = json!({"action":"startServer","connectionId":format!("s{i}"),"config":config,"nodes":[node.clone()]});
            starts.push((
                request.clone(),
                service.execute(request).await.expect("server start"),
            ));
        }
        assert!(service.execute(json!({"action":"startServer","connectionId":"overflow","config":starts[0].0["config"],"nodes":[node]})).await.unwrap_err().contains("4"));
        assert!(
            service
                .execute(json!({"action":"stopServer","connectionId":"s0","sessionId":123}))
                .await
                .is_err(),
            "malformed session fence must never act as unconditional stop"
        );
        assert!(
            service.execute(starts[0].0.clone()).await.is_err(),
            "duplicate active start must preserve the existing instance"
        );
        let first = &starts[0].1;
        let base = json!({"connectionId":"s0","sessionId":first["sessionId"]});
        let mut set = base.clone();
        set["action"] = json!("setServerValue");
        set["nodeId"] = first["nodes"][0]["nodeId"].clone();
        set["value"] = json!(42);
        service.execute(set).await.unwrap();
        let mut snap = base.clone();
        snap["action"] = json!("serverSnapshot");
        assert_eq!(
            service.execute(snap.clone()).await.unwrap()["values"][0]["value"],
            42
        );
        service
            .execute(
                json!({"action":"stopServer","connectionId":"s0","sessionId":first["sessionId"]}),
            )
            .await
            .unwrap();
        let replacement = service.execute(starts[0].0.clone()).await.unwrap();
        service
            .execute(
                json!({"action":"stopServer","connectionId":"s0","sessionId":first["sessionId"]}),
            )
            .await
            .unwrap();
        assert!(service.execute(snap.clone()).await.is_err());
        snap["sessionId"] = replacement["sessionId"].clone();
        assert!(service.execute(snap).await.is_ok());
        service.shutdown().await;
        for (request, _) in starts {
            let host = format!("127.0.0.1:{}", request["config"]["listenPort"]);
            assert!(std::net::TcpListener::bind(host).is_ok());
        }
        let _ = fs::remove_dir_all(dir);
    }

    #[tokio::test]
    async fn stopping_a_pending_start_releases_its_bound_socket_before_returning() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-server-cancel-{}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let service = Arc::new(OpcUaService::new(&dir, |_| {}));
        let probe = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = probe.local_addr().unwrap().port();
        drop(probe);
        let req = json!({"action":"startServer","connectionId":"cancel","config":{"listenHost":"127.0.0.1","listenPort":port,"path":"/LinkLab","namespaceUri":"urn:cancel"},"nodes":[{"id":"n","name":"Node","dataType":"Int32","arrayType":"Scalar","value":0,"writable":true,"simulation":{"mode":"manual"}}]});
        let starting = {
            let service = service.clone();
            tokio::spawn(async move { service.execute(req).await })
        };
        for _ in 0..1000 {
            let pending = service
                .simulators
                .entries
                .lock()
                .unwrap()
                .get("cancel")
                .is_some_and(|e| e.live.is_none());
            if pending && std::net::TcpListener::bind(("127.0.0.1", port)).is_err() {
                break;
            }
            tokio::task::yield_now().await;
        }
        service
            .execute(json!({"action":"stopServer","connectionId":"cancel"}))
            .await
            .unwrap();
        assert!(
            std::net::TcpListener::bind(("127.0.0.1", port)).is_ok(),
            "stop must release pending listener before replying"
        );
        assert!(starting.await.unwrap().is_err());
        assert!(service.simulators.entries.lock().unwrap().is_empty());
        service.shutdown().await;
        let _ = fs::remove_dir_all(dir);
    }
    #[tokio::test]
    async fn concurrent_pending_starts_count_toward_capacity_and_shutdown_cancels_them() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-server-pending-{}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let service = Arc::new(OpcUaService::new(&dir, |_| {}));
        let mut tasks = Vec::new();
        let mut ports = Vec::new();
        for i in 0..4 {
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            drop(listener);
            ports.push(port);
            let r = json!({"action":"startServer","connectionId":format!("pending-{i}"),"config":{"listenPort":port},"nodes":[{"id":"n","name":"Node","dataType":"Int32","arrayType":"Scalar","value":0,"writable":true}]});
            let s = service.clone();
            tasks.push(tokio::spawn(async move { s.execute(r).await }));
        }
        for _ in 0..1000 {
            if service.simulators.entries.lock().unwrap().len() == 4 {
                break;
            }
            tokio::task::yield_now().await;
        }
        assert!(
            service
                .simulators
                .entries
                .lock()
                .unwrap()
                .values()
                .any(|e| e.live.is_none()),
            "must exercise a pending reservation"
        );
        let extra = json!({"action":"startServer","connectionId":"overflow","config":{},"nodes":[{"id":"n","name":"Node","dataType":"Int32","arrayType":"Scalar","value":0,"writable":true}]});
        assert!(service.execute(extra).await.unwrap_err().contains("4"));
        service.shutdown().await;
        for task in tasks {
            let _ = task.await.unwrap();
        }
        assert!(service.simulators.entries.lock().unwrap().is_empty());
        for port in ports {
            assert!(std::net::TcpListener::bind(("127.0.0.1", port)).is_ok());
        }
        let _ = fs::remove_dir_all(dir);
    }
}
