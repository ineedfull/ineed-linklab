//! Native OPC UA client. No renderer-owned networking or persistence.
mod certificates;
mod profiles;
mod simulator;
mod value;
use base64::{engine::general_purpose::STANDARD, Engine};
use futures::StreamExt;
use opcua::{
    client::{
        Client, ClientBuilder, DataChangeCallback, IdentityToken, MonitoredItem, Session,
        SessionDropGuard, SessionPollResult,
    },
    types::*,
};
use profiles::sanitize_profiles;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    str::FromStr,
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::Duration,
};
use tokio::{sync::Mutex as AsyncMutex, task::JoinHandle, time::timeout};
use tokio_util::sync::CancellationToken;
use value::{data_value, parse_variant};

const REQUEST_TIMEOUT: Duration = Duration::from_secs(10);
const MAX_CONNECTIONS: usize = 8;
static NEXT: AtomicU64 = AtomicU64::new(1);
type Sink = Arc<dyn Fn(Value) + Send + Sync>;
struct SessionResources {
    id: String,
    session: Arc<Session>,
    subscription: AsyncMutex<Option<(u32, CancellationToken)>>,
    desired: AsyncMutex<Option<(Vec<String>, u64)>>,
    operation: AsyncMutex<()>,
    cancelled: CancellationToken,
}
struct Live {
    resources: Arc<SessionResources>,
    _guard: SessionDropGuard,
    task: JoinHandle<()>,
}
impl std::ops::Deref for Live {
    type Target = SessionResources;
    fn deref(&self) -> &Self::Target {
        self.resources.as_ref()
    }
}
struct Attempt<'a> {
    service: &'a OpcUaService,
    id: String,
    generation: u64,
    cancelled: CancellationToken,
    committed: bool,
}
impl Drop for Attempt<'_> {
    fn drop(&mut self) {
        if !self.committed {
            self.cancelled.cancel();
            let mut entries = self.service.entries.lock().unwrap();
            if entries
                .get(&self.id)
                .is_some_and(|e| e.generation == self.generation)
            {
                entries.remove(&self.id);
            }
        }
    }
}
struct Entry {
    generation: u64,
    cancelled: CancellationToken,
    live: Option<Arc<Live>>,
}
pub struct OpcUaService {
    directory: PathBuf,
    simulators: simulator::Simulators,
    sink: Sink,
    entries: Mutex<HashMap<String, Entry>>,
    stopped: AtomicBool,
    profiles_lock: Mutex<()>,
    client_lock: Arc<Mutex<()>>,
}
impl OpcUaService {
    pub fn new(
        directory: impl Into<PathBuf>,
        sink: impl Fn(Value) + Send + Sync + 'static,
    ) -> Self {
        Self {
            directory: directory.into().join("opcua"),
            simulators: simulator::Simulators::default(),
            sink: Arc::new(sink),
            entries: Mutex::new(HashMap::new()),
            stopped: AtomicBool::new(false),
            profiles_lock: Mutex::new(()),
            client_lock: Arc::new(Mutex::new(())),
        }
    }
    async fn client(&self) -> Result<Client, String> {
        let directory = self.directory.clone();
        let lock = self.client_lock.clone();
        tokio::task::spawn_blocking(move || {
            let _lock = lock.lock().unwrap();
            fs::create_dir_all(&directory).map_err(err)?;
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).map_err(err)?;
            }
            certificates::ensure_client_identity(&directory.join("pki"))?;
            ClientBuilder::new()
                .application_name("Ineed LinkLab OPC UA")
                .application_uri("urn:ineedfull:linklab:opcua")
                .pki_dir(directory.join("pki"))
                .create_sample_keypair(false)
                .trust_server_certs(false)
                .recreate_subscriptions(false)
                .session_retry_limit(-1)
                .session_retry_initial(Duration::from_secs(1))
                .session_retry_max(Duration::from_secs(5))
                .client()
                .map_err(|e| e.join("; "))
        })
        .await
        .map_err(err)?
    }
    pub async fn execute(&self, request: Value) -> Result<Value, String> {
        if self.stopped.load(Ordering::SeqCst) {
            return Err("OPC UA service has shut down".into());
        }
        let action = request
            .get("action")
            .or_else(|| request.get("type"))
            .and_then(Value::as_str)
            .ok_or("Missing action")?;
        let duration = if action == "connect" {
            Duration::from_secs(15)
        } else {
            REQUEST_TIMEOUT
        };
        timeout(duration, self.dispatch(action, &request))
            .await
            .map_err(|_| format!("OPC UA {action} timed out"))?
    }
    async fn dispatch(&self, action: &str, r: &Value) -> Result<Value, String> {
        match action {
            "serverProfiles" | "saveServerProfiles" | "startServer" | "stopServer"
            | "serverSnapshot" | "setServerValue" => {
                self.simulators.dispatch(self, action, r).await
            }
            "profiles" => {
                let _lock = self.profiles_lock.lock().unwrap();
                let path = self.directory.join("profiles.json");
                let values = if path.exists() {
                    if fs::metadata(&path).map_err(err)?.len() > 1024 * 1024 {
                        return Err("OPC UA profiles exceed the 1 MiB size limit".into());
                    }
                    sanitize_profiles(
                        &serde_json::from_slice::<Value>(
                            &fs::read(path).map_err(|e| e.to_string())?,
                        )
                        .map_err(|e| e.to_string())?,
                    )?
                } else {
                    json!([])
                };
                Ok(json!({"profiles":values}))
            }
            "saveProfiles" => {
                let profiles = sanitize_profiles(&r["profiles"])?;
                let _lock = self.profiles_lock.lock().unwrap();
                fs::create_dir_all(&self.directory).map_err(|e| e.to_string())?;
                atomic_write(
                    &self.directory.join("profiles.json"),
                    &serde_json::to_vec_pretty(&profiles).map_err(|e| e.to_string())?,
                )?;
                Ok(json!({"profiles":profiles}))
            }
            "certificates" => {
                Ok(json!({"certificates":certificates::list(&self.directory.join("pki"))?}))
            }
            "trust" => {
                certificates::trust(&self.directory.join("pki"), text(r, "fingerprint")?)?;
                Ok(json!({"trusted":true}))
            }
            "discover" => {
                let url = text(r, "endpointUrl")?;
                validate_url(url)?;
                let client = self.client().await?;
                let endpoints = client.get_endpoints(url, &[], &[]).await.map_err(err)?;
                let mut values = Vec::new();
                for endpoint in endpoints {
                    values.push(self.endpoint_json(&endpoint)?);
                }
                Ok(json!({"endpoints":values}))
            }
            "connect" => self.connect(r).await,
            "disconnect" => {
                let id = text(r, "connectionId")?;
                let entry = self.entries.lock().unwrap().remove(id);
                if let Some(entry) = entry {
                    entry.cancelled.cancel();
                    if let Some(live) = entry.live {
                        self.close(live).await;
                    }
                }
                Ok(json!({"disconnected":true}))
            }
            "browse" | "releaseBrowse" | "read" | "write" | "subscribe" | "unsubscribe" => {
                let id = text(r, "connectionId")?;
                let session_id = text(r, "sessionId")?;
                let live = {
                    let entries = self.entries.lock().unwrap();
                    entries
                        .get(id)
                        .and_then(|e| e.live.as_ref())
                        .filter(|l| l.id == session_id && !l.cancelled.is_cancelled())
                        .cloned()
                        .ok_or("Stale or disconnected OPC UA session")?
                };
                let _operation = live.operation.lock().await;
                if live.cancelled.is_cancelled() {
                    return Err("Stale OPC UA session".into());
                }
                let result = self.session_request(action, r, &live, id).await?;
                if live.cancelled.is_cancelled() {
                    return Err("Stale OPC UA session".into());
                }
                Ok(result)
            }
            _ => Err(format!("Unknown OPC UA action: {action}")),
        }
    }
    fn endpoint_json(&self, e: &EndpointDescription) -> Result<Value, String> {
        let certificate = if e.server_certificate.as_ref().is_empty() {
            None
        } else {
            Some(certificates::remember(
                &self.directory.join("pki"),
                e.server_certificate.as_ref(),
            )?)
        };
        let authentication = e
            .user_identity_tokens
            .as_ref()
            .into_iter()
            .flatten()
            .filter_map(|t| match t.token_type {
                UserTokenType::Anonymous => Some("anonymous"),
                UserTokenType::UserName => Some("username"),
                _ => None,
            })
            .collect::<Vec<_>>();
        Ok(
            json!({"endpointUrl":e.endpoint_url.as_ref(),"securityPolicy":e.security_policy_uri.as_ref().rsplit('#').next().unwrap_or("None"),"securityMode":format!("{:?}",e.security_mode),"authentication":authentication,"serverCertificate":certificate}),
        )
    }
    async fn connect(&self, r: &Value) -> Result<Value, String> {
        let id = text(r, "connectionId")?.to_string();
        let config = &r["config"];
        validate_config(config)?;
        let generation = NEXT.fetch_add(1, Ordering::SeqCst);
        let cancelled = CancellationToken::new();
        let mut attempt = Attempt {
            service: self,
            id: id.clone(),
            generation,
            cancelled: cancelled.clone(),
            committed: false,
        };
        let old = {
            let mut entries = self.entries.lock().unwrap();
            if self.stopped.load(Ordering::SeqCst) {
                return Err("OPC UA service has shut down".into());
            }
            // Pending opens already own a slot; replacing the same ID reuses its slot.
            if entries.len() >= MAX_CONNECTIONS && !entries.contains_key(&id) {
                return Err("At most 8 simultaneous OPC UA connections".into());
            }
            entries.insert(
                id.clone(),
                Entry {
                    generation,
                    cancelled: cancelled.clone(),
                    live: None,
                },
            )
        };
        if let Some(old) = old {
            old.cancelled.cancel();
            if let Some(live) = old.live {
                self.close(live).await;
            }
        }
        let mut client = tokio::select! {
            result=self.client()=>result?,
            _=cancelled.cancelled()=>return Err("Connection cancelled".into()),
        };
        let endpoints = tokio::select! {
            result=client.get_endpoints(text(config,"endpointUrl")?,&[],&[])=>result.map_err(err)?,
            _=cancelled.cancelled()=>return Err("Connection cancelled".into()),
        };
        let policy = config["securityPolicy"].as_str().unwrap_or("None");
        let mode = config["securityMode"].as_str().unwrap_or("None");
        let authentication = config["authentication"].as_str().unwrap_or("anonymous");
        let endpoint = endpoints
            .into_iter()
            .find(|e| {
                e.security_policy_uri.as_ref().rsplit('#').next() == Some(policy)
                    && format!("{:?}", e.security_mode) == mode
                    && e.user_identity_tokens
                        .as_ref()
                        .into_iter()
                        .flatten()
                        .any(|t| {
                            matches!(
                                (authentication, t.token_type),
                                ("anonymous", UserTokenType::Anonymous)
                                    | ("username", UserTokenType::UserName)
                            )
                        })
            })
            .ok_or("Requested security and authentication endpoint is unavailable")?;
        let endpoint_info = self.endpoint_json(&endpoint)?;
        if policy != "None" && endpoint_info["serverCertificate"]["trusted"] != true {
            return Err(format!(
                "Untrusted server certificate: {}",
                endpoint_info["serverCertificate"]["fingerprint"]
                    .as_str()
                    .unwrap_or("unknown")
            ));
        }
        if cancelled.is_cancelled() {
            return Err("Connection cancelled".into());
        }
        let identity = if authentication == "username" {
            IdentityToken::new_user_name(
                text(config, "username")?,
                config["password"].as_str().unwrap_or(""),
            )
        } else {
            IdentityToken::Anonymous
        };
        let (session, event_loop) = client
            .connect_to_endpoint_directly(endpoint, identity)
            .map_err(err)?;
        let guard = session.close_on_drop();
        let session_id = format!("opcua-{generation}");
        let resources = Arc::new(SessionResources {
            id: session_id.clone(),
            session: session.clone(),
            subscription: AsyncMutex::new(None),
            desired: AsyncMutex::new(None),
            operation: AsyncMutex::new(()),
            cancelled: cancelled.clone(),
        });
        let event_resources = resources.clone();
        let (initial_tx, initial_rx) = tokio::sync::oneshot::channel();
        let sink = self.sink.clone();
        let event_connection = id.clone();
        let event_session = session_id.clone();
        let event_cancelled = cancelled.clone();
        let task = tokio::spawn(async move {
            let mut initial_tx = Some(initial_tx);
            let mut stream = Box::pin(event_loop.enter());
            while let Some(event) = stream.next().await {
                if event_cancelled.is_cancelled() {
                    break;
                }
                match &event {
                    Ok(SessionPollResult::Reconnected(_)) => {
                        if let Some(tx) = initial_tx.take() {
                            let _ = tx.send(Ok(()));
                        } else {
                            let resources = event_resources.clone();
                            let sink = sink.clone();
                            let cid = event_connection.clone();
                            tokio::spawn(async move {
                                let _operation = resources.operation.lock().await;
                                if resources.cancelled.is_cancelled() {
                                    return;
                                }
                                let desired = resources.desired.lock().await.clone();
                                if let Some((ids, interval)) = desired {
                                    let result = timeout(
                                        REQUEST_TIMEOUT,
                                        install_subscription(
                                            &resources,
                                            sink.clone(),
                                            cid.clone(),
                                            ids,
                                            interval,
                                        ),
                                    )
                                    .await;
                                    let error = match result {
                                        Ok(Ok(_)) => None,
                                        Ok(Err(error)) => Some(error),
                                        Err(_) => Some("Subscription recovery timed out".into()),
                                    };
                                    if let Some(message) = error {
                                        if !resources.cancelled.is_cancelled() {
                                            sink(
                                                json!({"connectionId":cid,"sessionId":resources.id,"type":"status","status":"error","message":message}),
                                            );
                                        }
                                    }
                                }
                            });
                        }
                    }
                    Ok(SessionPollResult::ReconnectFailed(code)) | Err(code) => {
                        if let Some(tx) = initial_tx.take() {
                            let _ = tx.send(Err(format!("OPC UA connection rejected: {code}")));
                        }
                    }
                    _ => {}
                }
                let detail = format!("{event:?}");
                let status = match event {
                    Ok(SessionPollResult::ConnectionLost(_))
                    | Ok(SessionPollResult::ReconnectFailed(_)) => Some("reconnecting"),
                    Ok(SessionPollResult::Reconnected(_)) => Some("connected"),
                    Err(_) => Some("error"),
                    _ => None,
                };
                if let Some(status) = status {
                    sink(
                        json!({"connectionId":event_connection,"sessionId":event_session,"type":"status","status":status,"message":detail}),
                    );
                }
            }
        });
        let initial_result = tokio::select! {
            result=initial_rx=>result,
            _=cancelled.cancelled()=>{task.abort();return Err("Connection cancelled".into());},
        };
        match initial_result {
            Ok(Ok(())) => {}
            Ok(Err(error)) => {
                task.abort();
                return Err(error);
            }
            Err(_) => {
                task.abort();
                return Err("Connection cancelled or closed".into());
            }
        }
        let live = Arc::new(Live {
            resources,
            _guard: guard,
            task,
        });
        let installed = {
            let mut entries = self.entries.lock().unwrap();
            if let Some(entry) = entries
                .get_mut(&id)
                .filter(|e| e.generation == generation && !cancelled.is_cancelled())
            {
                entry.live = Some(live.clone());
                true
            } else {
                false
            }
        };
        if !installed {
            self.close(live).await;
            return Err("Connection cancelled".into());
        }
        attempt.committed = true;
        Ok(json!({"sessionId":session_id}))
    }
    async fn session_request(
        &self,
        action: &str,
        r: &Value,
        live: &Arc<Live>,
        connection_id: &str,
    ) -> Result<Value, String> {
        let session = &live.session;
        match action {
            "releaseBrowse" => {
                let bytes = STANDARD
                    .decode(text(r, "continuationPoint")?)
                    .map_err(err)?;
                if bytes.is_empty() || bytes.len() > 65536 {
                    return Err("Invalid continuation point size".into());
                }
                let results = session
                    .browse_next(true, &[ByteString::from(bytes)])
                    .await
                    .map_err(err)?;
                // OPC UA permits an empty results array for a release request.
                if let Some(result) = results.first() {
                    if result.status_code.is_bad() {
                        return Err(result.status_code.to_string());
                    }
                }
                Ok(json!({"released":true}))
            }
            "browse" => {
                let results = if let Some(cp) = r["continuationPoint"].as_str() {
                    let bytes = STANDARD.decode(cp).map_err(err)?;
                    if bytes.len() > 65536 {
                        return Err("Continuation point is too large".into());
                    }
                    session
                        .browse_next(false, &[ByteString::from(bytes)])
                        .await
                        .map_err(err)?
                } else {
                    let node = node_id(r["nodeId"].as_str().unwrap_or("i=85"))?;
                    session
                        .browse(
                            &[BrowseDescription {
                                node_id: node,
                                browse_direction: BrowseDirection::Forward,
                                reference_type_id: ReferenceTypeId::HierarchicalReferences.into(),
                                include_subtypes: true,
                                node_class_mask: 0,
                                result_mask: 63,
                            }],
                            100,
                            None,
                        )
                        .await
                        .map_err(err)?
                };
                let result = results.first().ok_or("Missing browse result")?;
                if result.status_code.is_bad() {
                    return Err(result.status_code.to_string());
                }
                let nodes=result.references.as_ref().into_iter().flatten().take(100).map(|v|json!({"nodeId":v.node_id.node_id.to_string(),"browseName":v.browse_name.to_string(),"displayName":v.display_name.text.as_ref(),"nodeClass":format!("{:?}",v.node_class)})).collect::<Vec<_>>();
                let cp = if result.continuation_point.as_ref().is_empty() {
                    None
                } else {
                    Some(STANDARD.encode(result.continuation_point.as_ref()))
                };
                Ok(json!({"nodes":nodes,"continuationPoint":cp}))
            }
            "read" => {
                let ids = node_ids(r)?;
                let reads = ids
                    .iter()
                    .map(|s| node_id(s).map(|n| ReadValueId::from(n)))
                    .collect::<Result<Vec<_>, _>>()?;
                let values = session
                    .read(&reads, TimestampsToReturn::Both, 0.0)
                    .await
                    .map_err(err)?;
                Ok(
                    json!({"values":ids.iter().zip(values.iter()).map(|(id,v)|data_value(id,v)).collect::<Vec<_>>()}),
                )
            }
            "write" => {
                let id = node_id(text(r, "nodeId")?)?;
                let variant =
                    parse_variant(text(r, "dataType")?, text(r, "arrayType")?, &r["value"])?;
                let results = session
                    .write(&[WriteValue {
                        node_id: id,
                        attribute_id: AttributeId::Value as u32,
                        index_range: NumericRange::None,
                        value: DataValue {
                            value: Some(variant),
                            ..DataValue::null()
                        },
                    }])
                    .await
                    .map_err(err)?;
                let status = results.first().ok_or("Missing write result")?;
                if status.is_bad() {
                    return Err(format!("OPC UA write rejected: {status}"));
                }
                Ok(json!({"statusCode":status.to_string()}))
            }
            "unsubscribe" => {
                *live.desired.lock().await = None;
                remove_subscription(live).await?;
                Ok(json!({"unsubscribed":true}))
            }
            "subscribe" => {
                let ids = node_ids(r)?;
                let interval = if r.get("intervalMs").is_some() {
                    r["intervalMs"]
                        .as_u64()
                        .ok_or("intervalMs must be an integer")?
                } else {
                    1000
                };
                if !(100..=60000).contains(&interval) {
                    return Err("intervalMs must be 100..60000".into());
                }
                *live.desired.lock().await = None;
                let sub = install_subscription(
                    live,
                    self.sink.clone(),
                    connection_id.to_string(),
                    ids.clone(),
                    interval,
                )
                .await?;
                *live.desired.lock().await = Some((ids, interval));
                Ok(json!({"subscriptionId":sub.to_string()}))
            }
            _ => unreachable!(),
        }
    }
    async fn close(&self, live: Arc<Live>) {
        live.cancelled.cancel();
        live.session.disable_reconnects();
        let _ = timeout(Duration::from_secs(2), live.session.disconnect()).await;
        live.task.abort();
    }
    pub async fn shutdown(&self) {
        self.stopped.store(true, Ordering::SeqCst);
        self.simulators.shutdown().await;
        let entries: Vec<_> = self
            .entries
            .lock()
            .unwrap()
            .drain()
            .map(|(_, e)| e)
            .collect();
        let mut closing = Vec::new();
        for entry in entries {
            entry.cancelled.cancel();
            if let Some(live) = entry.live {
                closing.push(self.close(live));
            }
        }
        futures::future::join_all(closing).await;
    }
}
async fn remove_subscription(live: &SessionResources) -> Result<(), String> {
    let mut sub = live.subscription.lock().await;
    if let Some((_id, cancelled)) = sub.as_ref() {
        cancelled.cancel();
        let ids = live
            .session
            .subscription_state()
            .lock()
            .subscription_ids()
            .unwrap_or_default();
        if !ids.is_empty() {
            let status = live.session.delete_subscriptions(&ids).await.map_err(err)?;
            if status
                .iter()
                .any(|s| s.is_bad() && *s != StatusCode::BadSubscriptionIdInvalid)
            {
                return Err("Subscription deletion failed".into());
            }
        }
        *sub = None;
    }
    Ok(())
}
async fn install_subscription(
    live: &SessionResources,
    sink: Sink,
    cid: String,
    ids: Vec<String>,
    interval: u64,
) -> Result<u32, String> {
    remove_subscription(live).await?;
    if live.cancelled.is_cancelled() {
        return Err("Session disconnected".into());
    }
    let cancelled = live.cancelled.clone();
    let subscription_cancelled = CancellationToken::new();
    let callback_cancelled = subscription_cancelled.clone();
    let sid = live.id.clone();
    let sub=live.session.create_subscription(Duration::from_millis(interval),120,10,100,0,true,DataChangeCallback::new(move |v:DataValue,item:&MonitoredItem|{
        if !cancelled.is_cancelled()&&!callback_cancelled.is_cancelled(){sink(json!({"connectionId":cid,"sessionId":sid,"type":"data","values":[data_value(&item.item_to_monitor().node_id.to_string(),&v)]}));}
    })).await.map_err(err)?;
    *live.subscription.lock().await = Some((sub, subscription_cancelled));
    let items = ids
        .iter()
        .map(|id| node_id(id).map(MonitoredItemCreateRequest::from))
        .collect::<Result<Vec<_>, _>>()?;
    let result = live
        .session
        .create_monitored_items(sub, TimestampsToReturn::Both, items)
        .await
        .map_err(err)?;
    if result.iter().any(|i| i.result.status_code.is_bad()) {
        remove_subscription(live).await?;
        return Err("One or more monitored items were rejected".into());
    }
    Ok(sub)
}
fn err(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn text<'a>(v: &'a Value, key: &str) -> Result<&'a str, String> {
    v[key]
        .as_str()
        .filter(|s| !s.trim().is_empty() && s.len() <= 8192)
        .ok_or_else(|| format!("Missing or invalid {key}"))
}
fn node_id(id: &str) -> Result<NodeId, String> {
    NodeId::from_str(id).map_err(|_| "Invalid NodeId".into())
}
fn node_ids(r: &Value) -> Result<Vec<String>, String> {
    let ids = r["nodeIds"]
        .as_array()
        .filter(|v| !v.is_empty() && v.len() <= 100)
        .ok_or("nodeIds must contain 1..100 nodes")?;
    ids.iter()
        .map(|v| {
            let s = v.as_str().ok_or("Invalid nodeId")?;
            node_id(s)?;
            Ok(s.to_string())
        })
        .collect()
}
fn validate_url(url: &str) -> Result<(), String> {
    if !url.starts_with("opc.tcp://") || url.len() > 2048 || url.chars().any(|c| c.is_control()) {
        Err("Invalid opc.tcp endpoint URL".into())
    } else {
        Ok(())
    }
}
fn validate_config(c: &Value) -> Result<(), String> {
    for key in [
        "securityPolicy",
        "securityMode",
        "authentication",
        "username",
        "password",
    ] {
        if c.get(key).is_some_and(|v| !v.is_string()) {
            return Err(format!("{key} must be a string"));
        }
    }
    validate_url(text(c, "endpointUrl")?)?;
    let policy = c["securityPolicy"].as_str().unwrap_or("None");
    let mode = c["securityMode"].as_str().unwrap_or("None");
    if !matches!(
        (policy, mode),
        ("None", "None") | ("Basic256Sha256", "Sign") | ("Basic256Sha256", "SignAndEncrypt")
    ) {
        return Err("Unsupported security policy/mode combination".into());
    }
    if !matches!(
        c["authentication"].as_str().unwrap_or("anonymous"),
        "anonymous" | "username"
    ) {
        return Err("Unsupported authentication".into());
    }
    Ok(())
}
fn atomic_write(path: &Path, bytes: &[u8]) -> Result<(), String> {
    use std::io::Write;
    let temporary = path.with_extension(format!("{}.tmp", NEXT.fetch_add(1, Ordering::SeqCst)));
    let result = (|| {
        let mut options = fs::OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary).map_err(err)?;
        file.write_all(bytes).map_err(err)?;
        file.sync_all().map_err(err)?;
        fs::rename(&temporary, path).map_err(err)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}
fn command_envelope(result: Result<Value, String>) -> crate::runtime::Envelope {
    match result {
        Ok(value) => crate::runtime::success(value),
        Err(message) => crate::runtime::opcua_failure(message),
    }
}
#[tauri::command]
pub(crate) async fn opcua_execute(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    request: Value,
) -> Result<crate::runtime::Envelope, String> {
    Ok(command_envelope(
        opcua_execute_inner(window, app, state, request).await,
    ))
}
async fn opcua_execute_inner(
    window: tauri::WebviewWindow,
    app: tauri::AppHandle,
    state: tauri::State<'_, crate::AppState>,
    request: Value,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("OPC UA commands require the main window".into());
    }
    if request["action"] == "export" {
        use tauri_plugin_dialog::DialogExt;
        let (file_name, content) = validate_export(&request)?;
        let (filter_name, extension) = export_filter(&file_name);
        return tokio::task::spawn_blocking(move || {
            let selected = app
                .dialog()
                .file()
                .set_title("导出文件")
                .set_file_name(&file_name)
                .add_filter(filter_name, &[extension])
                .blocking_save_file();
            let Some(selected) = selected else {
                return Ok(json!({"saved":false}));
            };
            let path = selected.into_path().map_err(err)?;
            atomic_write(&path, content.as_bytes())?;
            Ok(json!({"saved":true,"path":path.to_string_lossy()}))
        })
        .await
        .map_err(err)?;
    }
    state.opcua_service.execute(request).await
}
fn validate_export(request: &Value) -> Result<(String, String), String> {
    let file_name = text(request, "fileName")?;
    if !matches!(
        file_name,
        "opcua-values.csv"
            | "opcua-profiles.json"
            | "linklab-device-template.json"
            | "linklab-acceptance-plan.json"
            | "linklab-acceptance-report.json"
            | "linklab-acceptance-report.md"
    ) {
        return Err("Invalid export filename".into());
    }
    if request.get("path").is_some() || request.get("filePath").is_some() {
        return Err("Renderer export paths are not accepted".into());
    }
    let content = request["content"]
        .as_str()
        .filter(|value| value.len() <= 1024 * 1024)
        .ok_or("Invalid or oversized export content")?;
    Ok((file_name.to_string(), content.to_string()))
}
fn export_filter(file_name: &str) -> (&'static str, &'static str) {
    if file_name.ends_with(".md") {
        ("Markdown", "md")
    } else if file_name.ends_with(".csv") {
        ("CSV", "csv")
    } else {
        ("JSON", "json")
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn acceptance_exports_are_fixed_bounded_and_reject_renderer_paths() {
        for name in [
            "linklab-device-template.json",
            "linklab-acceptance-plan.json",
            "linklab-acceptance-report.json",
            "linklab-acceptance-report.md",
        ] {
            let request = json!({"fileName":name,"content":"evidence"});
            assert!(validate_export(&request).is_ok());
            for field in ["path", "filePath"] {
                let mut forged = request.clone();
                forged[field] = json!("/tmp/forged");
                assert!(validate_export(&forged).is_err());
            }
        }
        assert!(validate_export(
            &json!({"fileName":"../linklab-acceptance-report.md","content":"x"})
        )
        .is_err());
        assert!(validate_export(&json!({"fileName":"linklab-acceptance-report.md","content":"x".repeat(1024 * 1024 + 1)})).is_err());
        assert_eq!(
            export_filter("linklab-acceptance-report.md"),
            ("Markdown", "md")
        );
    }
    #[test]
    fn write_rejects_lossy_integers_and_bad_arrays() {
        assert!(parse_variant("UInt64", "Scalar", &json!(18446744073709551615u64)).is_err());
        assert!(parse_variant("UInt64", "Scalar", &json!("18446744073709551615")).is_ok());
        assert!(parse_variant("SByte", "Scalar", &json!(128)).is_err());
        assert!(parse_variant("Boolean", "Scalar", &json!("false")).is_err());
        assert!(parse_variant("DateTime", "Scalar", &json!("invalid")).is_err());
        assert!(parse_variant("Byte", "Array", &json!([1, 256])).is_err());
    }
    #[test]
    fn profiles_redact_passwords_and_reject_excess() {
        let profiles = sanitize_profiles(&json!([{"id":"a","name":"Demo","config":{"endpointUrl":"opc.tcp://localhost:4840","password":"secret","username":"user"},"favorites":[]}])).unwrap();
        assert!(profiles[0]["config"].get("password").is_none());
        assert_eq!(profiles[0]["config"]["username"], "user");
        assert!(sanitize_profiles(&json!(vec![json!({}); 51])).is_err());
    }
}
#[cfg(test)]
mod lifecycle_tests {
    use super::*;

    #[tokio::test]
    async fn pending_connections_enforce_capacity_and_release_cancelled_slots() {
        let directory = std::env::temp_dir().join(format!(
            "linklab-opcua-capacity-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let endpoint = format!("opc.tcp://{}", listener.local_addr().unwrap());
        let (accepted, mut connections) = tokio::sync::mpsc::unbounded_channel();
        let server = tokio::spawn(async move {
            let mut sockets = Vec::new();
            while let Ok((socket, _)) = listener.accept().await {
                sockets.push(socket); // Keep real OPC UA handshakes pending.
                if accepted.send(()).is_err() {
                    break;
                }
            }
        });
        let service = Arc::new(OpcUaService::new(&directory, |_| {}));
        let connect = |id: String| {
            let service = service.clone();
            let endpoint = endpoint.clone();
            tokio::spawn(async move {
                service
                    .execute(json!({"action":"connect","connectionId":id,"config":{"endpointUrl":endpoint}}))
                    .await
            })
        };
        let mut opening = Vec::new();
        for index in 0..8 {
            opening.push(connect(format!("pending-{index}")));
        }
        for _ in 0..8 {
            timeout(Duration::from_secs(10), connections.recv())
                .await
                .expect("Each of the first eight connections must reach the local server")
                .unwrap();
        }
        let overflow = timeout(
            Duration::from_millis(300),
            service.execute(json!({"action":"connect","connectionId":"overflow","config":{"endpointUrl":endpoint}})),
        )
        .await;
        let rejected_without_network = connections.try_recv().is_err();

        // Reopening an existing ID consumes its existing slot and cancels only its old attempt.
        let replacement = connect("pending-0".into());
        let old_result = timeout(Duration::from_secs(2), &mut opening[0])
            .await
            .unwrap()
            .unwrap();
        timeout(Duration::from_secs(5), connections.recv())
            .await
            .unwrap()
            .unwrap();
        let still_full = service.entries.lock().unwrap().len();
        service
            .execute(json!({"action":"disconnect","connectionId":"pending-1"}))
            .await
            .unwrap();
        let cancelled_result = timeout(Duration::from_secs(2), &mut opening[1])
            .await
            .unwrap()
            .unwrap();
        let admitted = connect("new-after-disconnect".into());
        timeout(Duration::from_secs(5), connections.recv())
            .await
            .unwrap()
            .unwrap();
        let refilled = service.entries.lock().unwrap().len();
        admitted.abort();
        assert!(admitted.await.unwrap_err().is_cancelled());
        let after_abort = service.entries.lock().unwrap().len();

        service.shutdown().await;
        assert!(replacement.await.unwrap().is_err());
        for task in opening.into_iter().skip(2) {
            assert!(task.await.unwrap().is_err());
        }
        server.abort();
        let _ = server.await;
        fs::remove_dir_all(directory).unwrap();

        let error = overflow
            .expect("Ninth connection must be rejected before starting network work")
            .unwrap_err();
        assert!(error.contains('8'), "Unexpected capacity error: {error}");
        assert!(rejected_without_network);
        assert!(old_result.is_err());
        assert!(cancelled_result.is_err());
        assert_eq!(still_full, 8);
        assert_eq!(refilled, 8);
        assert_eq!(after_abort, 7);
        assert!(service.entries.lock().unwrap().is_empty());
    }

    #[tokio::test]
    async fn failed_client_initialization_releases_reserved_capacity() {
        let directory = std::env::temp_dir().join(format!(
            "linklab-opcua-capacity-failure-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&directory).unwrap();
        // A real filesystem failure occurs after reserving the connection, before networking.
        fs::write(directory.join("opcua"), b"not a directory").unwrap();
        let service = OpcUaService::new(&directory, |_| {});
        for index in 0..10 {
            let error = service
                .execute(json!({"action":"connect","connectionId":format!("failed-{index}"),"config":{"endpointUrl":"opc.tcp://127.0.0.1:1"}}))
                .await
                .unwrap_err();
            assert!(!error.contains("simultaneous"));
            assert!(service.entries.lock().unwrap().is_empty());
        }
        service.shutdown().await;
        fs::remove_dir_all(directory).unwrap();
    }

    #[tokio::test]
    async fn stale_session_and_shutdown_are_rejected() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-opcua-test-{}",
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let service = OpcUaService::new(&dir, |_| {});
        assert!(service
            .execute(
                json!({"action":"read","connectionId":"x","sessionId":"old","nodeIds":["i=85"]})
            )
            .await
            .unwrap_err()
            .contains("Stale"));
        service.shutdown().await;
        assert!(service.execute(json!({"action":"profiles"})).await.is_err());
        let _ = fs::remove_dir_all(dir);
    }
    #[test]
    fn dropping_old_connect_attempt_preserves_replacement_generation() {
        let service = OpcUaService::new(std::env::temp_dir(), |_| {});
        let old = CancellationToken::new();
        let replacement = CancellationToken::new();
        service.entries.lock().unwrap().insert(
            "same".into(),
            Entry {
                generation: 2,
                cancelled: replacement.clone(),
                live: None,
            },
        );
        drop(Attempt {
            service: &service,
            id: "same".into(),
            generation: 1,
            cancelled: old.clone(),
            committed: false,
        });
        assert!(old.is_cancelled());
        assert!(!replacement.is_cancelled());
        assert_eq!(
            service
                .entries
                .lock()
                .unwrap()
                .get("same")
                .unwrap()
                .generation,
            2
        );
    }
    #[tokio::test]
    async fn invalid_profile_save_preserves_previous_atomic_document() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-opcua-profile-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::SeqCst)
        ));
        let service = OpcUaService::new(&dir, |_| {});
        let profile = json!({"id":"saved","name":"Saved","config":{"endpointUrl":"opc.tcp://localhost:4840","password":"do-not-persist"},"favorites":[]});
        service
            .execute(json!({"action":"saveProfiles","profiles":[profile.clone()]}))
            .await
            .unwrap();
        let path = dir.join("opcua/profiles.json");
        let before = fs::read(&path).unwrap();
        assert!(!String::from_utf8_lossy(&before).contains("do-not-persist"));
        assert!(service
            .execute(json!({"action":"saveProfiles","profiles":[profile.clone(),profile]}))
            .await
            .is_err());
        assert_eq!(fs::read(&path).unwrap(), before);
        service.shutdown().await;
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn malformed_optional_security_fields_do_not_silently_default() {
        assert!(validate_config(
            &json!({"endpointUrl":"opc.tcp://localhost:4840","securityPolicy":123})
        )
        .is_err());
        assert!(validate_config(&json!({"endpointUrl":"opc.tcp://localhost:4840","securityPolicy":"Basic256Sha256","securityMode":"None"})).is_err());
        assert!(parse_variant("DateTime", "Scalar", &json!("1500-01-01T00:00:00Z")).is_err());
    }
}

#[cfg(test)]
mod command_tests {
    use super::*;
    #[test]
    fn native_command_uses_runtime_envelopes_for_success_and_failure() {
        assert_eq!(
            serde_json::to_value(command_envelope(Ok(json!({"profiles":[]})))).unwrap(),
            json!({"ok":true,"value":{"profiles":[]}})
        );
        let failure =
            serde_json::to_value(command_envelope(Err("server unavailable".into()))).unwrap();
        assert_eq!(failure["ok"], false);
        assert_eq!(failure["error"]["message"], "server unavailable");
        assert_eq!(failure["error"]["runtimeName"], "tauri");
    }
}
