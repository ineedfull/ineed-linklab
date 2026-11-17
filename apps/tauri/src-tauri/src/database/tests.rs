use std::{fs, process};

use serde_json::json;

use super::*;

#[test]
fn modbus_point_history_csv_escapes_delimiters_quotes_and_line_breaks() {
    assert_eq!(csv_field("plain"), "plain");
    assert_eq!(csv_field("a,b"), "\"a,b\"");
    assert_eq!(csv_field("a\"b"), "\"a\"\"b\"");
    assert_eq!(csv_field("a\r\nb"), "\"a\r\nb\"");
}

fn temporary_database(name: &str) -> (ConfigurationDatabase, PathBuf) {
    let directory = std::env::temp_dir().join(format!(
        "ineed-tauri-{name}-{}-{}",
        process::id(),
        now_millis().unwrap()
    ));
    fs::create_dir_all(&directory).unwrap();
    let database = ConfigurationDatabase::open_in(&directory).unwrap();
    (database, directory)
}

#[test]
fn workspace_files_are_bounded_regular_and_not_symlinks() {
    let directory = std::env::temp_dir().join(format!(
        "ineed-tauri-workspace-files-{}-{}",
        process::id(),
        now_millis().unwrap()
    ));
    fs::create_dir_all(&directory).unwrap();
    let valid = directory.join("valid.json");
    let large = directory.join("large.json");
    let linked = directory.join("linked.json");
    fs::write(&valid, r#"{"schemaVersion":1}"#).unwrap();
    fs::write(&large, vec![b'x'; MAX_WORKSPACE_BYTES + 1]).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&valid, &linked).unwrap();

    assert_eq!(
        read_workspace_source(&valid).unwrap(),
        r#"{"schemaVersion":1}"#
    );
    assert!(read_workspace_source(&large)
        .unwrap_err()
        .contains("10 MiB"));
    assert!(read_workspace_source(&directory)
        .unwrap_err()
        .contains("regular file"));
    #[cfg(unix)]
    assert!(read_workspace_source(&linked)
        .unwrap_err()
        .contains("symbolic link"));
    fs::remove_dir_all(directory).unwrap();
}

