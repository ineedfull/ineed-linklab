// Frame and log history queries, validation, and batches.
use super::*;

pub(super) fn validate_history_query(query: &HistoryQuery) -> DbResult<()> {
    if !(1..=1_000_000).contains(&query.page) {
        return Err("page must be from 1 to 1000000".into());
    }
    if !(1..=200).contains(&query.page_size) {
        return Err("pageSize must be from 1 to 200".into());
    }
    if query.from.is_some_and(|value| value < 0) || query.to.is_some_and(|value| value < 0) {
        return Err("history timestamps must be non-negative".into());
    }
    Ok(())
}

const MIN_RUNTIME_HISTORY_TIMESTAMP: i64 = 1_000_000_000_000;

pub(super) fn validate_runtime_history_timestamp(value: i64, name: &str) -> DbResult<()> {
    validate_timestamp(value, name)?;
    if value < MIN_RUNTIME_HISTORY_TIMESTAMP {
        return Err(format!("{name} must be an epoch-millisecond timestamp"));
    }
    Ok(())
}

pub(super) fn validate_frame_history_batch(rows: &[FrameHistoryInsert]) -> DbResult<()> {
    for row in rows {
        for (value, name) in [
            (&row.endpoint_id, "endpointId"),
            (&row.session_id, "sessionId"),
            (&row.direction, "direction"),
            (&row.format, "format"),
            (&row.framing, "framing"),
        ] {
            require_text(value, name)?;
        }
        if row
            .peer_id
            .as_deref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("peerId must be a nonblank string or null".into());
        }
        if !matches!(row.direction.as_str(), "in" | "out") {
            return Err("direction must be in or out".into());
        }
        if row.byte_count != i64::try_from(row.payload.len()).map_err(|error| error.to_string())? {
            return Err("byteCount must match payload length".into());
        }
        validate_runtime_history_timestamp(row.created_at, "createdAt")?;
    }
    Ok(())
}

pub(super) fn validate_log_history_batch(
    rows: &[LogHistoryInsert],
) -> DbResult<Vec<(&LogHistoryInsert, Option<String>)>> {
    rows.iter()
        .map(|row| {
            for (value, name) in [
                (&row.endpoint_id, "endpointId"),
                (&row.level, "level"),
                (&row.source, "source"),
                (&row.message, "message"),
            ] {
                require_text(value, name)?;
            }
            for (value, name) in [
                (row.session_id.as_deref(), "sessionId"),
                (row.peer_id.as_deref(), "peerId"),
                (row.code.as_deref(), "code"),
            ] {
                if value.is_some_and(|value| value.trim().is_empty()) {
                    return Err(format!("{name} must be a nonblank string or null"));
                }
            }
            validate_runtime_history_timestamp(row.created_at, "createdAt")?;
            let details = match &row.details {
                Some(details) if details.is_object() => {
                    validate_fields(details)?;
                    Some(encode(details)?)
                }
                Some(_) => return Err("details must be an object or null".into()),
                None => None,
            };
            Ok((row, details))
        })
        .collect()
}

pub(super) fn history_offset(query: &HistoryQuery) -> DbResult<i64> {
    query
        .page
        .checked_sub(1)
        .and_then(|page| page.checked_mul(query.page_size))
        .ok_or_else(|| "history page offset is too large".into())
}

pub(super) fn history_filters(query: &HistoryQuery, frames: bool) -> (String, Vec<SqlValue>) {
    let mut conditions = Vec::new();
    let mut values = Vec::new();
    let mut add = |condition: &str, value: SqlValue| {
        conditions.push(condition.to_owned());
        values.push(value);
    };
    if let Some(endpoint_id) = query
        .endpoint_id
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        add("endpoint_id = ?", endpoint_id.to_owned().into());
    }
    if let Some(from) = query.from {
        add("created_at >= ?", from.into());
    }
    if let Some(to) = query.to {
        add("created_at <= ?", to.into());
    }
    let direction = query.direction.trim();
    if frames && !direction.is_empty() {
        add("direction = ?", direction.to_owned().into());
    }
    let level = query.level.trim();
    if !frames && !level.is_empty() {
        add("level = ?", level.to_owned().into());
    }
    let source = query.source.trim();
    if !frames && !source.is_empty() {
        add("source = ?", source.to_owned().into());
    }
    let search = query.search.trim();
    if !search.is_empty() {
        let escaped = format!(
            "%{}%",
            search
                .replace('\\', "\\\\")
                .replace('%', "\\%")
                .replace('_', "\\_")
        );
        if frames {
            add("CAST(payload AS TEXT) LIKE ? ESCAPE '\\'", escaped.into());
        } else {
            conditions.push("(message LIKE ? ESCAPE '\\' OR COALESCE(code, '') LIKE ? ESCAPE '\\' OR COALESCE(details_json, '') LIKE ? ESCAPE '\\')".into());
            values.extend([
                escaped.clone().into(),
                escaped.clone().into(),
                escaped.into(),
            ]);
        }
    }
    let where_sql = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    (where_sql, values)
}

