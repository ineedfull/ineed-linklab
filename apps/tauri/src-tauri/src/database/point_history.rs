// Modbus point history persistence, aggregation, and CSV export.
use super::*;

pub(super) fn validate_modbus_point_history_batch(
    rows: &[ModbusPointHistoryInput],
) -> DbResult<()> {
    if rows.len() > 2_000 {
        return Err("Modbus point history batch must contain at most 2000 rows".into());
    }
    for row in rows {
        for (value, name) in [
            (&row.endpoint_id, "endpointId"),
            (&row.request_group_id, "requestGroupId"),
            (&row.request_id, "requestId"),
            (&row.point_id, "pointId"),
            (&row.point_key, "pointKey"),
        ] {
            require_bounded_id(value, name)?;
        }
        require_text(&row.point_name, "pointName")?;
        if !matches!(
            row.data_type.as_str(),
            "boolean"
                | "uint16"
                | "int16"
                | "uint32"
                | "int32"
                | "uint64"
                | "int64"
                | "float32"
                | "float64"
                | "string"
        ) {
            return Err("dataType is invalid".into());
        }
        if !row.raw.is_array() {
            return Err("raw must be an array".into());
        }
        validate_lossless_json(&row.raw, "raw")?;
        validate_lossless_json(&row.value, "value")?;
        if row.numeric_value.is_some_and(|value| !value.is_finite()) {
            return Err("numericValue must be a finite number or null".into());
        }
        require_text(&row.display_value, "displayValue")?;
        if !matches!(
            row.quality.as_str(),
            "good" | "disabled" | "uncertain-overflow" | "bad-value" | "bad-communication"
        ) {
            return Err("quality is invalid".into());
        }
        validate_timestamp(row.created_at, "createdAt")?;
    }
    Ok(())
}

pub(super) fn validate_lossless_json(value: &Value, name: &str) -> DbResult<()> {
    match value {
        Value::Number(number) => {
            if number
                .as_i64()
                .is_some_and(|value| !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&value))
                || number
                    .as_u64()
                    .is_some_and(|value| value > MAX_SAFE_TIMESTAMP as u64)
                || (number.as_f64() == Some(0.0) && number.to_string().starts_with('-'))
            {
                return Err(format!("{name} contains a value that is not lossless JSON"));
            }
        }
        Value::Array(values) => {
            for value in values {
                validate_lossless_json(value, name)?;
            }
        }
        Value::Object(values) => {
            for value in values.values() {
                validate_lossless_json(value, name)?;
            }
        }
        Value::Null | Value::Bool(_) | Value::String(_) => {}
    }
    Ok(())
}

pub(super) fn normalize_modbus_point_history_query(
    mut query: ModbusPointHistoryQuery,
    require_points: bool,
) -> DbResult<ModbusPointHistoryQuery> {
    require_bounded_id(&query.endpoint_id, "endpointId")?;
    validate_modbus_point_identities(&query.points, require_points)?;
    validate_timestamp(query.from, "from")?;
    validate_timestamp(query.to, "to")?;
    if query.from > query.to {
        return Err("from must be less than or equal to to".into());
    }
    if !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&query.page)
        || !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&query.page_size)
    {
        return Err("page values must be safe integers".into());
    }
    query.page = query.page.clamp(1, MAX_SAFE_TIMESTAMP);
    query.page_size = query.page_size.clamp(1, 200);
    Ok(query)
}

pub(super) fn normalize_modbus_point_series_query(
    mut query: ModbusPointSeriesQuery,
) -> DbResult<ModbusPointSeriesQuery> {
    require_bounded_id(&query.endpoint_id, "endpointId")?;
    validate_modbus_point_identities(&query.points, true)?;
    validate_timestamp(query.from, "from")?;
    validate_timestamp(query.to, "to")?;
    if query.from > query.to {
        return Err("from must be less than or equal to to".into());
    }
    if !(-MAX_SAFE_TIMESTAMP..=MAX_SAFE_TIMESTAMP).contains(&query.bucket_count) {
        return Err("bucketCount must be a safe integer".into());
    }
    query.bucket_count = query.bucket_count.clamp(1, 2_000);
    Ok(query)
}

