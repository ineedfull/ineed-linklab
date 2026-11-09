//! NDJSON stdin: {id,request}; stdout: {id,result}|{id,error}|{event}.
use ineed_linklab_tauri::opcua::OpcUaService;
use serde_json::{json, Value};
use std::{
    io::{self, BufRead},
    path::PathBuf,
    sync::Arc,
};
#[tokio::main]
async fn main() {
    let directory = std::env::args()
        .nth(1)
        .map(PathBuf::from)
        .expect("Usage: opcua-harness ISOLATED_DATA_DIRECTORY");
    let service = Arc::new(OpcUaService::new(directory, |event| {
        println!("{}", json!({"event":event}))
    }));
    let (tx, mut rx) = tokio::sync::mpsc::channel(100);
    std::thread::spawn(move || {
        for line in io::stdin().lock().lines() {
            match line {
                Ok(line) => {
                    if tx.blocking_send(line).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    let mut tasks = tokio::task::JoinSet::new();
    while let Some(line) = rx.recv().await {
        let service = service.clone();
        tasks.spawn(async move {
            match serde_json::from_str::<Value>(&line) {
                Ok(input) => {
                    let id = input.get("id").cloned().unwrap_or(Value::Null);
                    let request = input.get("request").unwrap_or(&input).clone();
                    match service.execute(request).await {
                        Ok(result) => println!("{}", json!({"id":id,"result":result})),
                        Err(error) => println!("{}", json!({"id":id,"error":error})),
                    }
                }
                Err(error) => println!("{}", json!({"error":error.to_string()})),
            }
        });
    }
    while tasks.join_next().await.is_some() {}
    service.shutdown().await;
}
