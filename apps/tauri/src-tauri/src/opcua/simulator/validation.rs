use super::*;
use std::collections::HashSet;

// Core ns0 and each desktop runtime's application namespace already have owners.
// Keep the same reserved set in both runtimes so saved profiles are portable.
const RESERVED_NAMESPACES: &[&str] = &[
    "http://opcfoundation.org/UA/",
    "urn:ineedfull:linklab:simulator:server",
    "urn:ineedfull:linklab:opcua:simulator",
];

pub(super) fn identifier(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"_.-".contains(&c))
}
fn bounded_text<'a>(v: &'a Value, key: &str, max: usize) -> Result<&'a str, String> {
    let text = super::super::text(v, key)?;
    if text.trim().is_empty() || text.chars().count() > max || text.chars().any(char::is_control) {
        return Err(format!("Invalid {key}"));
    }
    Ok(text)
}
pub(super) fn config(source: &Value) -> Result<Value, String> {
    if !source.is_object() {
        return Err("Invalid server config".into());
    }
    let mut merged = json!({"listenHost":"127.0.0.1","listenPort":4840,"path":"/LinkLab","namespaceUri":"urn:ineedfull:linklab:simulator"});
    for key in ["listenHost", "listenPort", "path", "namespaceUri"] {
        if let Some(v) = source.get(key).filter(|v| !v.is_null()) {
            merged[key] = v.clone();
        }
    }
    let value = &merged;
    let host = super::super::text(value, "listenHost")?;
    if !matches!(host, "127.0.0.1" | "0.0.0.0") {
        return Err("listenHost must be 127.0.0.1 or 0.0.0.0".into());
    }
    let port = value["listenPort"]
        .as_u64()
        .filter(|p| (1..=65535).contains(p))
        .ok_or("listenPort must be an integer from 1 to 65535")?;
    let path = bounded_text(value, "path", 128)?;
    if !path.starts_with('/')
        || !path
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || b"/_-".contains(&c))
    {
        return Err("Invalid OPC UA server path".into());
    }
    let uri = bounded_text(value, "namespaceUri", 256)?;
    if RESERVED_NAMESPACES.contains(&uri) {
        return Err("Reserved namespaceUri is owned by OPC UA or the desktop runtime".into());
    }
    if uri.chars().any(char::is_whitespace) {
        return Err("Invalid namespaceUri".into());
    }
    let parsed = url::Url::parse(uri).map_err(|_| "Invalid namespaceUri")?;
    if !matches!(parsed.scheme(), "urn" | "http" | "https")
        || (parsed.scheme() == "urn" && parsed.path().is_empty())
    {
        return Err("namespaceUri must be a urn or HTTP(S) URI".into());
    }
    Ok(json!({"listenHost":host,"listenPort":port,"path":path,"namespaceUri":uri}))
}
pub(super) fn value(kind: &str, array: &str, value: &Value) -> Result<Variant, String> {
    if !matches!(
        kind,
        "Boolean"
            | "Int16"
            | "UInt16"
            | "Int32"
            | "UInt32"
            | "Int64"
            | "UInt64"
            | "Float"
            | "Double"
            | "String"
            | "ByteString"
            | "DateTime"
    ) {
        return Err("Unsupported server dataType".into());
    }
    if array == "Array" && value.as_array().is_none_or(|a| a.len() > 100) {
        return Err("Server arrays allow at most 100 elements".into());
    }
    let items = if array == "Array" {
        value.as_array().unwrap().iter().collect::<Vec<_>>()
    } else {
        vec![value]
    };
    for item in items {
        if item.as_str().is_some_and(|s| s.chars().count() > 4096) {
            return Err("Server string exceeds 4096 characters".into());
        }
    }
    parse_variant(kind, array, value)
}
pub(super) fn nodes(input: &Value) -> Result<Vec<Node>, String> {
    if serde_json::to_vec_pretty(input)
        .map_err(super::super::err)?
        .len()
        > 256 * 1024
    {
        return Err("Server nodes exceed 256 KiB".into());
    }
    let items = input
        .as_array()
        .filter(|a| !a.is_empty() && a.len() <= 100)
        .ok_or("Server requires 1 to 100 nodes")?;
    let mut ids = HashSet::new();
    let mut nodes = Vec::new();
    for v in items {
        let id = super::super::text(v, "id")?;
        if !identifier(id) || !ids.insert(id) {
            return Err("Invalid or duplicate server node id".into());
        }
        let name = bounded_text(v, "name", 100)?.trim();
        let kind = super::super::text(v, "dataType")?;
        let array = super::super::text(v, "arrayType")?;
        let initial = value(kind, array, &v["value"])?;
        let writable = v["writable"].as_bool().ok_or("writable must be boolean")?;
        let default_simulation = json!({});
        let sim = v.get("simulation").unwrap_or(&default_simulation);
        if !sim.is_object() {
            return Err("simulation must be an object".into());
        }
        let default_mode = json!("manual");
        let mode = sim
            .get("mode")
            .unwrap_or(&default_mode)
            .as_str()
            .ok_or("Invalid simulation mode")?;
        if !matches!(mode, "manual" | "increment" | "toggle") {
            return Err("Invalid simulation mode".into());
        }
        let interval = sim.get("intervalMs").cloned().unwrap_or(json!(1000));
        let interval = interval
            .as_u64()
            .filter(|i| (100..=60000).contains(i))
            .ok_or("intervalMs must be an integer from 100 to 60000")?;
        let min = sim.get("min").cloned().unwrap_or(json!(0));
        let max = sim.get("max").cloned().unwrap_or(json!(100));
        let step = sim.get("step").cloned().unwrap_or(json!(1));
        if mode != "increment"
            && [&min, &max, &step]
                .iter()
                .any(|value| !value.as_f64().is_some_and(f64::is_finite))
        {
            return Err("Simulation parameters must be finite numbers".into());
        }
        if mode != "manual" {
            if array != "Scalar" {
                return Err("Automatic simulation requires Scalar".into());
            }
            if mode == "toggle" && kind != "Boolean" {
                return Err("toggle requires Boolean".into());
            }
            if mode == "increment" {
                if !matches!(
                    kind,
                    "Int16" | "UInt16" | "Int32" | "UInt32" | "Float" | "Double"
                ) {
                    return Err("increment requires a supported numeric type".into());
                }
                for n in [&min, &max, &step] {
                    value(kind, "Scalar", n)?;
                }
                if min.as_f64().unwrap() > max.as_f64().unwrap() || step.as_f64().unwrap() <= 0.0 {
                    return Err("Simulation requires min <= max and step > 0".into());
                }
            }
        }
        let clean = json!({"id":id,"name":name,"dataType":kind,"arrayType":array,"value":v["value"],"writable":writable,"simulation":{"mode":mode,"intervalMs":interval,"min":min,"max":max,"step":step}});
        nodes.push(Node {
            spec: clean,
            initial,
        });
    }
    Ok(nodes)
}
pub(super) fn profiles(input: &Value) -> Result<Value, String> {
    if serde_json::to_vec(input).map_err(super::super::err)?.len() > 1024 * 1024 {
        return Err("Server profiles exceed 1 MiB".into());
    }
    let items = input
        .as_array()
        .filter(|a| a.len() <= 50)
        .ok_or("At most 50 server profiles required")?;
    let mut ids = HashSet::new();
    let mut out = Vec::new();
    for p in items {
        let id = super::super::text(p, "id")?;
        if !identifier(id) || id.contains('.') || !ids.insert(id) {
            return Err("Invalid or duplicate server profile id".into());
        }
        let name = bounded_text(p, "name", 100)?.trim();
        let config = config(&p["config"])?;
        let nodes = nodes(&p["nodes"])?;
        out.push(json!({"id":id,"name":name,"config":config,"nodes":nodes.into_iter().map(|n|n.spec).collect::<Vec<_>>()}));
    }
    let result = json!(out);
    if serde_json::to_vec_pretty(&result)
        .map_err(super::super::err)?
        .len()
        > 1024 * 1024
    {
        return Err("Server profiles exceed 1 MiB".into());
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn base() -> Value {
        json!({"id":"n","name":"Node","dataType":"Int32","arrayType":"Scalar","value":0,"writable":true})
    }
    #[test]
    fn missing_simulation_uses_manual_defaults() {
        let nodes = nodes(&json!([base()])).unwrap();
        assert_eq!(
            nodes[0].spec["simulation"],
            json!({"mode":"manual","intervalMs":1000,"min":0,"max":100,"step":1})
        );
    }
    #[test]
    fn malformed_simulation_objects_are_rejected() {
        for simulation in [
            json!(null),
            json!([]),
            json!("manual"),
            json!(0),
            json!(false),
        ] {
            let mut node = base();
            node["simulation"] = simulation;
            assert!(nodes(&json!([node.clone()])).is_err(), "accepted {node}");
        }
        let mut node = base();
        node["simulation"] = json!({});
        assert_eq!(
            nodes(&json!([node])).unwrap()[0].spec["simulation"]["mode"],
            "manual"
        );
    }
    #[test]
    fn manual_and_toggle_parameters_require_finite_numbers() {
        for mode in ["manual", "toggle"] {
            for key in ["min", "max", "step"] {
                for value in [
                    json!("bad"),
                    json!({}),
                    json!([]),
                    json!(null),
                    json!(false),
                ] {
                    let mut node = base();
                    node["dataType"] = json!("Boolean");
                    node["value"] = json!(true);
                    node["simulation"] = json!({"mode":mode});
                    node["simulation"][key] = value;
                    assert!(nodes(&json!([node.clone()])).is_err(), "accepted {node}");
                }
            }
            let mut node = base();
            node["dataType"] = json!("Boolean");
            node["value"] = json!(true);
            node["simulation"] = json!({"mode":mode,"min":-1.5,"max":9.5,"step":0});
            assert!(nodes(&json!([node])).is_ok());
        }
    }
    #[test]
    fn validation_rejects_malformed_shapes_and_oversized_values() {
        let mut n = base();
        n["simulation"] = json!({"mode":"manual"});
        let mut cases = Vec::new();
        for (key, value) in [
            ("id", json!("bad/id")),
            ("name", json!(" ")),
            ("dataType", json!("NodeId")),
            ("arrayType", json!("Matrix")),
            ("value", json!(2147483648u64)),
            ("writable", json!("true")),
        ] {
            let mut bad = n.clone();
            bad[key] = value;
            cases.push(bad);
        }
        for sim in [
            json!({"mode":"increment","intervalMs":99}),
            json!({"mode":"increment","intervalMs":60001}),
            json!({"mode":"increment","intervalMs":100.5}),
            json!({"mode":"increment","min":3,"max":2}),
            json!({"mode":"increment","step":0}),
            json!({"mode":"increment","step":0.5}),
            json!({"mode":"toggle"}),
            json!({"mode":"unknown"}),
        ] {
            let mut bad = n.clone();
            bad["simulation"] = sim;
            cases.push(bad);
        }
        for bad in cases {
            assert!(nodes(&json!([bad.clone()])).is_err(), "accepted {bad}");
        }
        assert!(nodes(&json!([])).is_err());
        assert!(nodes(&json!(vec![n.clone(); 101])).is_err());
        assert!(nodes(&json!([n.clone(), n.clone()])).is_err());
        for (kind, input) in [
            ("String", json!("x".repeat(4097))),
            ("ByteString", json!("*")),
            ("DateTime", json!("2026-10-22T00:00:00")),
            ("Int64", json!(42)),
            ("UInt64", json!("18446744073709551616")),
        ] {
            assert!(value(kind, "Scalar", &input).is_err());
        }
        assert!(value("Int32", "Array", &json!(vec![0; 101])).is_err());
        let mut large = n.clone();
        large["dataType"] = json!("String");
        large["arrayType"] = json!("Array");
        large["value"] = json!(vec!["x".repeat(4096); 100]);
        assert!(nodes(&json!([large])).is_err());
    }
    #[test]
    fn config_rejects_invalid_addresses_ports_paths_and_namespace_uris() {
        let base = json!({"listenHost":"127.0.0.1","listenPort":4840,"path":"/LinkLab","namespaceUri":"urn:ineedfull:linklab:simulator"});
        assert!(config(&base).is_ok());
        for (key, value) in [
            ("listenHost", json!("localhost")),
            ("listenPort", json!(0)),
            ("listenPort", json!(65536)),
            ("listenPort", json!(4840.5)),
            ("path", json!("no-slash")),
            ("path", json!("/space path")),
            ("path", json!("/".repeat(129))),
            ("namespaceUri", json!("file:///tmp")),
            ("namespaceUri", json!("urn:")),
            ("namespaceUri", json!("urn:test\n")),
            ("namespaceUri", json!("https://")),
        ] {
            let mut bad = base.clone();
            bad[key] = value;
            assert!(config(&bad).is_err(), "accepted {bad}");
        }
    }
    #[test]
    fn partial_config_defaults_and_uri_whitespace_are_handled_consistently() {
        let result = config(&json!({"listenPort":4841})).unwrap();
        assert_eq!(
            result,
            json!({"listenHost":"127.0.0.1","listenPort":4841,"path":"/LinkLab","namespaceUri":"urn:ineedfull:linklab:simulator"})
        );
        let mut bad = result;
        bad["namespaceUri"] = json!("urn:with space");
        assert!(config(&bad).is_err());
    }
    #[test]
    fn reserved_runtime_namespaces_are_rejected_and_custom_namespaces_remain_valid() {
        for uri in [
            "http://opcfoundation.org/UA/",
            "urn:ineedfull:linklab:simulator:server",
            "urn:ineedfull:linklab:opcua:simulator",
        ] {
            assert!(
                config(&json!({"namespaceUri":uri})).is_err(),
                "reserved namespace accepted: {uri}"
            );
        }
        for uri in ["urn:example:simulator", "https://example.test/UA/LinkLab"] {
            assert!(config(&json!({"namespaceUri":uri})).is_ok());
        }
    }
    #[test]
    fn profile_ids_exclude_dots_while_node_ids_allow_them() {
        let mut node = base();
        node["id"] = json!("sensor.temperature");
        let profile = json!({"id":"profile_a-1","name":"Profile","config":{},"nodes":[node]});
        assert!(profiles(&json!([profile.clone()])).is_ok());
        let mut dotted = profile;
        dotted["id"] = json!("profile.a");
        assert!(
            profiles(&json!([dotted])).is_err(),
            "profile ID must match the shared ASCII word/hyphen contract"
        );
    }
}
