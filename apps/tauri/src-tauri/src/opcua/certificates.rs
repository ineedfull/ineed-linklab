use base64::{engine::general_purpose::STANDARD, Engine};
use opcua::crypto::{CertificateStore, X509Data, X509};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::BTreeMap, fs, path::Path};

pub(super) fn ensure_client_identity(pki: &Path) -> Result<(), String> {
    let store = CertificateStore::new(pki);
    store.ensure_pki_path()?;
    if store.read_own_cert().is_ok() && store.read_own_pkey().is_ok() {
        return Ok(());
    }
    // A client needs its application URI, not DNS discovery of this machine.
    // SDK sample generation resolves the machine hostname synchronously and can
    // block indefinitely on unavailable local DNS, even for loopback servers.
    let data = X509Data {
        key_size: 2048,
        common_name: "Ineed LinkLab OPC UA".into(),
        organization: "Ineed".into(),
        organizational_unit: "LinkLab".into(),
        country: "CN".into(),
        state: "".into(),
        alt_host_names: X509Data::alt_host_names(
            "urn:ineedfull:linklab:opcua",
            None,
            true,
            false,
            true,
        ),
        certificate_duration_days: 365,
    };
    store.create_and_store_application_instance_cert(&data, false)?;
    store.read_own_cert()?;
    store.read_own_pkey()?;
    Ok(())
}

pub(super) fn describe(der: &[u8], trusted: bool) -> Result<Value, String> {
    let cert = X509::from_der(der).map_err(|e| e.to_string())?;
    Ok(
        json!({"fingerprint":format!("{:x}",Sha256::digest(der)),"subject":cert.subject_name(),"validFrom":cert.not_before().map_err(|e|e.to_string())?.to_rfc3339(),"validTo":cert.not_after().map_err(|e|e.to_string())?.to_rfc3339(),"trusted":trusted,"derBase64":STANDARD.encode(der)}),
    )
}
pub(super) fn remember(pki: &Path, der: &[u8]) -> Result<Value, String> {
    let store = CertificateStore::new(pki);
    store.ensure_pki_path()?;
    let cert = X509::from_der(der).map_err(|e| e.to_string())?;
    let name = safe_name(&cert)?;
    let trusted = fs::read(store.trusted_certs_dir().join(&name)).is_ok_and(|stored| stored == der);
    if !trusted {
        store.store_rejected_cert(&cert)?;
    }
    describe(der, trusted)
}
pub(super) fn list(pki: &Path) -> Result<Vec<Value>, String> {
    let mut all = BTreeMap::new();
    for (dir, trusted) in [("rejected", false), ("trusted", true)] {
        let path = pki.join(dir);
        if !path.exists() {
            continue;
        }
        for e in fs::read_dir(path).map_err(|e| e.to_string())? {
            let e = e.map_err(|e| e.to_string())?;
            if !e.file_type().map_err(|e| e.to_string())?.is_file() {
                continue;
            }
            if let Ok(der) = fs::read(e.path()) {
                if let Ok(v) = describe(&der, trusted) {
                    all.insert(v["fingerprint"].as_str().unwrap().to_string(), v);
                }
            }
        }
    }
    Ok(all.into_values().collect())
}
pub(super) fn trust(pki: &Path, fingerprint: &str) -> Result<(), String> {
    if fingerprint.len() != 64 || !fingerprint.chars().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid SHA256 certificate fingerprint".into());
    }
    let found = list(pki)?
        .into_iter()
        .find(|v| v["fingerprint"].as_str() == Some(fingerprint))
        .ok_or("Certificate fingerprint is unknown")?;
    let der = STANDARD
        .decode(found["derBase64"].as_str().unwrap())
        .map_err(|e| e.to_string())?;
    if format!("{:x}", Sha256::digest(&der)) != fingerprint {
        return Err("Certificate fingerprint mismatch".into());
    }
    let cert = X509::from_der(&der).map_err(|e| e.to_string())?;
    let name = safe_name(&cert)?;
    let store = CertificateStore::new(pki);
    store.ensure_pki_path()?;
    fs::write(store.trusted_certs_dir().join(&name), &der).map_err(|e| e.to_string())?;
    let rejected = store.rejected_certs_dir().join(&name);
    if rejected.exists() {
        fs::remove_file(rejected).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn safe_name(cert: &X509) -> Result<String, String> {
    let name = CertificateStore::cert_file_name(cert);
    if name
        .chars()
        .any(|c| c == '/' || c == '\\' || c.is_control())
    {
        return Err("Unsafe certificate subject filename".into());
    }
    Ok(name)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn cold_client_identity_has_uri_and_loopback_names_and_preserves_existing_pair() {
        let dir = std::env::temp_dir().join(format!(
            "linklab-opcua-identity-{}-{}",
            std::process::id(),
            super::super::NEXT.fetch_add(1, std::sync::atomic::Ordering::SeqCst)
        ));
        let started = std::time::Instant::now();
        ensure_client_identity(&dir).unwrap();
        assert!(started.elapsed() < std::time::Duration::from_secs(5));
        let store = CertificateStore::new(&dir);
        let cert = store.read_own_cert().unwrap();
        assert!(cert
            .is_application_uri_valid("urn:ineedfull:linklab:opcua")
            .is_ok());
        assert!(cert.is_hostname_valid("localhost").is_ok());
        let cert_before = fs::read(store.own_certificate_path()).unwrap();
        let key_before = fs::read(store.own_private_key_path()).unwrap();
        ensure_client_identity(&dir).unwrap();
        assert_eq!(fs::read(store.own_certificate_path()).unwrap(), cert_before);
        assert_eq!(fs::read(store.own_private_key_path()).unwrap(), key_before);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn certificate_uri_is_checked_in_all_uri_san_entries() {
        // Public, self-signed regression certificate: DNS first, then two URI SANs.
        let cert = X509::from_der(include_bytes!("test-cert-uri-san.der")).unwrap();
        assert!(cert.is_application_uri_valid("urn:other").is_ok());
        assert!(cert.is_application_uri_valid("urn:missing").is_err());
        assert!(
            cert.is_application_uri_valid("localhost").is_err(),
            "DNS SAN must never satisfy application URI validation"
        );
    }
}
