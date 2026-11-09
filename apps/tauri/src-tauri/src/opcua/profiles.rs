use super::{text, validate_config};
use serde_json::{json, Value};
pub(super) fn sanitize_profiles(value: &Value) -> Result<Value, String> {
    let profiles = value
        .as_array()
        .filter(|v| v.len() <= 50)
        .ok_or("At most 50 profiles required")?;
    let mut ids = std::collections::HashSet::new();
    let mut clean = Vec::new();
    for p in profiles {
        let id = text(p, "id")?;
        let name = text(p, "name")?;
        if !ids.insert(id) {
            return Err("Duplicate profile id".into());
        }
        let config = &p["config"];
        validate_config(config)?;
        let mut safe = serde_json::Map::new();
        for key in [
            "endpointUrl",
            "securityPolicy",
            "securityMode",
            "authentication",
            "username",
        ] {
            if let Some(v) = config.get(key) {
                safe.insert(key.into(), v.clone());
            }
        }
        let favorites = p["favorites"]
            .as_array()
            .filter(|a| a.len() <= 100)
            .ok_or("At most 100 favorites required")?;
        let mut favs = Vec::new();
        for f in favorites {
            let node = text(f, "nodeId")?;
            super::node_id(node)?;
            favs.push(json!({"nodeId":node,"displayName":text(f,"displayName")?}));
        }
        clean.push(json!({"id":id,"name":name,"config":safe,"favorites":favs}));
    }
    let clean = json!(clean);
    if serde_json::to_vec_pretty(&clean)
        .map_err(|e| e.to_string())?
        .len()
        > 1024 * 1024
    {
        return Err("OPC UA profiles exceed the 1 MiB size limit".into());
    }
    Ok(clean)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn profiles_enforce_the_same_one_megabyte_bound_on_save_and_load() {
        let favorites = (0..100)
            .map(|_| json!({"nodeId":"i=85","displayName":"x".repeat(8192)}))
            .collect::<Vec<_>>();
        let first = json!({"id":"a","name":"A","config":{"endpointUrl":"opc.tcp://localhost:4840"},"favorites":favorites});
        let mut second = first.clone();
        second["id"] = json!("b");
        assert!(sanitize_profiles(&json!([first, second])).is_err());
    }
}
