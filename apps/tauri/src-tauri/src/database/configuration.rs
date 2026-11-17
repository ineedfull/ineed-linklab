// Endpoint, settings, send-template/history, and workspace transactions.
use super::*;

pub(super) fn list_endpoints_on(connection: &Connection) -> DbResult<Vec<EndpointProfile>> {
    let mut statement = connection
        .prepare("SELECT * FROM endpoint_profiles ORDER BY created_at, id")
        .map_err(db_error)?;
    let rows = statement
        .query_map([], endpoint_from_row)
        .map_err(db_error)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(db_error)
}

pub(super) fn endpoint_by_id(
    connection: &Connection,
    id: &str,
) -> DbResult<Option<EndpointProfile>> {
    connection
        .query_row(
            "SELECT * FROM endpoint_profiles WHERE id = ?1",
            [id],
            endpoint_from_row,
        )
        .optional()
        .map_err(db_error)
}

pub(super) fn save_endpoint_on(
    connection: &Connection,
    input: &EndpointInput,
) -> DbResult<EndpointProfile> {
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

pub(super) fn endpoint_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EndpointProfile> {
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

pub(super) fn get_settings_on(connection: &Connection) -> DbResult<BTreeMap<String, Value>> {
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

pub(super) fn save_template_on(connection: &Connection, template: &SendTemplate) -> DbResult<()> {
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

pub(super) fn list_templates_on(
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
pub(super) fn template_by_id(connection: &Connection, id: &str) -> DbResult<Option<SendTemplate>> {
    connection
        .query_row(
            "SELECT * FROM send_templates WHERE id = ?1",
            [id],
            template_from_row,
        )
        .optional()
        .map_err(db_error)
}

pub(super) fn template_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendTemplate> {
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

pub(super) fn validate_send_history_input(input: &SendHistoryInput) -> DbResult<Vec<u8>> {
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

pub(super) fn validate_send_history_query(query: &SendHistoryQuery) -> DbResult<()> {
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

pub(super) fn send_history_by_id(
    connection: &Connection,
    id: i64,
) -> DbResult<Option<SendHistoryRow>> {
    connection
        .query_row(
            "SELECT * FROM send_history WHERE id = ?1",
            [id],
            send_history_from_row,
        )
        .optional()
        .map_err(db_error)
}

pub(super) fn send_history_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SendHistoryRow> {
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

pub(super) fn export_on(connection: &Connection) -> DbResult<Workspace> {
    Ok(Workspace {
        version: WORKSPACE_VERSION,
        endpoint_profiles: list_endpoints_on(connection)?,
        settings: get_settings_on(connection)?,
        send_templates: list_templates_on(connection, None)?,
    })
}

impl ConfigurationDatabase {
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
}

impl ConfigurationDatabase {
    pub(crate) fn export_workspace(&self) -> DbResult<Workspace> {
        let connection = self.connection()?;
        export_on(&connection)
    }

    pub(super) fn prepare_workspace_import(&self, mut workspace: Workspace) -> DbResult<Workspace> {
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
}
