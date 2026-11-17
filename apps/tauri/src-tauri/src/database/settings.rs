// Settings normalization and protocol document validation.
use super::*;

pub(super) fn normalize_settings(
    values: &BTreeMap<String, Value>,
) -> DbResult<BTreeMap<String, Value>> {
    let mut normalized = SETTINGS_SCHEMA
        .settings
        .iter()
        .map(|(key, rule)| (key.clone(), rule.default.clone()))
        .collect::<BTreeMap<_, _>>();
    for (key, value) in values {
        normalized.insert(key.clone(), normalize_setting(key, value)?);
    }
    Ok(normalized)
}

pub(super) fn drop_retired_import_settings(settings: &mut BTreeMap<String, Value>) {
    for key in RETIRED_IMPORT_SETTING_KEYS {
        settings.remove(key);
    }
}

pub(super) fn normalize_setting(key: &str, value: &Value) -> DbResult<Value> {
    let rule = SETTINGS_SCHEMA
        .settings
        .get(key)
        .ok_or_else(|| format!("unknown setting: {key}"))?;
    let normalized = match rule.kind.as_str() {
        "integer" => {
            let maximum = rule.maximum.unwrap_or(MAX_SAFE_TIMESTAMP);
            let number = safe_integral_json_number(value, key, maximum)?;
            if rule.minimum.is_some_and(|minimum| number < minimum) {
                return Err(format!("{key} is outside the allowed range"));
            }
            Value::from(number)
        }
        "boolean" if !value.is_boolean() => return Err(format!("{key} must be boolean")),
        "string" if !value.is_string() => return Err(format!("{key} must be a string")),
        "boolean" | "string" => value.clone(),
        "acceptance-document" => {
            validate_acceptance_document(value)?;
            value.clone()
        }
        "stomp-profiles" => {
            validate_stomp_profiles(value)?;
            value.clone()
        }
        kind => return Err(format!("unsupported settings schema type: {kind}")),
    };
    if !rule.choices.is_empty() && !rule.choices.contains(&normalized) {
        return Err(format!("{key} is invalid"));
    }
    Ok(normalized)
}

// Deliberately opaque JSON storage; full domain validation is shared by both renderers.
pub(super) fn validate_acceptance_document(value: &Value) -> DbResult<()> {
    let invalid = || "acceptanceWorkspace must be a bounded version 1 JSON document".to_string();
    let text = value
        .as_str()
        .filter(|s| s.len() <= 2 * 1024 * 1024)
        .ok_or_else(invalid)?;
    let doc: Value = serde_json::from_str(text).map_err(|_| invalid())?;
    let object = doc
        .as_object()
        .filter(|o| o.len() == if o.contains_key("templates") { 4 } else { 3 })
        .ok_or_else(invalid)?;
    if object
        .get("templates")
        .is_some_and(|rows| !rows.as_array().is_some_and(|a| a.len() <= 50))
        || object.get("version") != Some(&json!(1))
        || !object
            .get("plans")
            .and_then(Value::as_array)
            .is_some_and(|rows| rows.len() <= 50)
        || !object
            .get("reports")
            .and_then(Value::as_array)
            .is_some_and(|rows| rows.len() <= 20)
    {
        return Err(invalid());
    }
    Ok(())
}