pub(super) fn validate_modbus_point_identities(
    points: &[ModbusPointIdentity],
    required: bool,
) -> DbResult<()> {
    if (required && points.is_empty()) || points.len() > 6 {
        return Err("points must contain one to six point identities".into());
    }
    let mut seen = std::collections::BTreeSet::new();
    for point in points {
        for (value, name) in [
            (&point.request_group_id, "requestGroupId"),
            (&point.request_id, "requestId"),
            (&point.point_id, "pointId"),
        ] {
            require_bounded_id(value, name)?;
        }
        if !seen.insert((
            point.request_group_id.clone(),
            point.request_id.clone(),
            point.point_id.clone(),
        )) {
            return Err("points contains duplicate identities".into());
        }
    }
    Ok(())
}

pub(super) fn modbus_point_history_filters(
    query: &ModbusPointHistoryQuery,
) -> (String, Vec<SqlValue>) {
    let mut conditions = vec![
        "endpoint_id = ?".to_owned(),
        "created_at >= ?".to_owned(),
        "created_at <= ?".to_owned(),
    ];
    let mut values = vec![
        query.endpoint_id.clone().into(),
        query.from.into(),
        query.to.into(),
    ];
    if !query.points.is_empty() {
        conditions.push(format!(
            "({})",
            query
                .points
                .iter()
                .map(|_| "(request_group_id = ? AND request_id = ? AND point_id = ?)")
                .collect::<Vec<_>>()
                .join(" OR ")
        ));
        for point in &query.points {
            values.push(point.request_group_id.clone().into());
            values.push(point.request_id.clone().into());
            values.push(point.point_id.clone().into());
        }
    }
    (conditions.join(" AND "), values)
}