#[cfg(unix)]
#[test]
fn workspace_import_descriptor_survives_path_swap_and_detects_growth() {
    use std::io::Write as _;

    let directory = std::env::temp_dir().join(format!(
        "ineed-tauri-workspace-race-{}-{}",
        process::id(),
        now_millis().unwrap()
    ));
    fs::create_dir_all(&directory).unwrap();
    let selected = directory.join("selected.json");
    let moved = directory.join("moved.json");
    fs::write(&selected, r#"{"schemaVersion":1}"#).unwrap();
    let opened = open_workspace_import(&selected).unwrap();
    fs::rename(&selected, &moved).unwrap();
    std::os::unix::fs::symlink(&moved, &selected).unwrap();
    assert_eq!(
        read_open_workspace_source(opened).unwrap(),
        r#"{"schemaVersion":1}"#
    );

    fs::remove_file(&selected).unwrap();
    fs::write(&selected, b"{}").unwrap();
    let opened = open_workspace_import(&selected).unwrap();
    let mut writer = fs::OpenOptions::new().append(true).open(&selected).unwrap();
    writer.write_all(&vec![b'x'; MAX_WORKSPACE_BYTES]).unwrap();
    writer.sync_all().unwrap();
    assert!(read_open_workspace_source(opened)
        .unwrap_err()
        .contains("10 MiB"));
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn database_file_size_treats_only_not_found_as_zero() {
    let missing = std::env::temp_dir().join(format!("missing-{}", process::id()));
    assert_eq!(database_file_size(&missing).unwrap(), 0);
    assert!(database_file_size(Path::new("\0invalid")).is_err());
}

#[test]
fn workspace_export_atomically_replaces_destination_and_rejects_symlinks() {
    let directory = std::env::temp_dir().join(format!(
        "ineed-tauri-workspace-write-{}-{}",
        process::id(),
        now_millis().unwrap()
    ));
    fs::create_dir_all(&directory).unwrap();
    let destination = directory.join("workspace.json");
    fs::write(&destination, "old").unwrap();
    atomic_write_workspace(&destination, b"new\n").unwrap();
    assert_eq!(fs::read_to_string(&destination).unwrap(), "new\n");
    assert!(fs::read_dir(&directory).unwrap().all(|entry| !entry
        .unwrap()
        .file_name()
        .to_string_lossy()
        .ends_with(".tmp")));

    #[cfg(unix)]
    {
        fs::remove_file(&destination).unwrap();
        std::os::unix::fs::symlink(directory.join("other"), &destination).unwrap();
        assert!(atomic_write_workspace(&destination, b"unsafe")
            .unwrap_err()
            .contains("symbolic link"));
    }
    fs::remove_dir_all(directory).unwrap();
}

fn endpoint(id: &str, name: &str) -> EndpointInput {
    EndpointInput {
        id: id.into(),
        name: name.into(),
        transport: "tcp-client".into(),
        config: json!({ "host": "127.0.0.1", "port": 9000 }),
        created_at: None,
        updated_at: None,
    }
}

#[test]
fn udp_endpoint_receive_mode_is_always_datagram() {
    let (database, directory) = temporary_database("udp-receive-mode");
    database
        .insert_endpoint(EndpointInput {
            id: "udp-server-1".into(),
            name: "UDP Server".into(),
            transport: "udp-server".into(),
            config: json!({
                "bindHost": "127.0.0.1",
                "bindPort": 41000,
                "receiveFraming": { "mode": "delimiter", "delimiterBytes": [10] }
            }),
            created_at: None,
            updated_at: None,
        })
        .unwrap();

    assert_eq!(
        database.endpoint_receive_mode("udp-server-1").unwrap(),
        "datagram"
    );

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn reading_and_normalizing_a_version_two_modbus_master_leaves_its_sqlite_row_unchanged() {
    let (database, directory) = temporary_database("modbus-master-read-only-upgrade");
    let config = json!({
        "configVersion": 2,
        "marker": "preserved",
        "host": "192.168.1.20",
        "port": 502,
        "unitId": 1,
        "timeoutMs": 1000,
        "requestGroups": []
    });
    database
        .insert_endpoint(EndpointInput {
            id: "legacy-master".into(),
            name: "Legacy master".into(),
            transport: "modbus-tcp-master".into(),
            config: config.clone(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    let read_raw_row = || {
        let connection = database.connection().unwrap();
        connection
            .query_row(
                "SELECT config_json, updated_at FROM endpoint_profiles WHERE id = ?1",
                ["legacy-master"],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
            )
            .unwrap()
    };
    let before = read_raw_row();

    let loaded = database
        .list_endpoints()
        .unwrap()
        .into_iter()
        .find(|endpoint| endpoint.id == "legacy-master")
        .unwrap();
    assert_eq!(loaded.config, config);
    assert!(loaded.config.get("writeCommands").is_none());
    assert_eq!(read_raw_row(), before);

    // Native persistence stores opaque endpoint JSON; normalization belongs to the model layer.
    let mut normalized_for_save = loaded.config.clone();
    normalized_for_save
        .as_object_mut()
        .unwrap()
        .insert("configVersion".into(), json!(3));
    normalized_for_save
        .as_object_mut()
        .unwrap()
        .insert("writeCommands".into(), json!([]));
    assert_eq!(normalized_for_save["writeCommands"], json!([]));
    assert_eq!(read_raw_row(), before);

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn version_two_modbus_master_upgrades_without_changing_history_rows_or_bytes() {
    let (database, directory) = temporary_database("modbus-master-request-groups");
    let config = json!({
        "configVersion": 2,
        "marker": "preserved",
        "host": "192.168.1.20",
        "port": 502,
        "unitId": 1,
        "timeoutMs": 1000,
        "scheduler": { "autoStart": true, "minGapMs": 50 },
        "requestGroups": [{
            "id": "holding",
            "name": "Environment",
            "functionCode": 3,
            "startAddress": 100,
            "quantity": 10,
            "dataPoints": [{
                "id": "temperature",
                "key": "temperature",
                "name": "Temperature",
                "offset": 0,
                "dataType": "float32",
                "length": 2
            }]
        }]
    });
    database
        .insert_endpoint(EndpointInput {
            id: "modbus-master".into(),
            name: "Boiler master".into(),
            transport: "modbus-tcp-master".into(),
            config: config.clone(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    database
        .insert_frame_batch(&[frame_insert(
            "modbus-master",
            vec![0, 128, 255],
            1_720_000_000_123,
        )])
        .unwrap();
    database
        .insert_log_batch(&[log_insert(
            "modbus-master",
            Some(json!({ "requestGroupId": "holding" })),
            1_720_000_000_124,
        )])
        .unwrap();
    database
        .record_send_history(SendHistoryInput {
            endpoint_id: "modbus-master".into(),
            session_id: Some("session-1".into()),
            peer_id: None,
            target: json!({ "unitId": 1 }),
            format: "hex".into(),
            framing: "none".into(),
            payload_base64: "AID/".into(),
            created_at: 1_720_000_000_125,
        })
        .unwrap();
    database
        .insert_endpoint(endpoint("unchanged", "Unchanged endpoint"))
        .unwrap();
    let history_query = || HistoryQuery {
        endpoint_id: Some("modbus-master".into()),
        page: 1,
        page_size: 20,
        ..HistoryQuery::default()
    };
    let send_query = || SendHistoryQuery {
        endpoint_id: "modbus-master".into(),
        page: 1,
        page_size: 20,
    };
    let before_frames = database.query_frames(history_query()).unwrap();
    let before_logs = database.query_logs(history_query()).unwrap();
    let before_sends = database.query_send_history(send_query()).unwrap();
    let before_history = database.storage_stats().unwrap();
    let unchanged_before = database
        .list_endpoints()
        .unwrap()
        .into_iter()
        .find(|endpoint| endpoint.id == "unchanged")
        .unwrap();

    let updated = json!({
        "configVersion": 3,
        "marker": "preserved",
        "host": "192.168.1.20",
        "port": 502,
        "unitId": 1,
        "timeoutMs": 1000,
        "scheduler": { "autoStart": true, "minGapMs": 50 },
        "description": "updated without dropping nested configuration",
        "writeCommands": [
            {
                "id": "reset-alarm",
                "name": "Reset alarm",
                "description": "Clear the alarm latch",
                "enabled": false,
                "order": 0,
                "unitId": 1,
                "functionCode": 5,
                "address": 12,
                "values": [true]
            },
            {
                "id": "set-thresholds",
                "name": "Set thresholds",
                "description": "Apply limits",
                "enabled": true,
                "order": 1,
                "unitId": 1,
                "functionCode": 16,
                "address": 200,
                "values": [10, 20, 30]
            }
        ],
        "requestGroups": [{
            "id": "holding",
            "name": "Environment",
            "unitId": 1,
            "enabled": true,
            "order": 0,
            "requests": [{
                "id": "holding-request",
                "name": "Environment request",
                "enabled": false,
                "order": 0,
                "functionCode": 3,
                "startAddress": 100,
                "quantity": 10,
                "intervalMs": 1000,
                "dataPoints": [{
                    "id": "temperature",
                    "key": "temperature",
                    "name": "Temperature",
                    "enabled": false,
                    "offset": 0,
                    "dataType": "float32",
                    "length": 2,
                    "saveHistory": true
                }]
            }]
        }]
    });
    let saved = database
        .save_endpoint(EndpointInput {
            id: "modbus-master".into(),
            name: "Boiler master updated".into(),
            transport: "modbus-tcp-master".into(),
            config: updated.clone(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    assert_eq!(saved.config, updated);
    assert_eq!(saved.config["configVersion"], 3);
    assert_eq!(saved.config["marker"], "preserved");
    assert_eq!(saved.config["writeCommands"][0]["id"], "reset-alarm");
    assert_eq!(saved.config["writeCommands"][0]["enabled"], false);
    assert_eq!(
        saved.config["writeCommands"][1]["values"],
        json!([10, 20, 30])
    );
    assert_eq!(
        database.query_frames(history_query()).unwrap(),
        before_frames
    );
    assert_eq!(database.query_logs(history_query()).unwrap(), before_logs);
    assert_eq!(
        database.query_send_history(send_query()).unwrap(),
        before_sends
    );
    let after_history = database.storage_stats().unwrap();
    assert_eq!(after_history.frame_count, before_history.frame_count);
    assert_eq!(after_history.log_count, before_history.log_count);
    assert_eq!(
        after_history.send_history_count,
        before_history.send_history_count
    );
    assert_eq!(after_history.total_count, before_history.total_count);
    let unchanged_after = database
        .list_endpoints()
        .unwrap()
        .into_iter()
        .find(|endpoint| endpoint.id == "unchanged")
        .unwrap();
    assert_eq!(unchanged_after, unchanged_before);

    let exported = database.export_workspace().unwrap();
    assert_eq!(exported.version, 1);
    let (target, target_directory) = temporary_database("modbus-master-import");
    let imported = target.import_workspace(exported).unwrap();
    let restored = imported
        .endpoint_profiles
        .iter()
        .find(|endpoint| endpoint.id == "modbus-master")
        .unwrap();
    assert_eq!(restored.config, updated);
    assert_eq!(restored.config["writeCommands"][0]["order"], 0);
    assert_eq!(restored.config["writeCommands"][1]["id"], "set-thresholds");
    assert_eq!(
        restored.config["requestGroups"][0]["requests"][0]["enabled"],
        false
    );
    assert_eq!(
        restored.config["requestGroups"][0]["requests"][0]["dataPoints"][0]["saveHistory"],
        true
    );

    drop(target);
    drop(database);
    fs::remove_dir_all(target_directory).unwrap();
    fs::remove_dir_all(directory).unwrap();
}

fn frame_insert(endpoint_id: &str, payload: Vec<u8>, created_at: i64) -> FrameHistoryInsert {
    FrameHistoryInsert {
        endpoint_id: endpoint_id.into(),
        session_id: "session-1".into(),
        peer_id: Some("peer-1".into()),
        direction: "in".into(),
        format: "hex".into(),
        framing: "raw".into(),
        byte_count: payload.len() as i64,
        payload,
        created_at,
    }
}

fn log_insert(endpoint_id: &str, details: Option<Value>, created_at: i64) -> LogHistoryInsert {
    LogHistoryInsert {
        endpoint_id: endpoint_id.into(),
        session_id: Some("session-1".into()),
        peer_id: Some("peer-1".into()),
        level: "info".into(),
        source: "serial".into(),
        code: None,
        message: "串口已打开: /dev/ttyUSB0".into(),
        details,
        created_at,
    }
}

#[test]
fn history_batch_inserts_round_trip_blob_json_null_and_milliseconds() {
    let (database, directory) = temporary_database("history-batch-round-trip");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    let mut frame = frame_insert("one", vec![0, 128, 255], 1_720_000_000_123);
    let mut log = log_insert(
        "one",
        Some(json!({ "path": "/dev/ttyUSB0", "settings": [115200, true, null] })),
        1_720_000_000_124,
    );
    database.insert_frame_batch(&[frame.clone()]).unwrap();
    database
        .insert_log_batch(&[
            log.clone(),
            LogHistoryInsert {
                session_id: None,
                details: None,
                message: "closed".into(),
                created_at: 1_720_000_000_125,
                ..log.clone()
            },
        ])
        .unwrap();
    frame.payload.fill(7);
    log.details = Some(json!({ "path": "mutated" }));

    let connection = database.connection().unwrap();
    let stored_frame = connection
        .query_row(
            "SELECT typeof(payload), payload, byte_count, created_at FROM transfer_frames",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        stored_frame,
        ("blob".into(), vec![0, 128, 255], 3, 1_720_000_000_123)
    );
    let mut statement = connection
        .prepare("SELECT session_id, details_json, created_at FROM runtime_logs ORDER BY id")
        .unwrap();
    let stored_logs = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Option<String>>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        serde_json::from_str::<Value>(stored_logs[0].1.as_ref().unwrap()).unwrap(),
        json!({ "path": "/dev/ttyUSB0", "settings": [115200, true, null] })
    );
    assert_eq!(stored_logs[0].2, 1_720_000_000_124);
    assert_eq!(stored_logs[1], (None, None, 1_720_000_000_125));
    drop(statement);
    drop(connection);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn tcp_server_peer_history_preserves_peer_source_and_exact_timestamps() {
    let (database, directory) = temporary_database("history-tcp-peer");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    let peer_id = "peer-127-0-0-1-51000";
    let frame = FrameHistoryInsert {
        session_id: "tcp-server-session".into(),
        peer_id: Some(peer_id.into()),
        payload: vec![0x41],
        byte_count: 1,
        created_at: 1_720_000_000_111,
        ..frame_insert("one", vec![0x41], 1_720_000_000_111)
    };
    let log = LogHistoryInsert {
        session_id: Some("tcp-server-session".into()),
        peer_id: Some(peer_id.into()),
        source: "tcp".into(),
        message: "TCP peer connected".into(),
        details: Some(json!({ "remoteAddress": "127.0.0.1:51000" })),
        created_at: 1_720_000_000_111,
        ..log_insert("one", None, 1_720_000_000_111)
    };

    database.insert_frame_batch(&[frame]).unwrap();
    database.insert_log_batch(&[log]).unwrap();

    let frames = database
        .query_frames(HistoryQuery {
            endpoint_id: Some("one".into()),
            page: 1,
            page_size: 50,
            ..HistoryQuery::default()
        })
        .unwrap();
    let logs = database
        .query_logs(HistoryQuery {
            endpoint_id: Some("one".into()),
            source: "tcp".into(),
            page: 1,
            page_size: 50,
            ..HistoryQuery::default()
        })
        .unwrap();
    assert_eq!(frames.total, 1);
    assert_eq!(frames.rows.len(), 1);
    assert_eq!(logs.total, 1);
    assert_eq!(logs.rows.len(), 1);
    assert_eq!(frames.rows[0].peer_id.as_deref(), Some(peer_id));
    assert_eq!(frames.rows[0].session_id, "tcp-server-session");
    assert_eq!(frames.rows[0].payload_base64, "QQ==");
    assert_eq!(frames.rows[0].created_at, 1_720_000_000_111);
    assert_eq!(logs.rows[0].peer_id.as_deref(), Some(peer_id));
    assert_eq!(logs.rows[0].source, "tcp");
    assert_eq!(
        logs.rows[0].details,
        Some(json!({ "remoteAddress": "127.0.0.1:51000" }))
    );
    assert_eq!(logs.rows[0].created_at, 1_720_000_000_111);

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn empty_history_batches_are_no_ops() {
    let (database, directory) = temporary_database("history-empty-batch");
    database.insert_frame_batch(&[]).unwrap();
    database.insert_log_batch(&[]).unwrap();
    assert_eq!(database.storage_stats().unwrap().total_count, 0);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn send_templates_and_send_history_support_product_management() {
    let (database, directory) = temporary_database("send-management");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    database.insert_endpoint(endpoint("two", "Two")).unwrap();
    database
        .save_template(TemplateInput {
            id: "template-one".into(),
            endpoint_id: "one".into(),
            name: "Ping".into(),
            format: "text".into(),
            framing: "none".into(),
            target: Value::Null,
            payload_base64: "cGluZw==".into(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    assert!(database.delete_template("template-one").unwrap());
    assert!(database.list_templates("one").unwrap().is_empty());

    let first = database
        .record_send_history(SendHistoryInput {
            endpoint_id: "one".into(),
            session_id: Some("session-one".into()),
            peer_id: Some("peer-one".into()),
            target: json!({ "peerId": "peer-one" }),
            format: "hex".into(),
            framing: "none".into(),
            payload_base64: "AID/".into(),
            created_at: 1_720_000_000_111,
        })
        .unwrap();
    let second = database
        .record_send_history(SendHistoryInput {
            endpoint_id: "one".into(),
            session_id: Some("session-one".into()),
            peer_id: None,
            target: json!({ "broadcast": true }),
            format: "text".into(),
            framing: "line".into(),
            payload_base64: "cGluZw==".into(),
            created_at: 1_720_000_000_112,
        })
        .unwrap();
    database
        .record_send_history(SendHistoryInput {
            endpoint_id: "two".into(),
            session_id: None,
            peer_id: None,
            target: Value::Null,
            format: "text".into(),
            framing: "none".into(),
            payload_base64: "b3RoZXI=".into(),
            created_at: 1_720_000_000_113,
        })
        .unwrap();

    assert_eq!(first.byte_count, 3);
    assert_eq!(second.byte_count, 4);
    let page = database
        .query_send_history(SendHistoryQuery {
            endpoint_id: "one".into(),
            page: 1,
            page_size: 20,
        })
        .unwrap();
    assert_eq!(page.total, 2);
    assert_eq!(page.rows, vec![second.clone(), first.clone()]);
    assert!(database.delete_send_history(first.id).unwrap());
    assert_eq!(database.clear_send_history("one").unwrap(), 1);
    assert_eq!(
        database
            .query_send_history(SendHistoryQuery {
                endpoint_id: "two".into(),
                page: 1,
                page_size: 20,
            })
            .unwrap()
            .total,
        1
    );

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn runtime_history_rejects_seconds_before_any_batch_row_is_written() {
    let (database, directory) = temporary_database("history-milliseconds");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    let frame_error = database
        .insert_frame_batch(&[frame_insert("one", vec![1], 1_720_000_000)])
        .unwrap_err();
    let log_error = database
        .insert_log_batch(&[log_insert("one", None, 1_720_000_000)])
        .unwrap_err();
    assert!(frame_error.contains("epoch-millisecond"));
    assert!(log_error.contains("epoch-millisecond"));
    assert_eq!(database.storage_stats().unwrap().total_count, 0);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn runtime_history_millisecond_boundary_and_partial_batches_are_atomic() {
    let (database, directory) = temporary_database("history-milliseconds-boundary");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    database
        .insert_frame_batch(&[frame_insert("one", vec![1], 1_000_000_000_000)])
        .unwrap();
    database
        .insert_log_batch(&[log_insert("one", None, 1_000_000_000_000)])
        .unwrap();
    assert_eq!(database.storage_stats().unwrap().total_count, 2);
    database.clear_history().unwrap();

    let frame_error = database
        .insert_frame_batch(&[frame_insert("one", vec![1], 999_999_999_999)])
        .unwrap_err();
    let log_error = database
        .insert_log_batch(&[log_insert("one", None, 999_999_999_999)])
        .unwrap_err();
    assert!(frame_error.contains("epoch-millisecond"));
    assert!(log_error.contains("epoch-millisecond"));

    let frame_error = database
        .insert_frame_batch(&[
            frame_insert("one", vec![1], 1_000_000_000_000),
            frame_insert("one", vec![2], 999_999_999_999),
        ])
        .unwrap_err();
    let log_error = database
        .insert_log_batch(&[
            log_insert("one", None, 1_000_000_000_000),
            log_insert("one", None, 999_999_999_999),
        ])
        .unwrap_err();
    assert!(frame_error.contains("epoch-millisecond"));
    assert!(log_error.contains("epoch-millisecond"));
    assert_eq!(database.storage_stats().unwrap().total_count, 0);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn history_batches_prevalidate_all_rows_and_roll_back_foreign_key_failures() {
    let (database, directory) = temporary_database("history-batch-validation");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    let frame = frame_insert("one", vec![1], 1_720_000_000_123);
    let mut invalid_frame = frame_insert("one", vec![2], 1_720_000_000_124);
    invalid_frame.direction = "sideways".into();
    assert!(database
        .insert_frame_batch(&[frame.clone(), invalid_frame])
        .is_err());
    assert_eq!(database.storage_stats().unwrap().frame_count, 0);

    let log = log_insert(
        "one",
        Some(json!({ "path": "/dev/one" })),
        1_720_000_000_010,
    );
    let mut invalid_log = log.clone();
    invalid_log.details = Some(json!(true));
    assert!(database
        .insert_log_batch(&[log.clone(), invalid_log])
        .is_err());
    assert_eq!(database.storage_stats().unwrap().log_count, 0);

    assert!(database
        .insert_frame_batch(&[frame, frame_insert("missing", vec![2], 1_720_000_000_011)])
        .is_err());
    assert!(database
        .insert_log_batch(&[log, log_insert("missing", None, 1_720_000_000_011)])
        .is_err());
    let connection = database.connection().unwrap();
    assert_eq!(
        connection
            .query_row("PRAGMA foreign_keys", [], |row| row.get::<_, i64>(0))
            .unwrap(),
        1
    );
    drop(connection);
    assert_eq!(database.storage_stats().unwrap().total_count, 0);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn history_batch_sql_failures_roll_back_earlier_rows_in_the_transaction() {
    let (database, directory) = temporary_database("history-batch-transaction");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    {
        let connection = database.connection().unwrap();
        connection
            .execute_batch(
                "CREATE TRIGGER reject_second_frame
                     BEFORE INSERT ON transfer_frames WHEN NEW.byte_count = 2
                     BEGIN SELECT RAISE(ABORT, 'injected frame failure'); END;
                     CREATE TRIGGER reject_second_log
                     BEFORE INSERT ON runtime_logs WHEN NEW.message = 'reject'
                     BEGIN SELECT RAISE(ABORT, 'injected log failure'); END;",
            )
            .unwrap();
    }
    let frame_error = database
        .insert_frame_batch(&[
            frame_insert("one", vec![1], 1_720_000_000_010),
            frame_insert("one", vec![1, 2], 1_720_000_000_011),
        ])
        .unwrap_err();
    assert!(frame_error.contains("injected frame failure"));
    assert_eq!(database.storage_stats().unwrap().frame_count, 0);

    let mut rejected = log_insert("one", None, 1_720_000_000_011);
    rejected.message = "reject".into();
    let log_error = database
        .insert_log_batch(&[log_insert("one", None, 1_720_000_000_010), rejected])
        .unwrap_err();
    assert!(log_error.contains("injected log failure"));
    assert_eq!(database.storage_stats().unwrap().log_count, 0);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn stomp_profiles_roundtrip_sqlite_and_reject_secrets_atomically() {
    let (database, directory) = temporary_database("stomp-settings");
    let profiles: Value = serde_json::from_str(include_str!(
        "../../../../../packages/runtime-contract/tests/stompProfileFixture.json"
    ))
    .unwrap();
    database.save_setting("theme", json!("dark")).unwrap();
    assert_eq!(
        database.get_settings().unwrap().get("stompProfiles"),
        Some(&json!([]))
    );
    database
        .save_setting("stompProfiles", profiles.clone())
        .unwrap();
    let before = database.export_workspace().unwrap();
    let mut invalid = vec![
        Value::Null,
        json!({}),
        Value::Array(vec![profiles[0].clone(); 51]),
        json!([profiles[0], profiles[0]]),
    ];
    for subscriptions in [
        json!(vec![profiles[0]["subscriptions"][0].clone(); 101]),
        json!([
            profiles[0]["subscriptions"][0],
            profiles[0]["subscriptions"][0]
        ]),
    ] {
        let mut profile = profiles[0].clone();
        profile["subscriptions"] = subscriptions;
        invalid.push(json!([profile]));
    }
    let mut missing = profiles[0].clone();
    missing["config"] = json!({});
    invalid.push(json!([missing]));
    for (pointer, value) in [
        ("/login", json!("private-login")),
        ("/credentials", json!({"passcode":"private-password"})),
        (
            "/config/headers",
            json!([{"name":"Authorization","value":"private-header"}]),
        ),
        ("/config/passcode", json!("private-password")),
        ("/config/futureOption", json!(true)),
        (
            "/config/url",
            json!("ws://user:private-password@localhost/"),
        ),
        (
            "/config/url",
            json!("ws://localhost/?token=private-password"),
        ),
        ("/config/url", json!("ws://localhost/#private-password")),
        (
            "/config/url",
            json!(format!("ws://localhost/{}", "a".repeat(4096))),
        ),
        ("/config/heartbeatOutgoing", json!(999)),
        ("/config/listenPort", json!(0)),
        ("/config/autoReconnect", json!("true")),
        ("/subscriptions/0/headers", json!([])),
        ("/subscriptions/0/ack", json!("invalid")),
        ("/subscriptions/0/destination", json!("bad\0destination")),
    ] {
        let mut profile = profiles[0].clone();
        let (parent, key) = pointer.rsplit_once('/').unwrap();
        profile
            .pointer_mut(parent)
            .unwrap()
            .as_object_mut()
            .unwrap()
            .insert(key.into(), value);
        invalid.push(json!([profile]));
    }
    for value in invalid {
        assert!(database
            .save_setting("stompProfiles", value.clone())
            .is_err());
        assert!(database
            .save_settings(BTreeMap::from([
                ("theme".into(), json!("light")),
                ("stompProfiles".into(), value.clone())
            ]))
            .is_err());
        let mut imported = before.clone();
        imported.settings.insert("stompProfiles".into(), value);
        assert!(database.import_workspace(imported).is_err());
        assert_eq!(database.export_workspace().unwrap(), before);
    }
    drop(database);
    let database = ConfigurationDatabase::open_in(&directory).unwrap();
    assert_eq!(database.get_settings().unwrap()["stompProfiles"], profiles);
    assert_eq!(database.get_settings().unwrap()["theme"], json!("dark"));
    assert_eq!(
        database.export_workspace().unwrap().settings["stompProfiles"],
        profiles
    );
    {
        let connection = database.connection().unwrap();
        let encoded: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key='stompProfiles'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!encoded.contains("private-"));
        connection
            .execute(
                "UPDATE settings SET value=?1 WHERE key='stompProfiles'",
                [r#"[{"login":"private-legacy"}]"#],
            )
            .unwrap();
    }
    assert_eq!(database.get_settings().unwrap()["stompProfiles"], json!([]));
    assert_eq!(
        database.export_workspace().unwrap().settings["stompProfiles"],
        json!([])
    );
    database
        .save_settings(BTreeMap::from([("theme".into(), json!("dark"))]))
        .unwrap();
    {
        let connection = database.connection().unwrap();
        let encoded: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key='stompProfiles'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!encoded.contains("private-"));
        connection
            .execute("DELETE FROM settings WHERE key='stompProfiles'", [])
            .unwrap();
    }
    drop(database);
    let database = ConfigurationDatabase::open_in(&directory).unwrap();
    assert_eq!(database.get_settings().unwrap()["stompProfiles"], json!([]));
    assert_eq!(database.get_settings().unwrap()["theme"], json!("dark"));
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

fn valid_settings() -> BTreeMap<String, Value> {
    BTreeMap::from([
        ("logLevel".into(), json!("info")),
        ("realtimeFrameLimit".into(), json!(2000)),
        ("realtimeLogLimit".into(), json!(1000)),
        ("previewByteLimit".into(), json!(4096)),
        ("defaultFraming".into(), json!("none")),
        ("autoScroll".into(), json!(true)),
        ("theme".into(), json!("system")),
        ("largeFont".into(), json!(false)),
    ])
}

#[test]
fn history_queries_order_page_and_clear_preserves_configuration() {
    let (database, directory) = temporary_database("management");
    database.insert_endpoint(endpoint("one", "One")).unwrap();
    database.save_setting("theme", json!("dark")).unwrap();
    database
        .save_template(TemplateInput {
            id: "template-one".into(),
            endpoint_id: "one".into(),
            name: "Template".into(),
            format: "text".into(),
            framing: "none".into(),
            target: Value::Null,
            payload_base64: "dGVtcGxhdGU=".into(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    {
        let connection = database.connection().unwrap();
        connection.execute_batch(
                "INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'in', 'text', 'none', X'6669727374', 5, 1720000000001);
                 INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'out', 'text', 'none', X'7365636F6E64', 6, 1720000000002);
                 INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'in', 'text', 'none', X'7468697264', 5, 1720000000002);
                 INSERT INTO runtime_logs
                   (endpoint_id, level, source, message, created_at)
                 VALUES ('one', 'error', 'transport', 'socket closed', 1720000000002);
                 INSERT INTO send_history
                   (endpoint_id, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'text', 'none', X'73656E74', 4, 1720000000002);",
            ).unwrap();
    }

    let page = database
        .query_frames(HistoryQuery {
            endpoint_id: Some("one".into()),
            page: 1,
            page_size: 2,
            ..HistoryQuery::default()
        })
        .unwrap();
    assert_eq!(page.total, 3);
    assert_eq!(
        page.rows.iter().map(|row| row.id).collect::<Vec<_>>(),
        [3, 2]
    );
    assert_eq!(page.rows[0].created_at, 1_720_000_000_002);
    assert_eq!(
        database
            .query_frames(HistoryQuery {
                endpoint_id: Some(" one ".into()),
                search: " third ".into(),
                page: 1,
                page_size: 50,
                ..HistoryQuery::default()
            })
            .unwrap()
            .total,
        1
    );
    assert!(database
        .query_logs(HistoryQuery {
            page: 1_000_001,
            page_size: 200,
            ..HistoryQuery::default()
        })
        .is_err());

    let before = database.storage_stats().unwrap();
    assert_eq!(
        (
            before.frame_count,
            before.log_count,
            before.send_history_count,
            before.total_count
        ),
        (3, 1, 1, 5)
    );
    assert!(before.disk_bytes > 0);
    let cleared = database.clear_history().unwrap();
    assert!(cleared.cleared);
    assert!(cleared.reclaimed);
    assert_eq!(cleared.total_count, 5);
    assert_eq!(database.storage_stats().unwrap().total_count, 0);
    assert_eq!(database.list_endpoints().unwrap().len(), 1);
    assert_eq!(database.list_templates("one").unwrap().len(), 1);
    assert_eq!(
        database.get_settings().unwrap().get("theme"),
        Some(&json!("dark"))
    );

    {
        let connection = database.connection().unwrap();
        connection.execute_batch(
                "INSERT INTO transfer_frames
                   (endpoint_id, session_id, direction, format, framing, payload, byte_count, created_at)
                 VALUES ('one', 'session', 'in', 'text', 'none', X'61', 1, 1720000000003);",
            ).unwrap();
    }
    let reader = Connection::open(&database.filename).unwrap();
    reader.execute_batch("BEGIN").unwrap();
    reader
        .query_row("SELECT COUNT(*) FROM transfer_frames", [], |row| {
            row.get::<_, i64>(0)
        })
        .unwrap();
    let partial = database.clear_history().unwrap();
    assert!(partial.cleared);
    assert!(!partial.reclaimed);
    assert!(partial
        .maintenance_error
        .unwrap()
        .message
        .contains("checkpoint"));
    reader.execute_batch("ROLLBACK").unwrap();

    {
        let connection = database.connection().unwrap();
        connection
            .execute_batch(
                "INSERT INTO runtime_logs (endpoint_id, level, source, message, created_at)
                 VALUES ('one', 'info', 'test', 'vacuum', 1720000000004);",
            )
            .unwrap();
    }
    let partial = database
        .clear_history_with_vacuum(|_| Err("injected VACUUM failure".into()))
        .unwrap();
    assert!(partial.cleared);
    assert!(!partial.reclaimed);
    assert!(partial
        .maintenance_error
        .unwrap()
        .message
        .contains("VACUUM failure"));

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn database_crud_settings_templates_and_cascade_use_real_sqlite() {
    let (database, directory) = temporary_database("crud");
    assert!(directory.join(DATABASE_FILENAME).is_file());
    assert_eq!(
        database.applied_migrations().unwrap(),
        vec![
            (1, "001-initial".into()),
            (2, "002-modbus-endpoints".into()),
            (3, "003-modbus-point-history".into()),
            (4, "004-dlt645-endpoints".into()),
            (5, "005-dlt645-simulator-endpoints".into()),
            (6, "006-websocket-endpoints".into()),
        ]
    );

    let inserted = database.insert_endpoint(endpoint("one", "One")).unwrap();
    let updated = database
        .update_endpoint(endpoint("one", "Updated"))
        .unwrap();
    assert_eq!(updated.created_at, inserted.created_at);
    assert_eq!(updated.name, "Updated");
    database
        .clone_endpoint("one", "two".into(), Some("Clone".into()))
        .unwrap();
    database.save_setting("previewByteLimit", json!(3)).unwrap();
    assert_eq!(
        database.get_settings().unwrap().get("previewByteLimit"),
        Some(&json!(3))
    );
    assert_eq!(
        database
            .save_settings(BTreeMap::from([
                ("theme".into(), json!("dark")),
                ("largeFont".into(), json!(true)),
            ]))
            .unwrap()
            .get("theme"),
        Some(&json!("dark"))
    );
    assert!(database
        .save_settings(BTreeMap::from([
            ("theme".into(), json!("light")),
            (String::new(), json!("invalid")),
        ]))
        .is_err());
    assert_eq!(
        database.get_settings().unwrap().get("theme"),
        Some(&json!("dark"))
    );

    let saved_template = database
        .save_template(TemplateInput {
            id: "template-one".into(),
            endpoint_id: "one".into(),
            name: "Ping".into(),
            format: "hex".into(),
            framing: "none".into(),
            target: json!({ "peerId": "peer-1" }),
            payload_base64: "AaI=".into(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    std::thread::sleep(std::time::Duration::from_millis(2));
    let updated_template = database
        .save_template(TemplateInput {
            id: "template-one".into(),
            endpoint_id: "one".into(),
            name: "Updated Ping".into(),
            format: "hex".into(),
            framing: "none".into(),
            target: Value::Null,
            payload_base64: "AA==".into(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    assert_eq!(updated_template.created_at, saved_template.created_at);
    assert_eq!(database.list_templates("one").unwrap().len(), 1);
    assert!(database.delete_endpoint("one").unwrap());
    assert!(database.list_templates("one").unwrap().is_empty());
    assert_eq!(database.list_endpoints().unwrap()[0].id, "two");

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn acceptance_document_native_boundary_and_corruption_are_explicit() {
    let (database, directory) = temporary_database("acceptance-document");
    let empty = r#"{"version":1,"plans":[],"reports":[]}"#;
    assert_eq!(
        database.get_settings().unwrap()["acceptanceWorkspace"],
        json!(empty)
    );
    database
        .save_setting("acceptanceWorkspace", json!(empty))
        .unwrap();
    let library =
        json!({"version":1,"plans":[],"reports":[],"templates":[{"id":"model","version":1}]})
            .to_string();
    database
        .save_setting("acceptanceWorkspace", json!(library))
        .unwrap();
    let exported = database.export_workspace().unwrap();
    database
        .save_setting("acceptanceWorkspace", json!(empty))
        .unwrap();
    database.import_workspace(exported).unwrap();
    assert_eq!(
        database.get_settings().unwrap()["acceptanceWorkspace"],
        json!(library)
    );
    for invalid in [
        json!(json!({"version":1,"plans":[],"reports":[],"templates":null}).to_string()),
        json!(
            json!({"version":1,"plans":[],"reports":[],"templates":vec![json!({});51]}).to_string()
        ),
        json!({"version":1,"plans":[],"reports":[]}),
        json!("invalid"),
        json!(r#"{"version":2,"plans":[],"reports":[]}"#),
        json!(r#"{"version":1,"plans":[],"reports":[],"extra":true}"#),
        json!(json!({"version":1,"plans":vec![json!({});51],"reports":[]}).to_string()),
        json!(json!({"version":1,"plans":[],"reports":vec![json!({});21]}).to_string()),
        json!(json!({"version":1,"plans":["x".repeat(2_097_152)],"reports":[]}).to_string()),
    ] {
        assert!(database
            .save_setting("acceptanceWorkspace", invalid.clone())
            .is_err());
        assert!(database
            .save_settings(BTreeMap::from([(
                "acceptanceWorkspace".into(),
                invalid.clone()
            )]))
            .is_err());
        let mut workspace = database.export_workspace().unwrap();
        workspace
            .settings
            .insert("acceptanceWorkspace".into(), invalid);
        assert!(database.import_workspace(workspace).is_err());
    }
    for encoded in [
        "{bad".to_string(),
        json!("invalid").to_string(),
        json!({"version":1,"plans":[],"reports":[]}).to_string(),
    ] {
        let connection = database.connection().unwrap();
        connection
            .execute(
                "INSERT OR REPLACE INTO settings(key,value,updated_at) VALUES(?1,?2,?3)",
                params!["acceptanceWorkspace", encoded, 1],
            )
            .unwrap();
        drop(connection);
        assert!(database
            .get_settings()
            .unwrap_err()
            .contains("acceptanceWorkspace"));
        assert!(database.export_workspace().is_err());
    }
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn native_settings_schema_rejects_invalid_values_and_recovers_unknown_rows() {
    let (database, directory) = temporary_database("settings-schema");
    database.save_settings(valid_settings()).unwrap();
    let before = database.export_workspace().unwrap();
    for invalid in [
        BTreeMap::from([("futureSetting".into(), json!(true))]),
        BTreeMap::from([("autoScroll".into(), json!("yes"))]),
        BTreeMap::from([("realtimeFrameLimit".into(), json!(0))]),
        BTreeMap::from([("previewByteLimit".into(), json!(16_777_217))]),
    ] {
        let mut settings = valid_settings();
        settings.extend(invalid);
        assert!(database.save_settings(settings.clone()).is_err());
        assert_eq!(database.export_workspace().unwrap(), before);
        let mut workspace = before.clone();
        workspace.settings = settings;
        assert!(database.import_workspace(workspace).is_err());
        assert_eq!(database.export_workspace().unwrap(), before);
    }

    let mut legacy_workspace = before.clone();
    legacy_workspace.settings = BTreeMap::from([
        ("theme".into(), json!("dark")),
        ("timeDisplayMode".into(), json!("iso")),
    ]);
    let imported = database.import_workspace(legacy_workspace).unwrap();
    assert_eq!(imported.settings.get("theme"), Some(&json!("dark")));
    assert!(!imported.settings.contains_key("timeDisplayMode"));
    assert!(!database
        .export_workspace()
        .unwrap()
        .settings
        .contains_key("timeDisplayMode"));

    {
        let connection = database.connection().unwrap();
        connection
            .execute(
                "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)",
                params!["futureSetting", "true", now_millis().unwrap()],
            )
            .unwrap();
        connection
                .execute(
                    "INSERT OR REPLACE INTO settings (key, value, updated_at) VALUES ('timeDisplayMode', '\"iso\"', 1720000000123)",
                    [],
                )
                .unwrap();
    }
    assert!(!database
        .get_settings()
        .unwrap()
        .contains_key("futureSetting"));
    assert!(!database
        .get_settings()
        .unwrap()
        .contains_key("timeDisplayMode"));
    database.save_settings(valid_settings()).unwrap();
    let connection = database.connection().unwrap();
    assert_eq!(row_count(&connection, "settings").unwrap(), 11);
    drop(connection);
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn integral_json_lexical_forms_match_settings_and_timestamp_contract() {
    let fixture: Value = serde_json::from_str(INTEGRAL_NUMBER_FIXTURE_JSON).unwrap();
    for case in fixture["accepted"].as_array().unwrap() {
        let lexeme = case["lexeme"].as_str().unwrap();
        let expected = case["value"].as_i64().unwrap();
        let settings: BTreeMap<String, Value> =
            serde_json::from_str(&format!(r#"{{"realtimeFrameLimit":{lexeme}}}"#)).unwrap();
        if (1..=50_000).contains(&expected) {
            assert_eq!(
                normalize_settings(&settings).unwrap()["realtimeFrameLimit"],
                json!(expected)
            );
        } else {
            assert!(normalize_settings(&settings).is_err());
        }
        let workspace: Workspace = serde_json::from_str(&raw_number_workspace("2000", lexeme))
            .expect("integral workspace numbers must deserialize");
        assert_eq!(workspace.endpoint_profiles[0].created_at, expected);
        let endpoint: EndpointInput = serde_json::from_str(&format!(
            r#"{{"id":"raw","name":"Raw","transport":"serial","config":{{}},"createdAt":{lexeme}}}"#
        ))
        .expect("integral optional timestamps must deserialize");
        assert_eq!(endpoint.created_at, Some(expected));
    }
    for case in fixture["rejected"].as_array().unwrap() {
        let lexeme = case["lexeme"].as_str().unwrap();
        let settings: BTreeMap<String, Value> =
            serde_json::from_str(&format!(r#"{{"realtimeFrameLimit":{lexeme}}}"#)).unwrap();
        assert!(normalize_settings(&settings).is_err());
        assert!(serde_json::from_str::<Workspace>(&raw_number_workspace(lexeme, "2000")).is_err());
        assert!(serde_json::from_str::<Workspace>(&raw_number_workspace("2000", lexeme)).is_err());
        assert!(serde_json::from_str::<EndpointInput>(&format!(
            r#"{{"id":"raw","name":"Raw","transport":"serial","config":{{}},"createdAt":{lexeme}}}"#
        ))
        .is_err());
    }
}

fn raw_number_workspace(setting_lexeme: &str, timestamp_lexeme: &str) -> String {
    format!(
        r#"{{"version":1,"endpointProfiles":[{{"id":"raw-number","name":"Raw","transport":"serial","config":{{}},"createdAt":{timestamp_lexeme},"updatedAt":{timestamp_lexeme}}}],"settings":{{"realtimeFrameLimit":{setting_lexeme}}},"sendTemplates":[]}}"#
    )
}

#[test]
fn normal_saves_accept_listed_rows_and_validate_optional_timestamps() {
    let (database, directory) = temporary_database("normal-save-timestamps");
    let endpoint_without_timestamps = first_argument::<EndpointInput>(
        Some(vec![json!({
            "id": "one",
            "name": "One",
            "transport": "tcp-client",
            "config": {}
        })]),
        "endpoint.save",
    )
    .unwrap();
    let inserted = database.save_endpoint(endpoint_without_timestamps).unwrap();
    let template_without_timestamps = first_argument::<TemplateInput>(
        Some(vec![json!({
            "id": "template-one",
            "endpointId": "one",
            "name": "Template",
            "format": "hex",
            "framing": "none",
            "target": null,
            "payloadBase64": "AA=="
        })]),
        "template.save",
    )
    .unwrap();
    let saved_template = database.save_template(template_without_timestamps).unwrap();

    let mut listed_endpoint = serde_json::to_value(&database.list_endpoints().unwrap()[0]).unwrap();
    listed_endpoint["name"] = json!("Round-trip endpoint");
    let endpoint_input =
        first_argument::<EndpointInput>(Some(vec![listed_endpoint]), "endpoint.save").unwrap();
    let endpoint_round_trip = database.save_endpoint(endpoint_input).unwrap();
    assert_eq!(endpoint_round_trip.name, "Round-trip endpoint");
    assert_eq!(endpoint_round_trip.created_at, inserted.created_at);

    let mut listed_template =
        serde_json::to_value(&database.list_templates("one").unwrap()[0]).unwrap();
    listed_template["name"] = json!("Round-trip template");
    let template_input =
        first_argument::<TemplateInput>(Some(vec![listed_template]), "template.save").unwrap();
    let template_round_trip = database.save_template(template_input).unwrap();
    assert_eq!(template_round_trip.name, "Round-trip template");
    assert_eq!(template_round_trip.created_at, saved_template.created_at);

    let endpoint_input = first_argument::<EndpointInput>(
        Some(vec![json!({
            "id": "one",
            "name": "Valid timestamps",
            "transport": "tcp-client",
            "config": {},
            "createdAt": 0,
            "updatedAt": MAX_SAFE_TIMESTAMP
        })]),
        "endpoint.save",
    )
    .unwrap();
    let endpoint_with_timestamps = database.save_endpoint(endpoint_input).unwrap();
    assert_eq!(endpoint_with_timestamps.created_at, inserted.created_at);
    assert_ne!(endpoint_with_timestamps.updated_at, MAX_SAFE_TIMESTAMP);

    let template_input = first_argument::<TemplateInput>(
        Some(vec![json!({
            "id": "template-one",
            "endpointId": "one",
            "name": "Valid timestamps",
            "format": "hex",
            "framing": "none",
            "target": null,
            "payloadBase64": "AA==",
            "createdAt": 0,
            "updatedAt": MAX_SAFE_TIMESTAMP
        })]),
        "template.save",
    )
    .unwrap();
    let template_with_timestamps = database.save_template(template_input).unwrap();
    assert_eq!(
        template_with_timestamps.created_at,
        saved_template.created_at
    );
    assert_ne!(template_with_timestamps.updated_at, MAX_SAFE_TIMESTAMP);

    // serde_json preserves JSON -0 as a float, so the i64 timestamp deserializer rejects it.
    let negative_zero: Value = serde_json::from_str("-0").unwrap();
    assert!(negative_zero.as_f64().unwrap().is_sign_negative());
    assert!(serde_json::from_str::<EndpointInput>(
            r#"{"id":"negative-zero","name":"Invalid","transport":"tcp-client","config":{},"createdAt":-0}"#
        )
        .is_err());
    assert!(serde_json::from_str::<TemplateInput>(
            r#"{"id":"negative-zero","endpointId":"one","name":"Invalid","format":"hex","framing":"none","target":null,"payloadBase64":"AA==","updatedAt":-0}"#
        )
        .is_err());

    let before_invalid = database.export_workspace().unwrap();
    for invalid in [
        json!(null),
        json!(-1),
        json!(9_007_199_254_740_992_i64),
        json!(1.5),
    ] {
        for field in ["createdAt", "updatedAt"] {
            let mut endpoint_value = json!({
                "id": "one",
                "name": "Invalid",
                "transport": "tcp-client",
                "config": {}
            });
            endpoint_value[field] = invalid.clone();
            assert!(
                first_argument::<EndpointInput>(Some(vec![endpoint_value]), "endpoint.save")
                    .is_err()
            );

            let mut template_value = json!({
                "id": "template-one",
                "endpointId": "one",
                "name": "Invalid",
                "format": "hex",
                "framing": "none",
                "target": null,
                "payloadBase64": "AA=="
            });
            template_value[field] = invalid.clone();
            assert!(
                first_argument::<TemplateInput>(Some(vec![template_value]), "template.save")
                    .is_err()
            );
            assert_eq!(database.export_workspace().unwrap(), before_invalid);
        }
    }

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn websocket_migration_preserves_old_rows_children_and_rejects_secrets() {
    let connection = Connection::open_in_memory().unwrap();
    connection.execute_batch("PRAGMA foreign_keys=ON").unwrap();
    for migration in &MIGRATIONS[..5] {
        connection.execute_batch(migration.sql).unwrap();
    }
    connection.execute_batch("INSERT INTO endpoint_profiles VALUES ('old','Old','tcp-client','{}',1,2);
          INSERT INTO transfer_frames(endpoint_id,session_id,direction,format,framing,payload,byte_count,created_at) VALUES('old','session','in','hex','raw',X'00FF',2,1);
          INSERT INTO runtime_logs(endpoint_id,level,source,message,created_at) VALUES('old','info','tcp','retained',1);
          INSERT INTO send_templates VALUES('template','old','Retained','hex','raw',NULL,X'00FF',1,1);
          INSERT INTO send_history(endpoint_id,format,framing,payload,byte_count,created_at) VALUES('old','hex','raw',X'00FF',2,1);").unwrap();
    connection
        .execute_batch(WEBSOCKET_ENDPOINTS_MIGRATION)
        .unwrap();
    for table in [
        "endpoint_profiles",
        "transfer_frames",
        "runtime_logs",
        "send_templates",
        "send_history",
    ] {
        let count: i64 = connection
            .query_row(&format!("SELECT count(*) FROM {table}"), [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1, "{table}");
    }
    assert!(connection
        .query_row("PRAGMA foreign_key_check", [], |_| Ok(()))
        .optional()
        .unwrap()
        .is_none());
    let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
    for key in ["headers", "websocketHeaders"] {
        let mut input = endpoint("secret", "Secret");
        input.transport = "websocket-client".into();
        input.config = json!({"url":"ws://127.0.0.1:9001"});
        input.config[key] = json!([{"name":"Authorization","value":"Bearer secret"}]);
        assert!(database.save_endpoint(input).is_err());
    }
}

#[test]
fn websocket_endpoints_are_accepted_without_persisted_headers() {
    let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
    let mut input = endpoint("ws", "WebSocket");
    input.transport = "websocket-client".into();
    input.config = json!({"url":"ws://127.0.0.1:9001"});
    assert!(database.save_endpoint(input).is_ok());
}

#[test]
fn invalid_workspace_does_not_close_active_transports() {
    struct Coordinator(Mutex<Vec<&'static str>>);
    impl TransportCoordinator for Coordinator {
        fn close_endpoint(&self, _: &str) -> DbResult<()> {
            Ok(())
        }
        fn close_all_endpoints(&self) -> DbResult<()> {
            self.0.lock().unwrap().push("close");
            Ok(())
        }
        fn flush_persistence(&self) -> DbResult<()> {
            self.0.lock().unwrap().push("flush");
            Ok(())
        }
    }
    let (database, directory) = temporary_database("invalid-import-connection");
    database
        .insert_endpoint(endpoint("stable", "Stable"))
        .unwrap();
    let before = database.export_workspace().unwrap();
    let coordinator = Coordinator(Mutex::new(Vec::new()));
    for case in ["endpoint", "transport", "settings", "payload", "reference"] {
        let mut invalid = before.clone();
        match case {
            "endpoint" => invalid.endpoint_profiles[0].name = "".into(),
            "transport" => invalid.endpoint_profiles[0].transport = "unsupported".into(),
            "settings" => {
                invalid.settings.insert("theme".into(), json!("invalid"));
            }
            _ => invalid.send_templates.push(SendTemplate {
                id: "template".into(),
                endpoint_id: if case == "reference" {
                    "missing"
                } else {
                    "stable"
                }
                .into(),
                name: "Invalid".into(),
                format: "hex".into(),
                framing: "none".into(),
                target: Value::Null,
                payload_base64: if case == "payload" {
                    "invalid base64"
                } else {
                    "AA=="
                }
                .into(),
                created_at: 100,
                updated_at: 100,
            }),
        }
        assert!(import_workspace_with_transports(&database, &coordinator, invalid).is_err());
        assert!(
            coordinator.0.lock().unwrap().is_empty(),
            "validation must precede close: {case}"
        );
        assert_eq!(database.export_workspace().unwrap(), before);
    }
    let mut valid = before.clone();
    valid.settings.insert("theme".into(), json!("dark"));
    import_workspace_with_transports(&database, &coordinator, valid).unwrap();
    assert_eq!(*coordinator.0.lock().unwrap(), vec!["close", "flush"]);
    assert_eq!(database.get_settings().unwrap()["theme"], json!("dark"));
    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_import_preserves_ids_and_rolls_back_on_failure() {
    let (database, directory) = temporary_database("import");
    database
        .insert_endpoint(endpoint("stable", "Before"))
        .unwrap();
    database.save_setting("theme", json!("light")).unwrap();
    let before = database.export_workspace().unwrap();

    let mut invalid = before.clone();
    invalid.endpoint_profiles[0].name = "Changed".into();
    invalid.settings.insert("theme".into(), json!("dark"));
    invalid.send_templates.push(SendTemplate {
        id: "invalid".into(),
        endpoint_id: "missing".into(),
        name: "Invalid".into(),
        format: "hex".into(),
        framing: "none".into(),
        target: Value::Null,
        payload_base64: "AA==".into(),
        created_at: now_millis().unwrap(),
        updated_at: now_millis().unwrap(),
    });

    assert!(database.import_workspace(invalid).is_err());
    assert_eq!(database.export_workspace().unwrap(), before);

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn workspace_import_rejects_unsafe_timestamps_without_mutation() {
    let (database, directory) = temporary_database("timestamps");
    database
        .insert_endpoint(endpoint("stable", "Before"))
        .unwrap();
    database
        .save_template(TemplateInput {
            id: "template-stable".into(),
            endpoint_id: "stable".into(),
            name: "Ping".into(),
            format: "hex".into(),
            framing: "none".into(),
            target: Value::Null,
            payload_base64: "AA==".into(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    database.save_setting("theme", json!("light")).unwrap();
    let before = database.export_workspace().unwrap();

    for invalid_timestamp in [-1_i64, 9_007_199_254_740_992_i64] {
        for field in [
            "endpointCreatedAt",
            "endpointUpdatedAt",
            "templateCreatedAt",
            "templateUpdatedAt",
        ] {
            let mut value = serde_json::to_value(&before).unwrap();
            value["settings"]["theme"] = json!("dark");
            match field {
                "endpointCreatedAt" => {
                    value["endpointProfiles"][0]["createdAt"] = json!(invalid_timestamp)
                }
                "endpointUpdatedAt" => {
                    value["endpointProfiles"][0]["updatedAt"] = json!(invalid_timestamp)
                }
                "templateCreatedAt" => {
                    value["sendTemplates"][0]["createdAt"] = json!(invalid_timestamp)
                }
                "templateUpdatedAt" => {
                    value["sendTemplates"][0]["updatedAt"] = json!(invalid_timestamp)
                }
                _ => unreachable!(),
            }
            assert!(serde_json::from_value::<Workspace>(value).is_err());
            assert_eq!(database.export_workspace().unwrap(), before);
        }
    }

    for (collection, field) in [
        ("endpointProfiles", "createdAt"),
        ("endpointProfiles", "updatedAt"),
        ("sendTemplates", "createdAt"),
        ("sendTemplates", "updatedAt"),
    ] {
        let mut value = serde_json::to_value(&before).unwrap();
        value["settings"]["theme"] = json!("dark");
        value[collection][0].as_object_mut().unwrap().remove(field);
        assert!(first_argument::<Workspace>(Some(vec![value]), "workspace.import").is_err());
        assert_eq!(database.export_workspace().unwrap(), before);
    }

    let mut boundary_workspace = before.clone();
    boundary_workspace.endpoint_profiles[0].created_at = 0;
    boundary_workspace.endpoint_profiles[0].updated_at = MAX_SAFE_TIMESTAMP;
    boundary_workspace.send_templates[0].created_at = 0;
    boundary_workspace.send_templates[0].updated_at = MAX_SAFE_TIMESTAMP;
    assert_eq!(
        database
            .import_workspace(boundary_workspace.clone())
            .unwrap(),
        boundary_workspace
    );

    let exported = serde_json::to_value(&before).unwrap();
    assert_eq!(
        exported.as_object().unwrap().keys().collect::<Vec<_>>(),
        ["endpointProfiles", "sendTemplates", "settings", "version"]
    );
    let endpoint_keys = exported["endpointProfiles"][0].as_object().unwrap();
    for key in [
        "id",
        "name",
        "transport",
        "config",
        "createdAt",
        "updatedAt",
    ] {
        assert!(endpoint_keys.contains_key(key));
    }
    assert_eq!(endpoint_keys.len(), 6);
    let template_keys = exported["sendTemplates"][0].as_object().unwrap();
    for key in [
        "id",
        "endpointId",
        "name",
        "format",
        "framing",
        "target",
        "payloadBase64",
        "createdAt",
        "updatedAt",
    ] {
        assert!(template_keys.contains_key(key));
    }
    assert_eq!(template_keys.len(), 9);

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn public_persistence_inputs_reject_unknown_fields_without_mutation() {
    let (database, directory) = temporary_database("exact-inputs");
    database
        .insert_endpoint(endpoint("source", "Source"))
        .unwrap();
    database
        .save_template(TemplateInput {
            id: "template".into(),
            endpoint_id: "source".into(),
            name: "Template".into(),
            format: "hex".into(),
            framing: "none".into(),
            target: Value::Null,
            payload_base64: "AA==".into(),
            created_at: None,
            updated_at: None,
        })
        .unwrap();
    let before = database.export_workspace().unwrap();

    assert!(first_argument::<EndpointInput>(
        Some(vec![json!({
            "id": "unexpected-endpoint",
            "name": "Unexpected",
            "transport": "tcp-client",
            "config": {},
            "unexpected": true
        })]),
        "endpoint.save"
    )
    .is_err());
    assert!(first_argument::<TemplateInput>(
        Some(vec![json!({
            "id": "unexpected-template",
            "endpointId": "source",
            "name": "Unexpected",
            "format": "hex",
            "framing": "none",
            "target": null,
            "payloadBase64": "AA==",
            "unexpected": true
        })]),
        "template.save"
    )
    .is_err());

    for location in ["workspace", "endpoint", "template"] {
        let mut value = serde_json::to_value(&before).unwrap();
        match location {
            "workspace" => value["unexpected"] = json!(true),
            "endpoint" => value["endpointProfiles"][0]["unexpected"] = json!(true),
            "template" => value["sendTemplates"][0]["unexpected"] = json!(true),
            _ => unreachable!(),
        }
        assert!(first_argument::<Workspace>(Some(vec![value]), "workspace.import").is_err());
        assert_eq!(database.export_workspace().unwrap(), before);
    }

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn clone_contract_and_template_target_shape_match_shared_behavior() {
    let (database, directory) = temporary_database("clone-target");
    let source = database
        .insert_endpoint(endpoint("source", "Source"))
        .unwrap();
    let cloned = database
        .clone_endpoint("source", "clone".into(), None)
        .unwrap();
    assert_eq!(cloned.name, source.name);
    assert_eq!(cloned.transport, source.transport);
    assert_eq!(cloned.config, source.config);
    assert_ne!(cloned.created_at, 0);
    assert!(serde_json::from_value::<CloneEndpointInput>(json!({
        "id": "bad",
        "transport": "udp-client"
    }))
    .is_err());
    assert!(serde_json::from_value::<CloneEndpointInput>(json!({ "name": "Missing ID" })).is_err());
    assert_eq!(
        serde_json::from_value::<CloneEndpointInput>(json!({ "id": "omitted-name" }))
            .unwrap()
            .name,
        None
    );
    assert!(serde_json::from_value::<CloneEndpointInput>(json!({
        "id": "null-name",
        "name": null
    }))
    .is_err());
    assert!(database
        .insert_endpoint(EndpointInput {
            id: "invalid-config".into(),
            name: "Invalid".into(),
            transport: "tcp-client".into(),
            config: json!([]),
            created_at: None,
            updated_at: None,
        })
        .is_err());

    for target in [json!([]), json!("peer"), json!(4), json!(true)] {
        assert!(database
            .save_template(TemplateInput {
                id: format!("template-{target}"),
                endpoint_id: "source".into(),
                name: "Invalid".into(),
                format: "hex".into(),
                framing: "none".into(),
                target,
                payload_base64: "AA==".into(),
                created_at: None,
                updated_at: None,
            })
            .is_err());
    }

    let before = database.export_workspace().unwrap();
    let mut invalid_import = before.clone();
    invalid_import
        .settings
        .insert("theme".into(), json!("mutated"));
    invalid_import.send_templates.push(SendTemplate {
        id: "invalid-import-target".into(),
        endpoint_id: "source".into(),
        name: "Invalid".into(),
        format: "hex".into(),
        framing: "none".into(),
        target: json!([]),
        payload_base64: "AA==".into(),
        created_at: now_millis().unwrap(),
        updated_at: now_millis().unwrap(),
    });
    assert!(database.import_workspace(invalid_import).is_err());
    assert_eq!(database.export_workspace().unwrap(), before);

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn concurrent_endpoint_saves_are_atomic_and_preserve_creation_time() {
    use std::sync::{Arc, Barrier};

    let (database, directory) = temporary_database("concurrent-save");
    let database = Arc::new(database);
    let barrier = Arc::new(Barrier::new(16));
    let mut threads = Vec::new();
    for index in 0..16 {
        let database = database.clone();
        let barrier = barrier.clone();
        threads.push(std::thread::spawn(move || {
            barrier.wait();
            database.save_endpoint(endpoint("shared", &format!("Endpoint {index}")))
        }));
    }
    let rows = threads
        .into_iter()
        .map(|thread| thread.join().unwrap())
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(database.list_endpoints().unwrap().len(), 1);
    let created_at = database.list_endpoints().unwrap()[0].created_at;
    assert!(rows.iter().all(|row| row.created_at == created_at));

    drop(database);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn migration_runner_rejects_malformed_ledgers_and_reopens_applied_schema() {
    for (name, rows) in [
        ("empty", vec![]),
        ("wrong-name", vec![(1_i64, "wrong-name")]),
        ("unknown-ahead", vec![(4_i64, "004-unknown")]),
        (
            "incomplete-schema",
            vec![(1_i64, "001-initial"), (2_i64, "002-modbus-endpoints")],
        ),
    ] {
        let directory = std::env::temp_dir().join(format!(
            "ineed-tauri-ledger-{name}-{}-{}",
            process::id(),
            now_millis().unwrap()
        ));
        fs::create_dir_all(&directory).unwrap();
        let filename = directory.join(DATABASE_FILENAME);
        let connection = Connection::open(&filename).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE schema_migrations (
                       version INTEGER PRIMARY KEY,
                       name TEXT NOT NULL,
                       applied_at INTEGER NOT NULL
                     )",
            )
            .unwrap();
        for (version, migration_name) in rows {
            connection
                .execute(
                    "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?1, ?2, 1)",
                    params![version, migration_name],
                )
                .unwrap();
        }
        drop(connection);
        let error = match ConfigurationDatabase::open_in(&directory) {
            Ok(_) => panic!("malformed migration ledger was accepted"),
            Err(error) => error,
        };
        assert!(error.contains("migration ledger") || error.contains("migration schema"));
        fs::remove_dir_all(directory).unwrap();
    }

    let (database, directory) = temporary_database("migration-reopen");
    drop(database);
    let reopened = ConfigurationDatabase::open_in(&directory).unwrap();
    assert_eq!(
        reopened.applied_migrations().unwrap(),
        vec![
            (1, "001-initial".into()),
            (2, "002-modbus-endpoints".into()),
            (3, "003-modbus-point-history".into()),
            (4, "004-dlt645-endpoints".into()),
            (5, "005-dlt645-simulator-endpoints".into()),
            (6, "006-websocket-endpoints".into()),
        ]
    );
    drop(reopened);
    fs::remove_dir_all(directory).unwrap();
}

#[test]
fn modbus_point_history_round_trips_lossless_rows_and_rolls_back_batches() {
    let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
    database
        .insert_serial_endpoint_for_test("master-1")
        .unwrap();
    let first = modbus_history_input("environment", "holding", "temperature", 100);
    let mut exact_u64 = modbus_history_input("environment", "holding", "temperature", 200);
    exact_u64.data_type = "uint64".into();
    exact_u64.value = json!("18446744073709551615");
    exact_u64.numeric_value = None;
    exact_u64.display_value = "18446744073709551615".into();
    let mut other_group = modbus_history_input("other", "holding", "temperature", 300);
    other_group.value = json!(99);
    other_group.numeric_value = Some(99.0);

    assert_eq!(
        database
            .record_modbus_point_history(vec![first, exact_u64, other_group])
            .unwrap(),
        ModbusPointHistoryRecordResult { recorded_count: 3 }
    );
    let page = database
        .query_modbus_point_history_rows(ModbusPointHistoryQuery {
            endpoint_id: "master-1".into(),
            points: vec![point_identity("environment", "holding", "temperature")],
            from: 0,
            to: MAX_SAFE_TIMESTAMP,
            page: 1,
            page_size: 50,
        })
        .unwrap();
    assert_eq!(
        serde_json::to_value(page).unwrap(),
        json!({
            "rows": [
                {
                    "id": 2, "endpointId": "master-1", "requestGroupId": "environment",
                    "requestId": "holding", "pointId": "temperature",
                    "pointKey": "temperature", "pointName": "Temperature",
                    "dataType": "uint64", "unit": "C", "raw": [16844, 0],
                    "value": "18446744073709551615", "numericValue": null,
                    "displayValue": "18446744073709551615", "quality": "good",
                    "reason": null, "createdAt": 200
                },
                {
                    "id": 1, "endpointId": "master-1", "requestGroupId": "environment",
                    "requestId": "holding", "pointId": "temperature",
                    "pointKey": "temperature", "pointName": "Temperature",
                    "dataType": "float32", "unit": "C", "raw": [16844, 0],
                    "value": 25.5, "numericValue": 25.5, "displayValue": "25.5",
                    "quality": "good", "reason": null, "createdAt": 100
                }
            ],
            "total": 2, "page": 1, "pageSize": 50
        })
    );

    let valid = modbus_history_input("environment", "holding", "rolled-back", 400);
    let mut invalid = modbus_history_input("environment", "holding", "missing", 500);
    invalid.endpoint_id = "missing-endpoint".into();
    assert!(database
        .record_modbus_point_history(vec![valid, invalid])
        .unwrap_err()
        .to_ascii_lowercase()
        .contains("foreign key"));
    assert_eq!(
        database
            .query_modbus_point_history_rows(all_modbus_history_query("master-1"))
            .unwrap()
            .total,
        3
    );
}

#[test]
fn modbus_point_history_matches_shared_cross_runtime_acceptance_fixture() {
    let fixture: Value = serde_json::from_str(MODBUS_POINT_HISTORY_CASES_JSON).unwrap();
    let endpoint_id = fixture["endpointId"].as_str().unwrap();
    let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
    database
        .insert_serial_endpoint_for_test(endpoint_id)
        .unwrap();
    let rows: Vec<ModbusPointHistoryInput> =
        serde_json::from_value(fixture["validRows"].clone()).unwrap();
    assert_eq!(
        database.record_modbus_point_history(rows).unwrap(),
        ModbusPointHistoryRecordResult {
            recorded_count: fixture["validRows"].as_array().unwrap().len() as i64,
        }
    );

    let points: Vec<ModbusPointIdentity> =
        serde_json::from_value(fixture["pointIdentities"].clone()).unwrap();
    let page = database
        .query_modbus_point_history_rows(ModbusPointHistoryQuery {
            endpoint_id: endpoint_id.into(),
            points: points.clone(),
            from: fixture["range"]["from"].as_i64().unwrap(),
            to: fixture["range"]["to"].as_i64().unwrap(),
            page: 1,
            page_size: 4,
        })
        .unwrap();
    assert_eq!(
        page.rows
            .iter()
            .map(|row| row.display_value.as_str())
            .collect::<Vec<_>>(),
        fixture["expected"]["firstPageDisplayValues"]
            .as_array()
            .unwrap()
            .iter()
            .map(|value| value.as_str().unwrap())
            .collect::<Vec<_>>()
    );

    let series = serde_json::to_value(
        database
            .query_modbus_point_series(ModbusPointSeriesQuery {
                endpoint_id: endpoint_id.into(),
                points,
                from: fixture["range"]["from"].as_i64().unwrap(),
                to: fixture["range"]["to"].as_i64().unwrap(),
                bucket_count: fixture["range"]["bucketCount"].as_i64().unwrap(),
            })
            .unwrap(),
    )
    .unwrap();
    let series_values = series["series"].as_array().unwrap();
    let by_point = |point_id: &str| {
        series_values
            .iter()
            .find(|value| value["pointId"] == point_id)
            .unwrap()
    };
    assert_eq!(
        by_point("numeric")["samples"][0],
        fixture["expected"]["numericSample"]
    );
    assert_eq!(
        by_point("switch")["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sample| json!({
                "createdAt": sample["createdAt"],
                "value": sample["value"],
            }))
            .collect::<Vec<_>>(),
        fixture["expected"]["booleanChanges"]
            .as_array()
            .unwrap()
            .clone()
    );
    assert_eq!(
        by_point("label")["samples"]
            .as_array()
            .unwrap()
            .iter()
            .map(|sample| json!({
                "createdAt": sample["createdAt"],
                "value": sample["value"],
            }))
            .collect::<Vec<_>>(),
        fixture["expected"]["stringChanges"]
            .as_array()
            .unwrap()
            .clone()
    );

    for case in fixture["invalidRows"].as_array().unwrap() {
        let Ok(invalid) = serde_json::from_value::<ModbusPointHistoryInput>(case["row"].clone())
        else {
            continue;
        };
        let mut rollback: ModbusPointHistoryInput =
            serde_json::from_value(fixture["validRows"][0].clone()).unwrap();
        rollback.point_id = format!("rollback-{}", invalid.point_id);
        rollback.created_at = 1060;
        assert!(database
            .record_modbus_point_history(vec![rollback, invalid])
            .is_err());
    }
    assert_eq!(
        database
            .query_modbus_point_history_rows(all_modbus_history_query(endpoint_id))
            .unwrap()
            .total,
        fixture["validRows"].as_array().unwrap().len() as i64
    );

    let csv_row: ModbusPointHistoryInput =
        serde_json::from_value(fixture["csv"]["row"].clone()).unwrap();
    database.record_modbus_point_history(vec![csv_row]).unwrap();
    let stored = database
        .query_modbus_point_history_rows(ModbusPointHistoryQuery {
            endpoint_id: endpoint_id.into(),
            points: vec![point_identity("environment", "holding", "csv")],
            from: 0,
            to: MAX_SAFE_TIMESTAMP,
            page: 1,
            page_size: 50,
        })
        .unwrap();
    assert_eq!(
        stored.rows[0].point_name,
        fixture["csv"]["row"]["pointName"]
    );
    assert_eq!(
        stored.rows[0].display_value,
        fixture["csv"]["row"]["displayValue"]
    );
    assert_eq!(stored.rows[0].reason, Some("quoted \"reason\"".into()));

    for retention in fixture["retention"]["values"].as_array().unwrap() {
        assert!(database
            .cleanup_modbus_point_history_at(
                retention.as_str().unwrap(),
                fixture["retention"]["referenceTime"].as_i64().unwrap(),
            )
            .is_ok());
    }
}

#[test]
fn modbus_point_series_preserves_extrema_and_change_events() {
    let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
    database
        .insert_serial_endpoint_for_test("master-1")
        .unwrap();
    let mut rows = Vec::new();
    for (point_id, data_type, created_at, value, numeric, quality, reason) in [
        (
            "numeric",
            "float32",
            100,
            json!(10),
            Some(10.0),
            "good",
            None,
        ),
        (
            "numeric",
            "float32",
            110,
            json!(30),
            Some(30.0),
            "good",
            None,
        ),
        (
            "numeric",
            "float32",
            120,
            Value::Null,
            None,
            "bad-communication",
            Some("timeout"),
        ),
        (
            "numeric",
            "float32",
            130,
            json!(20),
            Some(20.0),
            "good",
            None,
        ),
        (
            "switch",
            "boolean",
            100,
            json!(false),
            Some(0.0),
            "good",
            None,
        ),
        (
            "switch",
            "boolean",
            110,
            json!(false),
            Some(0.0),
            "good",
            None,
        ),
        (
            "switch",
            "boolean",
            120,
            json!(true),
            Some(1.0),
            "good",
            None,
        ),
        ("label", "string", 100, json!("A"), None, "good", None),
        ("label", "string", 110, json!("A"), None, "good", None),
        ("label", "string", 120, json!("B"), None, "good", None),
    ] {
        let mut row = modbus_history_input("environment", "holding", point_id, created_at);
        row.point_key = point_id.into();
        row.data_type = data_type.into();
        row.value = value;
        row.numeric_value = numeric;
        row.display_value = row.value.as_str().map(str::to_owned).unwrap_or_else(|| {
            row.value
                .as_bool()
                .map(|value| if value { "ON" } else { "OFF" }.into())
                .unwrap_or_else(|| row.value.to_string())
        });
        row.quality = quality.into();
        row.reason = reason.map(str::to_owned);
        rows.push(row);
    }
    database.record_modbus_point_history(rows).unwrap();

    let result = database
        .query_modbus_point_series(ModbusPointSeriesQuery {
            endpoint_id: "master-1".into(),
            points: ["numeric", "switch", "label"]
                .map(|id| point_identity("environment", "holding", id))
                .to_vec(),
            from: 100,
            to: 200,
            bucket_count: 1,
        })
        .unwrap();
    let json = serde_json::to_value(result).unwrap();
    let numeric = json["series"]
        .as_array()
        .unwrap()
        .iter()
        .find(|series| series["pointId"] == "numeric")
        .unwrap();
    assert_eq!(
        numeric["samples"][0],
        json!({
            "bucket": 0, "firstAt": 100, "firstValue": 10.0,
            "lastAt": 130, "lastValue": 20.0, "minAt": 100, "minValue": 10.0,
            "maxAt": 110, "maxValue": 30.0, "goodCount": 3, "abnormalCount": 1,
            "worstQuality": "bad-communication",
            "marker": { "createdAt": 120, "quality": "bad-communication", "reason": "timeout" }
        })
    );
    let switch = json["series"]
        .as_array()
        .unwrap()
        .iter()
        .find(|series| series["pointId"] == "switch")
        .unwrap();
    assert_eq!(switch["samples"].as_array().unwrap().len(), 2);
    let label = json["series"]
        .as_array()
        .unwrap()
        .iter()
        .find(|series| series["pointId"] == "label")
        .unwrap();
    assert_eq!(label["samples"].as_array().unwrap().len(), 2);
}

#[test]
fn modbus_point_retention_and_clear_leave_existing_history_untouched() {
    let database = ConfigurationDatabase::open_in_memory_for_test().unwrap();
    database
        .insert_serial_endpoint_for_test("master-1")
        .unwrap();
    let now = 1_780_000_000_000_i64;
    database
        .insert_frame_batch(&[FrameHistoryInsert {
            endpoint_id: "master-1".into(),
            session_id: "session-1".into(),
            peer_id: None,
            direction: "in".into(),
            format: "hex".into(),
            framing: "none".into(),
            byte_count: 1,
            payload: vec![1],
            created_at: 1_720_000_000_000,
        }])
        .unwrap();
    database
        .record_modbus_point_history(vec![
            modbus_history_input("environment", "holding", "old", now - (8 * 86_400_000)),
            modbus_history_input("environment", "holding", "recent", now - 86_400_000),
        ])
        .unwrap();
    let stats = database.storage_stats().unwrap();
    assert_eq!(stats.modbus_point_history_count, 2);
    assert!(stats.modbus_point_history_estimated_bytes > 0);
    assert_eq!(stats.total_count, 1);

    assert_eq!(
        database
            .cleanup_modbus_point_history_at("7-days", now)
            .unwrap(),
        ModbusPointHistoryCleanupResult {
            deleted_count: 1,
            completed_at: now
        }
    );
    assert_eq!(
        database
            .storage_stats()
            .unwrap()
            .modbus_point_history_last_cleanup_at,
        Some(now)
    );
    assert_eq!(
        database
            .query_frames(master_frame_history_query())
            .unwrap()
            .total,
        1
    );
    assert_eq!(
        database
            .clear_modbus_point_history(ModbusPointHistoryQuery {
                points: vec![point_identity("environment", "holding", "recent")],
                ..all_modbus_history_query("master-1")
            })
            .unwrap(),
        1
    );
    assert_eq!(
        database
            .query_frames(master_frame_history_query())
            .unwrap()
            .total,
        1
    );
}

fn point_identity(group: &str, request: &str, point: &str) -> ModbusPointIdentity {
    ModbusPointIdentity {
        request_group_id: group.into(),
        request_id: request.into(),
        point_id: point.into(),
    }
}

fn modbus_history_input(
    group: &str,
    request: &str,
    point: &str,
    created_at: i64,
) -> ModbusPointHistoryInput {
    ModbusPointHistoryInput {
        endpoint_id: "master-1".into(),
        request_group_id: group.into(),
        request_id: request.into(),
        point_id: point.into(),
        point_key: point.into(),
        point_name: "Temperature".into(),
        data_type: "float32".into(),
        unit: Some("C".into()),
        raw: json!([16844, 0]),
        value: json!(25.5),
        numeric_value: Some(25.5),
        display_value: "25.5".into(),
        quality: "good".into(),
        reason: None,
        created_at,
    }
}

fn all_modbus_history_query(endpoint_id: &str) -> ModbusPointHistoryQuery {
    ModbusPointHistoryQuery {
        endpoint_id: endpoint_id.into(),
        points: Vec::new(),
        from: 0,
        to: MAX_SAFE_TIMESTAMP,
        page: 1,
        page_size: 50,
    }
}

fn master_frame_history_query() -> HistoryQuery {
    HistoryQuery {
        endpoint_id: Some("master-1".into()),
        page: 1,
        page_size: 50,
        ..HistoryQuery::default()
    }
}