// Apply the same strict profile boundary to settings IPC and workspace imports.
pub(super) fn validate_stomp_profiles(value: &Value) -> DbResult<()> {
    fn object<'a>(value: &'a Value, keys: &[&str]) -> DbResult<&'a serde_json::Map<String, Value>> {
        value
            .as_object()
            .filter(|o| o.len() == keys.len() && keys.iter().all(|k| o.contains_key(*k)))
            .ok_or_else(|| "stompProfiles contains invalid or unknown profile fields".into())
    }
    fn text(value: &Value, maximum: usize) -> bool {
        value.as_str().is_some_and(|s| {
            !s.is_empty() && s.encode_utf16().count() <= maximum && !s.contains(['\0', '\r', '\n'])
        })
    }
    fn integer(value: &Value, minimum: i64, maximum: i64) -> bool {
        safe_integral_json_number(value, "STOMP profile integer", maximum)
            .is_ok_and(|n| n >= minimum)
    }
    let invalid = || "stompProfiles must contain bounded safe STOMP profiles".to_string();
    let profiles = value
        .as_array()
        .filter(|a| a.len() <= 50)
        .ok_or_else(invalid)?;
    let mut ids = HashSet::new();
    for p in profiles {
        object(p, &["id", "name", "mode", "config", "subscriptions"])?;
        let id = p["id"]
            .as_str()
            .filter(|s| {
                !s.is_empty()
                    && s.len() <= 80
                    && s.bytes()
                        .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
            })
            .ok_or_else(invalid)?;
        if !ids.insert(id)
            || p["name"]
                .as_str()
                .is_none_or(|s| s.trim().is_empty() || s.encode_utf16().count() > 100)
            || !matches!(p["mode"].as_str(), Some("client" | "server"))
        {
            return Err(invalid());
        }
        let c = &p["config"];
        object(
            c,
            &[
                "url",
                "host",
                "autoReconnect",
                "heartbeatOutgoing",
                "heartbeatIncoming",
                "listenHost",
                "listenPort",
                "path",
            ],
        )?;
        if !text(&c["url"], 4096)
            || !text(&c["host"], 255)
            || !text(&c["listenHost"], 255)
            || !text(&c["path"], 1024)
            || c["path"]
                .as_str()
                .is_none_or(|s| !s.starts_with('/') || s.contains(['?', '#']))
            || !c["autoReconnect"].is_boolean()
            || !integer(&c["listenPort"], 1, 65535)
            || ["heartbeatOutgoing", "heartbeatIncoming"].iter().any(|k| {
                !integer(&c[*k], 0, 60000)
                    || safe_integral_json_number(&c[*k], "heartbeat", 60000)
                        .is_ok_and(|n| n > 0 && n < 1000)
            })
        {
            return Err(invalid());
        }
        let url_text = c["url"].as_str().unwrap();
        let url = url::Url::parse(url_text).map_err(|_| invalid())?;
        if !matches!(url.scheme(), "ws" | "wss")
            || url.host_str().is_none()
            || !url.username().is_empty()
            || url.password().is_some()
            || url_text.contains(['?', '#'])
        {
            return Err(invalid());
        }
        let subscriptions = p["subscriptions"]
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or_else(invalid)?;
        let mut seen = HashSet::new();
        for row in subscriptions {
            object(row, &["id", "destination", "ack"])?;
            if !text(&row["id"], 128)
                || !seen.insert(row["id"].as_str().unwrap())
                || !text(&row["destination"], 1024)
                || !matches!(
                    row["ack"].as_str(),
                    Some("auto" | "client" | "client-individual")
                )
            {
                return Err(invalid());
            }
        }
    }
    Ok(())
}

pub(super) fn safe_integral_json_number(value: &Value, name: &str, maximum: i64) -> DbResult<i64> {
    let number = value
        .as_number()
        .ok_or_else(|| format!("{name} must be an integer"))?;
    parse_integral_json_lexeme(&number.to_string(), name, maximum)
}

pub(super) fn parse_integral_json_lexeme(raw: &str, name: &str, maximum: i64) -> DbResult<i64> {
    let lexeme = raw.trim();
    if lexeme.starts_with('-') {
        return Err(format!("{name} must be a non-negative safe integer"));
    }
    let (mantissa, exponent_text) = lexeme
        .split_once(['e', 'E'])
        .map_or((lexeme, "0"), |parts| parts);
    let (whole, fraction) = mantissa
        .split_once('.')
        .map_or((mantissa, ""), |parts| parts);
    let digits = format!("{whole}{fraction}");
    if digits.bytes().all(|digit| digit == b'0') {
        return Ok(0);
    }
    let exponent = exponent_text
        .parse::<i64>()
        .map_err(|_| format!("{name} must be a non-negative safe integer"))?;
    let fraction_length = i64::try_from(fraction.len())
        .map_err(|_| format!("{name} must be a non-negative safe integer"))?;
    let scale = exponent
        .checked_sub(fraction_length)
        .ok_or_else(|| format!("{name} must be a non-negative safe integer"))?;
    let significant = digits.trim_start_matches('0');
    let integer_text = if scale >= 0 {
        let maximum_digits = maximum.to_string().len();
        let zero_count =
            usize::try_from(scale).map_err(|_| format!("{name} is outside the allowed range"))?;
        if significant.len().saturating_add(zero_count) > maximum_digits {
            return Err(format!("{name} is outside the allowed range"));
        }
        format!("{significant}{}", "0".repeat(zero_count))
    } else {
        let removed = usize::try_from(scale.unsigned_abs())
            .map_err(|_| format!("{name} must be an integer"))?;
        if removed > digits.len()
            || digits[digits.len() - removed..]
                .bytes()
                .any(|digit| digit != b'0')
        {
            return Err(format!("{name} must be an integer"));
        }
        digits[..digits.len() - removed]
            .trim_start_matches('0')
            .to_owned()
    };
    let integer = if integer_text.is_empty() {
        0
    } else {
        integer_text
            .parse::<i64>()
            .map_err(|_| format!("{name} is outside the allowed range"))?
    };
    if integer > maximum {
        return Err(format!("{name} is outside the allowed range"));
    }
    Ok(integer)
}