pub(super) fn modbus_point_history_from_row(
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<ModbusPointHistoryRow> {
    let raw: String = row.get("raw_json")?;
    let value: String = row.get("value_json")?;
    Ok(ModbusPointHistoryRow {
        id: row.get("id")?,
        endpoint_id: row.get("endpoint_id")?,
        request_group_id: row.get("request_group_id")?,
        request_id: row.get("request_id")?,
        point_id: row.get("point_id")?,
        point_key: row.get("point_key")?,
        point_name: row.get("point_name")?,
        data_type: row.get("data_type")?,
        unit: row.get("unit")?,
        raw: decode(&raw)?,
        value: decode(&value)?,
        numeric_value: row.get("numeric_value")?,
        display_value: row.get("display_value")?,
        quality: row.get("quality")?,
        reason: row.get("reason")?,
        created_at: row.get("created_at")?,
    })
}

#[derive(Default)]
struct NumericBucket {
    bucket: i64,
    first_at: Option<i64>,
    first_value: Option<f64>,
    last_at: Option<i64>,
    last_value: Option<f64>,
    min_at: Option<i64>,
    min_value: Option<f64>,
    max_at: Option<i64>,
    max_value: Option<f64>,
    good_count: i64,
    abnormal_count: i64,
    worst_quality: String,
    marker: Option<Value>,
}

pub(super) fn fold_modbus_point_series<I>(
    rows: I,
    query: &ModbusPointSeriesQuery,
) -> DbResult<Option<Value>>
where
    I: Iterator<Item = rusqlite::Result<ModbusPointHistoryRow>>,
{
    let mut latest = None;
    let mut previous_good_value = None;
    let mut minimum: Option<f64> = None;
    let mut maximum: Option<f64> = None;
    let mut change_count = 0_i64;
    let mut abnormal_count = 0_i64;
    let mut numeric_buckets = BTreeMap::<i64, NumericBucket>::new();
    let mut events = Vec::<Value>::new();
    let mut previous_event = None;
    let span = (query.to - query.from).saturating_add(1).max(1);

    for row in rows {
        let row = row.map_err(db_error)?;
        if row.quality == "good" {
            if previous_good_value
                .as_ref()
                .is_some_and(|previous: &Value| previous != &row.value)
            {
                change_count += 1;
            }
            previous_good_value = Some(row.value.clone());
        } else {
            abnormal_count += 1;
        }
        if let Some(value) = row.numeric_value {
            minimum = Some(minimum.map_or(value, |current| current.min(value)));
            maximum = Some(maximum.map_or(value, |current| current.max(value)));
        }

        if !matches!(row.data_type.as_str(), "boolean" | "string") {
            let bucket_number = (((row.created_at - query.from) * query.bucket_count) / span)
                .min(query.bucket_count - 1);
            let bucket = numeric_buckets
                .entry(bucket_number)
                .or_insert_with(|| NumericBucket {
                    bucket: bucket_number,
                    worst_quality: "good".into(),
                    ..NumericBucket::default()
                });
            if row.quality == "good" {
                bucket.good_count += 1;
            } else {
                bucket.abnormal_count += 1;
            }
            if modbus_quality_rank(&row.quality) > modbus_quality_rank(&bucket.worst_quality) {
                bucket.worst_quality = row.quality.clone();
            }
            if row.quality != "good"
                && bucket.marker.as_ref().is_none_or(|marker| {
                    modbus_quality_rank(&row.quality)
                        > modbus_quality_rank(marker["quality"].as_str().unwrap_or("good"))
                })
            {
                bucket.marker = Some(json!({
                    "createdAt": row.created_at,
                    "quality": row.quality,
                    "reason": row.reason,
                }));
            }
            if let Some(value) = row.numeric_value {
                if bucket.first_at.is_none() {
                    bucket.first_at = Some(row.created_at);
                    bucket.first_value = Some(value);
                }
                bucket.last_at = Some(row.created_at);
                bucket.last_value = Some(value);
                if bucket.min_value.is_none_or(|current| value < current) {
                    bucket.min_at = Some(row.created_at);
                    bucket.min_value = Some(value);
                }
                if bucket.max_value.is_none_or(|current| value > current) {
                    bucket.max_at = Some(row.created_at);
                    bucket.max_value = Some(value);
                }
            }
        } else {
            let signature = (row.value.clone(), row.quality.clone(), row.reason.clone());
            if previous_event.as_ref() != Some(&signature) {
                events.push(json!({
                    "createdAt": row.created_at,
                    "value": row.value,
                    "displayValue": row.display_value,
                    "quality": row.quality,
                    "reason": row.reason,
                }));
                previous_event = Some(signature);
            }
        }
        latest = Some(row);
    }

    let Some(latest) = latest else {
        return Ok(None);
    };
    let kind = match latest.data_type.as_str() {
        "boolean" => "boolean",
        "string" => "string",
        _ => "numeric",
    };
    let samples = if kind == "numeric" {
        Value::Array(
            numeric_buckets
                .into_values()
                .map(|bucket| {
                    json!({
                        "bucket": bucket.bucket,
                        "firstAt": bucket.first_at,
                        "firstValue": bucket.first_value,
                        "lastAt": bucket.last_at,
                        "lastValue": bucket.last_value,
                        "minAt": bucket.min_at,
                        "minValue": bucket.min_value,
                        "maxAt": bucket.max_at,
                        "maxValue": bucket.max_value,
                        "goodCount": bucket.good_count,
                        "abnormalCount": bucket.abnormal_count,
                        "worstQuality": bucket.worst_quality,
                        "marker": bucket.marker,
                    })
                })
                .collect(),
        )
    } else {
        Value::Array(compact_modbus_events(
            events,
            usize::try_from((query.bucket_count * 2) + 2).unwrap_or(4_002),
        ))
    };
    Ok(Some(json!({
        "requestGroupId": latest.request_group_id,
        "requestId": latest.request_id,
        "pointId": latest.point_id,
        "pointKey": latest.point_key,
        "pointName": latest.point_name,
        "dataType": latest.data_type,
        "unit": latest.unit,
        "kind": kind,
        "samples": samples,
        "summary": {
            "lastValue": latest.value,
            "lastDisplayValue": latest.display_value,
            "lastCreatedAt": latest.created_at,
            "minimum": minimum,
            "maximum": maximum,
            "changeCount": change_count,
            "abnormalCount": abnormal_count,
            "latestQuality": latest.quality,
        }
    })))
}

pub(super) fn compact_modbus_events(events: Vec<Value>, limit: usize) -> Vec<Value> {
    if events.len() <= limit {
        return events;
    }
    let mut result = Vec::with_capacity(limit);
    result.push(events[0].clone());
    let interior_count = limit - 2;
    for index in 1..=interior_count {
        result.push(events[(index * (events.len() - 1)) / (interior_count + 1)].clone());
    }
    result.push(events.last().unwrap().clone());
    result
}

pub(super) fn modbus_quality_rank(quality: &str) -> i64 {
    match quality {
        "disabled" => 1,
        "uncertain-overflow" => 2,
        "bad-value" => 3,
        "bad-communication" => 4,
        _ => 0,
    }
}

pub(super) fn csv_field(value: &str) -> String {
    if value.contains([',', '"', '\r', '\n']) {
        format!("\"{}\"", value.replace('"', "\"\""))
    } else {
        value.to_owned()
    }
}

pub(super) fn write_modbus_point_history_csv(
    database: &ConfigurationDatabase,
    destination: &Path,
    query: ModbusPointHistoryQuery,
) -> DbResult<i64> {
    let mut query = normalize_modbus_point_history_query(query, false)?;
    query.page = 1;
    query.page_size = 200;
    atomic_write_stream(destination, |file| {
        file.write_all(b"timestamp,endpointId,requestGroupId,requestId,pointId,pointKey,pointName,rawValue,engineeringValue,unit,quality,reason\r\n")
            .map_err(|error| error.to_string())?;
        let mut exported_count = 0_i64;
        loop {
            let page = database.query_modbus_point_history_rows(query.clone())?;
            for row in &page.rows {
                let raw = serde_json::to_string(&row.raw).map_err(|error| error.to_string())?;
                let value = serde_json::to_string(&row.value).map_err(|error| error.to_string())?;
                let fields = [
                    row.created_at.to_string(),
                    row.endpoint_id.clone(),
                    row.request_group_id.clone(),
                    row.request_id.clone(),
                    row.point_id.clone(),
                    row.point_key.clone(),
                    row.point_name.clone(),
                    raw,
                    value,
                    row.unit.clone().unwrap_or_default(),
                    row.quality.clone(),
                    row.reason.clone().unwrap_or_default(),
                ];
                let line = fields
                    .iter()
                    .map(|field| csv_field(field))
                    .collect::<Vec<_>>()
                    .join(",");
                file.write_all(line.as_bytes())
                    .and_then(|_| file.write_all(b"\r\n"))
                    .map_err(|error| error.to_string())?;
                exported_count += 1;
            }
            if query.page.saturating_mul(page.page_size) >= page.total || page.rows.is_empty() {
                break;
            }
            query.page += 1;
        }
        Ok(exported_count)
    })
}

impl ConfigurationDatabase {
    pub(crate) fn record_modbus_point_history(
        &self,
        rows: Vec<ModbusPointHistoryInput>,
    ) -> DbResult<ModbusPointHistoryRecordResult> {
        validate_modbus_point_history_batch(&rows)?;
        if rows.is_empty() {
            return Ok(ModbusPointHistoryRecordResult { recorded_count: 0 });
        }
        let mut connection = self.connection()?;
        let transaction = connection.transaction().map_err(db_error)?;
        for row in &rows {
            transaction
                .execute(
                    "INSERT INTO modbus_point_history
                     (endpoint_id, request_group_id, request_id, point_id, point_key, point_name,
                      data_type, unit, raw_json, value_json, numeric_value, display_value, quality,
                      reason, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15)",
                    params![
                        row.endpoint_id,
                        row.request_group_id,
                        row.request_id,
                        row.point_id,
                        row.point_key,
                        row.point_name,
                        row.data_type,
                        row.unit,
                        encode(&row.raw)?,
                        encode(&row.value)?,
                        row.numeric_value,
                        row.display_value,
                        row.quality,
                        row.reason,
                        row.created_at,
                    ],
                )
                .map_err(db_error)?;
        }
        transaction.commit().map_err(db_error)?;
        Ok(ModbusPointHistoryRecordResult {
            recorded_count: i64::try_from(rows.len()).map_err(|error| error.to_string())?,
        })
    }

    pub(crate) fn query_modbus_point_history_rows(
        &self,
        query: ModbusPointHistoryQuery,
    ) -> DbResult<ModbusPointHistoryPage> {
        let query = normalize_modbus_point_history_query(query, false)?;
        let (where_sql, values) = modbus_point_history_filters(&query);
        let connection = self.connection()?;
        let total = connection
            .query_row(
                &format!("SELECT COUNT(*) FROM modbus_point_history WHERE {where_sql}"),
                params_from_iter(values.iter()),
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let offset = query
            .page
            .checked_sub(1)
            .and_then(|page| page.checked_mul(query.page_size))
            .ok_or_else(|| "Modbus point history page offset is too large".to_owned())?;
        let mut page_values = values;
        page_values.push(SqlValue::Integer(query.page_size));
        page_values.push(SqlValue::Integer(offset));
        let mut statement = connection
            .prepare(&format!(
                "SELECT * FROM modbus_point_history WHERE {where_sql}
                 ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?"
            ))
            .map_err(db_error)?;
        let rows = statement
            .query_map(
                params_from_iter(page_values.iter()),
                modbus_point_history_from_row,
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

    pub(crate) fn query_modbus_point_series(
        &self,
        query: ModbusPointSeriesQuery,
    ) -> DbResult<ModbusPointSeriesResult> {
        let query = normalize_modbus_point_series_query(query)?;
        let connection = self.connection()?;
        let mut series = Vec::new();
        for point in &query.points {
            let mut statement = connection
                .prepare(
                    "SELECT * FROM modbus_point_history
                     WHERE endpoint_id = ?1 AND request_group_id = ?2 AND request_id = ?3
                       AND point_id = ?4 AND created_at >= ?5 AND created_at <= ?6
                     ORDER BY created_at, id",
                )
                .map_err(db_error)?;
            let rows = statement
                .query_map(
                    params![
                        query.endpoint_id,
                        point.request_group_id,
                        point.request_id,
                        point.point_id,
                        query.from,
                        query.to,
                    ],
                    modbus_point_history_from_row,
                )
                .map_err(db_error)?;
            if let Some(folded) = fold_modbus_point_series(rows, &query)? {
                series.push(folded);
            }
        }
        Ok(ModbusPointSeriesResult {
            series,
            from: query.from,
            to: query.to,
        })
    }

    pub(crate) fn clear_modbus_point_history(
        &self,
        query: ModbusPointHistoryQuery,
    ) -> DbResult<i64> {
        let query = normalize_modbus_point_history_query(query, false)?;
        let (where_sql, values) = modbus_point_history_filters(&query);
        let connection = self.connection()?;
        let changed = connection
            .execute(
                &format!("DELETE FROM modbus_point_history WHERE {where_sql}"),
                params_from_iter(values.iter()),
            )
            .map_err(db_error)?;
        i64::try_from(changed).map_err(|error| error.to_string())
    }

    pub(crate) fn cleanup_modbus_point_history(
        &self,
        retention: &str,
    ) -> DbResult<ModbusPointHistoryCleanupResult> {
        self.cleanup_modbus_point_history_at(retention, now_millis()?)
    }

    pub(super) fn cleanup_modbus_point_history_at(
        &self,
        retention: &str,
        completed_at: i64,
    ) -> DbResult<ModbusPointHistoryCleanupResult> {
        validate_timestamp(completed_at, "completedAt")?;
        let days = match retention {
            "7-days" => Some(7_i64),
            "30-days" => Some(30_i64),
            "90-days" => Some(90_i64),
            "forever" => None,
            _ => return Err("retention must be 7-days, 30-days, 90-days, or forever".into()),
        };
        let deleted_count = if let Some(days) = days {
            let cutoff = completed_at.saturating_sub(days * 86_400_000);
            let connection = self.connection()?;
            i64::try_from(
                connection
                    .execute(
                        "DELETE FROM modbus_point_history WHERE created_at < ?1",
                        [cutoff],
                    )
                    .map_err(db_error)?,
            )
            .map_err(|error| error.to_string())?
        } else {
            0
        };
        *self
            .modbus_point_history_last_cleanup_at
            .lock()
            .map_err(|_| "point history cleanup lock is unavailable".to_owned())? =
            Some(completed_at);
        Ok(ModbusPointHistoryCleanupResult {
            deleted_count,
            completed_at,
        })
    }
}
