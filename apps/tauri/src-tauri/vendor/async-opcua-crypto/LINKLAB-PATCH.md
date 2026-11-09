# LinkLab maintained patch

Source: crates.io async-opcua-crypto 0.19.0, https://github.com/freeopcua/async-opcua .
Upstream files retain their MPL-2.0 notices.

Only src/x509.rs::is_application_uri_valid is changed: match the advertised application URI against every URI entry in subjectAltName, regardless of ordering. DNS/IP/email entries cannot satisfy this check. Certificate trust, validity, hostname, signatures and key-length checks remain enabled.

Regression: native opcua::certificates::tests::certificate_uri_is_checked_in_all_uri_san_entries uses an OpenSSL-generated public regression certificate with DNS first and multiple URI SANs. It proves matching URI success, absent URI failure and DNS-as-URI failure. The localhost native integration fixture uses standard node-opcua certificate SAN ordering.

Remove the patch when the selected upstream release passes this regression.