pub(super) fn row_count(connection: &Connection, table: &str) -> DbResult<i64> {
    connection
        .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
            row.get(0)
        })
        .map_err(db_error)
}

impl ConfigurationDatabase {
    pub(crate) fn query_frames(
        &self,
        query: HistoryQuery,
    ) -> DbResult<HistoryPage<FrameHistoryRow>> {
        validate_history_query(&query)?;
        let connection = self.connection()?;
        let (where_sql, values) = history_filters(&query, true);
        let total: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM transfer_frames{where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let mut page_values = values;
        page_values.push(SqlValue::Integer(query.page_size));
        page_values.push(SqlValue::Integer(history_offset(&query)?));
        let mut statement = connection.prepare(&format!(
            "SELECT * FROM transfer_frames{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        )).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(page_values.iter()), |row| {
                let payload: Vec<u8> = row.get("payload")?;
                Ok(FrameHistoryRow {
                    id: row.get("id")?,
                    endpoint_id: row.get("endpoint_id")?,
                    session_id: row.get("session_id")?,
                    peer_id: row.get("peer_id")?,
                    direction: row.get("direction")?,
                    format: row.get("format")?,
                    framing: row.get("framing")?,
                    payload_base64: BASE64.encode(payload),
                    byte_count: row.get("byte_count")?,
                    created_at: row.get("created_at")?,
                })
            })
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

    pub(crate) fn insert_frame_batch(&self, rows: &[FrameHistoryInsert]) -> DbResult<()> {
        validate_frame_history_batch(rows)?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        for row in rows {
            transaction
                .execute(
                    "INSERT INTO transfer_frames
                     (endpoint_id, session_id, peer_id, direction, format, framing, payload, byte_count, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        row.endpoint_id,
                        row.session_id,
                        row.peer_id,
                        row.direction,
                        row.format,
                        row.framing,
                        row.payload,
                        row.byte_count,
                        row.created_at,
                    ],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub(crate) fn insert_log_batch(&self, rows: &[LogHistoryInsert]) -> DbResult<()> {
        let rows = validate_log_history_batch(rows)?;
        if rows.is_empty() {
            return Ok(());
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        for (row, details) in rows {
            transaction
                .execute(
                    "INSERT INTO runtime_logs
                     (endpoint_id, session_id, peer_id, level, source, code, message, details_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        row.endpoint_id,
                        row.session_id,
                        row.peer_id,
                        row.level,
                        row.source,
                        row.code,
                        row.message,
                        details,
                        row.created_at,
                    ],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)
    }

    pub(crate) fn query_logs(&self, query: HistoryQuery) -> DbResult<HistoryPage<LogHistoryRow>> {
        validate_history_query(&query)?;
        let connection = self.connection()?;
        let (where_sql, values) = history_filters(&query, false);
        let total: i64 = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM runtime_logs{where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let mut page_values = values;
        page_values.push(SqlValue::Integer(query.page_size));
        page_values.push(SqlValue::Integer(history_offset(&query)?));
        let mut statement = connection.prepare(&format!(
            "SELECT * FROM runtime_logs{where_sql} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
        )).map_err(db_error)?;
        let rows = statement
            .query_map(params_from_iter(page_values.iter()), |row| {
                let details: Option<String> = row.get("details_json")?;
                Ok(LogHistoryRow {
                    id: row.get("id")?,
                    endpoint_id: row.get("endpoint_id")?,
                    session_id: row.get("session_id")?,
                    peer_id: row.get("peer_id")?,
                    level: row.get("level")?,
                    source: row.get("source")?,
                    code: row.get("code")?,
                    message: row.get("message")?,
                    details: details.map(|value| decode(&value)).transpose()?,
                    created_at: row.get("created_at")?,
                })
            })
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
}
