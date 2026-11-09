use std::{
    collections::VecDeque,
    panic::{catch_unwind, AssertUnwindSafe},
    sync::{
        mpsc::{self, Receiver, SyncSender, TrySendError},
        Arc, Mutex,
    },
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::{
    database::{ConfigurationDatabase, FrameHistoryInsert, LogHistoryInsert},
    serial::SerialEvent,
};

const MAX_BATCH_SIZE: usize = 200;
const DEFAULT_COMMAND_CAPACITY: usize = 1_024;
const DEFAULT_ROW_CAPACITY: usize = 2_000;
const DEFAULT_FLUSH_INTERVAL: Duration = Duration::from_secs(1);
const DEFAULT_MAX_RETRIES: usize = 2;
const MAX_FAILURE_DETAIL_BYTES: usize = 256;
const MAX_FAILURE_MESSAGE_BYTES: usize = 640;

pub(crate) trait PersistenceStore: Send + Sync + 'static {
    fn endpoint_receive_mode(&self, endpoint_id: &str) -> Result<String, String>;
    fn insert_frame_batch(&self, rows: &[FrameHistoryInsert]) -> Result<(), String>;
    fn insert_log_batch(&self, rows: &[LogHistoryInsert]) -> Result<(), String>;
}

impl PersistenceStore for ConfigurationDatabase {
    fn endpoint_receive_mode(&self, endpoint_id: &str) -> Result<String, String> {
        ConfigurationDatabase::endpoint_receive_mode(self, endpoint_id)
    }

    fn insert_frame_batch(&self, rows: &[FrameHistoryInsert]) -> Result<(), String> {
        ConfigurationDatabase::insert_frame_batch(self, rows)
    }

    fn insert_log_batch(&self, rows: &[LogHistoryInsert]) -> Result<(), String> {
        ConfigurationDatabase::insert_log_batch(self, rows)
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct PersistenceReport {
    pub(crate) context: &'static str,
    pub(crate) error: String,
}

type RetryDelay = Arc<dyn Fn(usize) + Send + Sync>;
type Clock = Arc<dyn Fn() -> Instant + Send + Sync>;

#[derive(Clone)]
pub(crate) struct PersistenceConfig {
    pub(crate) command_capacity: usize,
    pub(crate) frame_capacity: usize,
    pub(crate) log_capacity: usize,
    pub(crate) flush_interval: Duration,
    pub(crate) max_retries: usize,
    pub(crate) retry_delay: RetryDelay,
    pub(crate) clock: Clock,
}

impl Default for PersistenceConfig {
    fn default() -> Self {
        Self {
            command_capacity: DEFAULT_COMMAND_CAPACITY,
            frame_capacity: DEFAULT_ROW_CAPACITY,
            log_capacity: DEFAULT_ROW_CAPACITY,
            flush_interval: DEFAULT_FLUSH_INTERVAL,
            max_retries: DEFAULT_MAX_RETRIES,
            retry_delay: Arc::new(default_retry_delay),
            clock: Arc::new(Instant::now),
        }
    }
}

type Reporter = Arc<dyn Fn(PersistenceReport) + Send + Sync>;

enum Command {
    Event(Box<SerialEvent>),
    Flush(SyncSender<Result<(), String>>),
    Shutdown(SyncSender<Result<(), String>>),
    #[cfg(test)]
    Tick(SyncSender<Result<(), String>>),
}

struct Lifecycle {
    shutdown: bool,
    worker: Option<JoinHandle<()>>,
}

#[derive(Default)]
struct FailureSummary {
    count: u64,
    first: Option<String>,
    latest: Option<String>,
}

impl FailureSummary {
    fn record(&mut self, error: String) {
        let error = bounded_failure_detail(error);
        self.count = self.count.saturating_add(1);
        if self.first.is_none() {
            self.first = Some(error.clone());
        }
        self.latest = Some(error);
    }

    fn record_result(&mut self, result: Result<(), String>) {
        if let Err(error) = result {
            self.record(error);
        }
    }

    fn merge(&mut self, other: Self) {
        if other.count == 0 {
            return;
        }
        if self.first.is_none() {
            self.first = other.first;
        }
        self.latest = other.latest;
        self.count = self.count.saturating_add(other.count);
    }

    fn into_result(self) -> Result<(), String> {
        match self.count {
            0 => Ok(()),
            1 => Err(self
                .first
                .unwrap_or_else(|| "persistence write failed".into())),
            count => {
                let first = self.first.unwrap_or_else(|| "unknown".into());
                let latest = self.latest.unwrap_or_else(|| first.clone());
                let message =
                    format!("persistence failures (count={count}); first={first}; latest={latest}");
                debug_assert!(message.len() <= MAX_FAILURE_MESSAGE_BYTES);
                Err(message)
            }
        }
    }
}

pub(crate) struct TransportPersistence {
    commands: SyncSender<Command>,
    reporter: Reporter,
    lifecycle: Mutex<Lifecycle>,
}

impl TransportPersistence {
    pub(crate) fn new(store: Arc<ConfigurationDatabase>) -> Self {
        Self::with_config(
            store,
            |report| {
                eprintln!(
                    "[Ineed LinkLab] transport persistence failed ({}): {}",
                    report.context, report.error
                );
            },
            PersistenceConfig::default(),
        )
    }

    pub(crate) fn with_config<S, F>(store: Arc<S>, report: F, config: PersistenceConfig) -> Self
    where
        S: PersistenceStore,
        F: Fn(PersistenceReport) + Send + Sync + 'static,
    {
        let reporter: Reporter = Arc::new(report);
        let (commands, receiver) = mpsc::sync_channel(config.command_capacity.max(1));
        let worker_reporter = reporter.clone();
        let worker = thread::Builder::new()
            .name("transport-persistence".into())
            .spawn(move || run_worker(receiver, store, worker_reporter, config))
            .expect("failed to start transport persistence worker");
        Self {
            commands,
            reporter,
            lifecycle: Mutex::new(Lifecycle {
                shutdown: false,
                worker: Some(worker),
            }),
        }
    }

    pub(crate) fn handle(&self, event: SerialEvent) {
        match self.commands.try_send(Command::Event(Box::new(event))) {
            Ok(()) => {}
            Err(TrySendError::Full(_)) => self.report("event channel overflow", "event dropped"),
            Err(TrySendError::Disconnected(_)) => {
                self.report("event channel disconnected", "event dropped")
            }
        }
    }

    pub(crate) fn handle_then_forward<F>(&self, event: SerialEvent, forward: F)
    where
        F: FnOnce(SerialEvent),
    {
        self.handle(event.clone());
        forward(event);
    }

    pub(crate) fn flush(&self) -> Result<(), String> {
        let lifecycle = self.lock_lifecycle();
        if lifecycle.shutdown {
            return Ok(());
        }
        let (acknowledge, acknowledged) = mpsc::sync_channel(1);
        self.commands
            .send(Command::Flush(acknowledge))
            .map_err(|_| "transport persistence worker disconnected".to_owned())?;
        acknowledged
            .recv()
            .map_err(|_| "transport persistence flush was not acknowledged".to_owned())?
    }

    #[cfg(test)]
    fn tick(&self) -> Result<(), String> {
        let lifecycle = self.lock_lifecycle();
        if lifecycle.shutdown {
            return Ok(());
        }
        let (acknowledge, acknowledged) = mpsc::sync_channel(1);
        self.commands
            .send(Command::Tick(acknowledge))
            .map_err(|_| "transport persistence worker disconnected".to_owned())?;
        acknowledged
            .recv()
            .map_err(|_| "transport persistence tick was not acknowledged".to_owned())?
    }

    pub(crate) fn shutdown(&self) -> Result<(), String> {
        let mut lifecycle = self.lock_lifecycle();
        if lifecycle.shutdown {
            return Ok(());
        }
        lifecycle.shutdown = true;
        let (acknowledge, acknowledged) = mpsc::sync_channel(1);
        let send_result = self.commands.send(Command::Shutdown(acknowledge));
        let acknowledge_result = send_result
            .map_err(|_| "transport persistence worker disconnected".to_owned())
            .and_then(|_| {
                acknowledged
                    .recv()
                    .map_err(|_| "transport persistence shutdown was not acknowledged".to_owned())
            })
            .and_then(|result| result);
        let join_result = lifecycle
            .worker
            .take()
            .map(|worker| {
                worker
                    .join()
                    .map_err(|_| "transport persistence worker panicked".to_owned())
            })
            .unwrap_or(Ok(()));
        acknowledge_result.and(join_result)
    }

    fn report(&self, context: &'static str, error: impl Into<String>) {
        safe_report(&self.reporter, context, error);
    }

    fn lock_lifecycle(&self) -> std::sync::MutexGuard<'_, Lifecycle> {
        self.lifecycle
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }
}

fn run_worker<S: PersistenceStore>(
    receiver: Receiver<Command>,
    store: Arc<S>,
    reporter: Reporter,
    config: PersistenceConfig,
) {
    let mut worker = Worker {
        store,
        reporter,
        frames: VecDeque::new(),
        logs: VecDeque::new(),
        frame_capacity: config.frame_capacity.max(1),
        log_capacity: config.log_capacity.max(1),
        flush_interval: config.flush_interval,
        max_retries: config.max_retries,
        retry_delay: config.retry_delay,
        clock: config.clock,
        deadline: None,
        pending_failure: FailureSummary::default(),
    };

    loop {
        if worker.deadline_is_due() {
            worker.flush_background();
        }
        let command = match worker.deadline {
            Some(deadline) => {
                match receiver.recv_timeout(deadline.saturating_duration_since((worker.clock)())) {
                    Ok(command) => Some(command),
                    Err(mpsc::RecvTimeoutError::Timeout) => {
                        worker.flush_background();
                        None
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        worker.flush_background();
                        break;
                    }
                }
            }
            None => match receiver.recv() {
                Ok(command) => Some(command),
                Err(_) => {
                    worker.flush_background();
                    break;
                }
            },
        };

        match command {
            Some(Command::Event(event)) => worker.handle(*event),
            Some(Command::Flush(acknowledge)) => {
                let _ = acknowledge.send(worker.flush_for_reply());
            }
            #[cfg(test)]
            Some(Command::Tick(acknowledge)) => {
                let _ = acknowledge.send(worker.flush_for_reply());
            }
            Some(Command::Shutdown(acknowledge)) => {
                let _ = acknowledge.send(worker.flush_for_reply());
                break;
            }
            None => {}
        }
    }
}

struct Worker<S> {
    store: Arc<S>,
    reporter: Reporter,
    frames: VecDeque<FrameHistoryInsert>,
    logs: VecDeque<LogHistoryInsert>,
    frame_capacity: usize,
    log_capacity: usize,
    flush_interval: Duration,
    max_retries: usize,
    retry_delay: RetryDelay,
    clock: Clock,
    deadline: Option<Instant>,
    pending_failure: FailureSummary,
}

impl<S: PersistenceStore> Worker<S> {
    fn handle(&mut self, event: SerialEvent) {
        match event {
            SerialEvent::Frames(batch) => {
                let framing = match self.store.endpoint_receive_mode(&batch.endpoint_id) {
                    Ok(framing) => framing,
                    Err(error) => {
                        safe_report(&self.reporter, "frame event snapshot", error);
                        return;
                    }
                };
                let mut dropped = 0;
                for frame in batch.frames {
                    let byte_count = match i64::try_from(frame.bytes.len()) {
                        Ok(byte_count) => byte_count,
                        Err(error) => {
                            safe_report(&self.reporter, "frame event snapshot", error.to_string());
                            continue;
                        }
                    };
                    let created_at = match i64::try_from(frame.created_at) {
                        Ok(created_at) => created_at,
                        Err(error) => {
                            safe_report(&self.reporter, "frame event snapshot", error.to_string());
                            continue;
                        }
                    };
                    if self.frames.len() == self.frame_capacity {
                        self.frames.pop_front();
                        dropped += 1;
                    }
                    self.frames.push_back(FrameHistoryInsert {
                        endpoint_id: batch.endpoint_id.clone(),
                        session_id: batch.session_id.clone(),
                        peer_id: frame.peer_id,
                        direction: frame.direction.into(),
                        format: if frame.message_type.as_deref() == Some("text") {
                            "text"
                        } else {
                            "hex"
                        }
                        .into(),
                        framing: frame.framing.unwrap_or_else(|| framing.clone()),
                        byte_count,
                        payload: frame.bytes,
                        created_at,
                    });
                }
                if dropped > 0 {
                    safe_report(
                        &self.reporter,
                        "frame buffer overflow",
                        format!("dropped {dropped} oldest row(s)"),
                    );
                }
                self.flush_ready_frames();
            }
            SerialEvent::Status(status) => {
                if let Some(log) = status.log {
                    if self.logs.len() == self.log_capacity {
                        self.logs.pop_front();
                        safe_report(
                            &self.reporter,
                            "log buffer overflow",
                            "dropped 1 oldest row",
                        );
                    }
                    let created_at = match i64::try_from(log.created_at) {
                        Ok(created_at) => created_at,
                        Err(error) => {
                            safe_report(&self.reporter, "log event snapshot", error.to_string());
                            return;
                        }
                    };
                    self.logs.push_back(LogHistoryInsert {
                        endpoint_id: status.endpoint_id,
                        session_id: status.session_id,
                        peer_id: log.peer_id,
                        level: log.level.into(),
                        source: log.source.into(),
                        code: log.code,
                        message: log.message,
                        details: log.details,
                        created_at,
                    });
                    self.flush_ready_logs();
                }
            }
            SerialEvent::Peers(_) => {}
        }
        self.refresh_deadline();
    }

    fn flush_ready_frames(&mut self) {
        while self.frames.len() >= MAX_BATCH_SIZE {
            let result = self.flush_frame_batch(MAX_BATCH_SIZE);
            self.remember_failure(result);
        }
    }

    fn flush_ready_logs(&mut self) {
        while self.logs.len() >= MAX_BATCH_SIZE {
            let result = self.flush_log_batch(MAX_BATCH_SIZE);
            self.remember_failure(result);
        }
    }

    fn drain_queues(&mut self) -> FailureSummary {
        let mut failure = FailureSummary::default();
        while !self.frames.is_empty() {
            failure.record_result(self.flush_frame_batch(MAX_BATCH_SIZE));
        }
        while !self.logs.is_empty() {
            failure.record_result(self.flush_log_batch(MAX_BATCH_SIZE));
        }
        self.deadline = None;
        failure
    }

    fn flush_background(&mut self) {
        let failure = self.drain_queues();
        self.pending_failure.merge(failure);
    }

    fn flush_for_reply(&mut self) -> Result<(), String> {
        let mut failure = std::mem::take(&mut self.pending_failure);
        failure.merge(self.drain_queues());
        failure.into_result()
    }

    fn remember_failure(&mut self, result: Result<(), String>) {
        self.pending_failure.record_result(result);
    }

    fn flush_frame_batch(&mut self, limit: usize) -> Result<(), String> {
        let rows = drain_rows(&mut self.frames, limit);
        persist_with_retry(
            self.max_retries,
            &self.retry_delay,
            &self.reporter,
            "frame batch write",
            || self.store.insert_frame_batch(&rows),
        )
    }

    fn flush_log_batch(&mut self, limit: usize) -> Result<(), String> {
        let rows = drain_rows(&mut self.logs, limit);
        persist_with_retry(
            self.max_retries,
            &self.retry_delay,
            &self.reporter,
            "log batch write",
            || self.store.insert_log_batch(&rows),
        )
    }

    fn refresh_deadline(&mut self) {
        if self.frames.is_empty() && self.logs.is_empty() {
            self.deadline = None;
        } else if self.deadline.is_none() {
            self.deadline = Some((self.clock)() + self.flush_interval);
        }
    }

    fn deadline_is_due(&self) -> bool {
        self.deadline
            .is_some_and(|deadline| (self.clock)() >= deadline)
    }
}

fn persist_with_retry<F>(
    max_retries: usize,
    retry_delay: &RetryDelay,
    reporter: &Reporter,
    context: &'static str,
    mut persist: F,
) -> Result<(), String>
where
    F: FnMut() -> Result<(), String>,
{
    for retry in 0..=max_retries {
        match persist() {
            Ok(()) => return Ok(()),
            Err(_) if retry < max_retries => retry_delay(retry + 1),
            Err(error) => {
                safe_report(reporter, context, error.clone());
                return Err(format!("{context}: {error}"));
            }
        }
    }
    unreachable!("retry loop always returns")
}

fn bounded_failure_detail(mut error: String) -> String {
    if error.len() <= MAX_FAILURE_DETAIL_BYTES {
        return error;
    }
    let mut end = MAX_FAILURE_DETAIL_BYTES.saturating_sub(3);
    while !error.is_char_boundary(end) {
        end = end.saturating_sub(1);
    }
    error.truncate(end);
    error.push_str("...");
    error
}

fn default_retry_delay(attempt: usize) {
    let exponent = u32::try_from(attempt.saturating_sub(1)).unwrap_or(u32::MAX);
    let multiplier = 2_u64.checked_pow(exponent).unwrap_or(u64::MAX);
    let millis = 250_u64.saturating_mul(multiplier).min(1_000);
    thread::sleep(Duration::from_millis(millis));
}

fn drain_rows<T>(rows: &mut VecDeque<T>, limit: usize) -> Vec<T> {
    let count = rows.len().min(limit);
    rows.drain(..count).collect()
}

fn safe_report(reporter: &Reporter, context: &'static str, error: impl Into<String>) {
    let report = PersistenceReport {
        context,
        error: error.into(),
    };
    let _ = catch_unwind(AssertUnwindSafe(|| reporter(report)));
}

#[cfg(test)]
mod tests {
    use std::{
        sync::{
            atomic::{AtomicUsize, Ordering},
            mpsc::{self, Sender},
            Arc, Condvar, Mutex,
        },
        time::{Duration, Instant},
    };

    use serde_json::json;

    use crate::{
        database::{FrameHistoryInsert, LogHistoryInsert},
        serial::{FrameBatch, SerialEvent, SerialStatus, StatusEvent, StatusLog, WireFrame},
    };

    use super::{
        run_worker, Command, PersistenceConfig, PersistenceReport, PersistenceStore, Reporter,
        TransportPersistence,
    };

    #[test]
    fn command_queue_slots_do_not_embed_full_serial_events() {
        // Bounded channels reserve one slot per command; event payloads belong on the heap.
        assert!(std::mem::size_of::<Command>() <= 4 * std::mem::size_of::<usize>());
    }

    struct RecordingStore {
        framing: String,
        frames: Mutex<Vec<Vec<FrameHistoryInsert>>>,
        logs: Mutex<Vec<Vec<LogHistoryInsert>>>,
        frame_batches: Option<Sender<usize>>,
        log_batches: Option<Sender<usize>>,
        frame_gate: Option<Arc<(Mutex<bool>, Condvar)>>,
        fail_frames: bool,
        writes_in_flight: AtomicUsize,
        max_writes_in_flight: AtomicUsize,
    }

    struct RetryStore {
        frame_failures: Mutex<usize>,
        log_failures: Mutex<usize>,
        frame_attempts: AtomicUsize,
        log_attempts: AtomicUsize,
        frames: Mutex<Vec<FrameHistoryInsert>>,
        logs: Mutex<Vec<LogHistoryInsert>>,
    }

    impl RetryStore {
        fn new(frame_failures: usize, log_failures: usize) -> Self {
            Self {
                frame_failures: Mutex::new(frame_failures),
                log_failures: Mutex::new(log_failures),
                frame_attempts: AtomicUsize::new(0),
                log_attempts: AtomicUsize::new(0),
                frames: Mutex::new(Vec::new()),
                logs: Mutex::new(Vec::new()),
            }
        }

        fn fail(remaining: &Mutex<usize>) -> bool {
            let mut remaining = remaining.lock().unwrap();
            if *remaining == 0 {
                false
            } else {
                *remaining -= 1;
                true
            }
        }
    }

    impl PersistenceStore for RetryStore {
        fn endpoint_receive_mode(&self, _endpoint_id: &str) -> Result<String, String> {
            Ok("raw".into())
        }

        fn insert_frame_batch(&self, rows: &[FrameHistoryInsert]) -> Result<(), String> {
            self.frame_attempts.fetch_add(1, Ordering::SeqCst);
            if Self::fail(&self.frame_failures) {
                return Err("injected frame write failure".into());
            }
            self.frames.lock().unwrap().extend_from_slice(rows);
            Ok(())
        }

        fn insert_log_batch(&self, rows: &[LogHistoryInsert]) -> Result<(), String> {
            self.log_attempts.fetch_add(1, Ordering::SeqCst);
            if Self::fail(&self.log_failures) {
                return Err("injected log write failure".into());
            }
            self.logs.lock().unwrap().extend_from_slice(rows);
            Ok(())
        }
    }

    impl RecordingStore {
        fn new(framing: &str) -> Self {
            Self {
                framing: framing.into(),
                frames: Mutex::new(Vec::new()),
                logs: Mutex::new(Vec::new()),
                frame_batches: None,
                log_batches: None,
                frame_gate: None,
                fail_frames: false,
                writes_in_flight: AtomicUsize::new(0),
                max_writes_in_flight: AtomicUsize::new(0),
            }
        }

        fn with_frame_signal(mut self, sender: Sender<usize>) -> Self {
            self.frame_batches = Some(sender);
            self
        }

        fn with_log_signal(mut self, sender: Sender<usize>) -> Self {
            self.log_batches = Some(sender);
            self
        }

        fn blocked_frames(mut self, gate: Arc<(Mutex<bool>, Condvar)>) -> Self {
            self.frame_gate = Some(gate);
            self
        }

        fn failing_frames(mut self) -> Self {
            self.fail_frames = true;
            self
        }

        fn enter_write(&self) {
            let in_flight = self.writes_in_flight.fetch_add(1, Ordering::SeqCst) + 1;
            self.max_writes_in_flight
                .fetch_max(in_flight, Ordering::SeqCst);
        }

        fn leave_write(&self) {
            self.writes_in_flight.fetch_sub(1, Ordering::SeqCst);
        }
    }

    impl PersistenceStore for RecordingStore {
        fn endpoint_receive_mode(&self, _endpoint_id: &str) -> Result<String, String> {
            Ok(self.framing.clone())
        }

        fn insert_frame_batch(&self, rows: &[FrameHistoryInsert]) -> Result<(), String> {
            self.enter_write();
            if self.fail_frames {
                self.leave_write();
                return Err("injected frame write failure".into());
            }
            if let Some(sender) = &self.frame_batches {
                let _ = sender.send(rows.len());
            }
            if let Some(gate) = &self.frame_gate {
                let (released, changed) = &**gate;
                let mut released = released.lock().unwrap();
                while !*released {
                    released = changed.wait(released).unwrap();
                }
            }
            self.frames.lock().unwrap().push(rows.to_vec());
            self.leave_write();
            Ok(())
        }

        fn insert_log_batch(&self, rows: &[LogHistoryInsert]) -> Result<(), String> {
            self.enter_write();
            if let Some(sender) = &self.log_batches {
                let _ = sender.send(rows.len());
            }
            self.logs.lock().unwrap().push(rows.to_vec());
            self.leave_write();
            Ok(())
        }
    }

    fn persistence(
        store: Arc<RecordingStore>,
        reports: Arc<Mutex<Vec<PersistenceReport>>>,
        config: PersistenceConfig,
    ) -> TransportPersistence {
        TransportPersistence::with_config(
            store,
            move |report| {
                reports.lock().unwrap().push(report);
            },
            config,
        )
    }

    const WIRE_FRAME_BASE_CREATED_AT: u64 = 1_720_000_000_000;
    const WIRE_STATUS_CREATED_AT: u64 = 1_720_000_001_000;
    const WIRE_STATUS_LOG_CREATED_AT: u64 = 1_720_000_001_001;

    fn frames(values: &[u8]) -> SerialEvent {
        SerialEvent::Frames(FrameBatch {
            endpoint_id: "serial-1".into(),
            operation_id: "open-1".into(),
            session_id: "session-1".into(),
            frames: values
                .iter()
                .enumerate()
                .map(|(index, byte)| WireFrame {
                    message_type: None,
                    framing: None,
                    direction: if index % 2 == 0 { "in" } else { "out" },
                    peer_id: None,
                    bytes: vec![*byte],
                    created_at: WIRE_FRAME_BASE_CREATED_AT + index as u64,
                })
                .collect(),
        })
    }

    #[test]
    fn websocket_history_preserves_message_type_and_boundary() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, PersistenceConfig::default());
        let mut event = frames(&[1, 255]);
        if let SerialEvent::Frames(batch) = &mut event {
            batch.frames[0].message_type = Some("text".into());
            batch.frames[0].bytes = b"hello".to_vec();
            batch.frames[1].message_type = Some("binary".into());
            for frame in &mut batch.frames {
                frame.framing = Some("websocket".into());
            }
        }
        persistence.handle(event);
        persistence.flush().unwrap();
        let batches = store.frames.lock().unwrap();
        let rows: Vec<_> = batches.iter().flatten().collect();
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].format, "text");
        assert_eq!(rows[0].payload, b"hello");
        assert_eq!(rows[1].format, "hex");
        assert!(rows.iter().all(|r| r.framing == "websocket"));
    }

    fn status(message: &str, details: serde_json::Value) -> SerialEvent {
        SerialEvent::Status(StatusEvent {
            endpoint_id: "serial-1".into(),
            operation_id: "open-1".into(),
            session_id: Some("session-1".into()),
            status: SerialStatus::Open,
            error: None,
            created_at: WIRE_STATUS_CREATED_AT,
            log: Some(StatusLog {
                level: "info",
                source: "serial",
                peer_id: None,
                code: None,
                message: message.into(),
                details: Some(details),
                created_at: WIRE_STATUS_LOG_CREATED_AT,
            }),
        })
    }

    fn test_config() -> PersistenceConfig {
        PersistenceConfig {
            command_capacity: 400,
            frame_capacity: 400,
            log_capacity: 400,
            flush_interval: Duration::from_secs(60),
            max_retries: 2,
            retry_delay: Arc::new(|_| {}),
            clock: Arc::new(Instant::now),
        }
    }

    #[test]
    fn snapshots_events_as_fifo_hex_frames_and_nonnull_logs() {
        let store = Arc::new(RecordingStore::new("delimiter"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, test_config());
        let details = json!({ "path": "/dev/ttyUSB0", "nested": ["stable"] });

        persistence.handle(frames(&[0, 128, 255]));
        persistence.handle(status("opened", details.clone()));
        persistence.handle(SerialEvent::Status(StatusEvent {
            endpoint_id: "serial-1".into(),
            operation_id: "open-1".into(),
            session_id: None,
            status: SerialStatus::Closed,
            error: None,
            created_at: 1_720_000_001_002,
            log: None,
        }));
        persistence.flush().unwrap();

        let frames = store.frames.lock().unwrap();
        assert_eq!(frames.len(), 1);
        assert_eq!(
            frames[0]
                .iter()
                .map(|row| row.payload.clone())
                .collect::<Vec<_>>(),
            vec![vec![0], vec![128], vec![255]]
        );
        assert_eq!(
            frames[0]
                .iter()
                .map(|row| row.direction.as_str())
                .collect::<Vec<_>>(),
            vec!["in", "out", "in"]
        );
        assert_eq!(
            frames[0]
                .iter()
                .map(|row| row.created_at)
                .collect::<Vec<_>>(),
            vec![
                WIRE_FRAME_BASE_CREATED_AT as i64,
                (WIRE_FRAME_BASE_CREATED_AT + 1) as i64,
                (WIRE_FRAME_BASE_CREATED_AT + 2) as i64,
            ]
        );
        assert!(frames[0]
            .iter()
            .all(|row| row.format == "hex" && row.framing == "delimiter"));
        drop(frames);
        let logs = store.logs.lock().unwrap();
        assert_eq!(logs.len(), 1);
        assert_eq!(logs[0].len(), 1);
        assert_eq!(logs[0][0].message, "opened");
        assert_eq!(logs[0][0].details, Some(details));
        assert_eq!(logs[0][0].created_at, WIRE_STATUS_LOG_CREATED_AT as i64);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn frame_snapshots_preserve_tcp_peer_identity() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, test_config());

        persistence.handle(SerialEvent::Frames(FrameBatch {
            endpoint_id: "tcp-server-1".into(),
            operation_id: "open-tcp-server-1".into(),
            session_id: "tcp-session-1".into(),
            frames: vec![WireFrame {
                message_type: None,
                framing: None,
                direction: "in",
                peer_id: Some("tcp-peer-1".into()),
                bytes: vec![0x41],
                created_at: WIRE_FRAME_BASE_CREATED_AT,
            }],
        }));
        persistence.flush().unwrap();

        let frames = store.frames.lock().unwrap();
        assert_eq!(frames[0][0].peer_id.as_deref(), Some("tcp-peer-1"));
        persistence.shutdown().unwrap();
    }

    #[test]
    fn log_snapshots_preserve_tcp_peer_identity() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, test_config());

        persistence.handle(SerialEvent::Status(StatusEvent {
            endpoint_id: "tcp-server-1".into(),
            operation_id: "open-tcp-server-1".into(),
            session_id: Some("tcp-session-1".into()),
            status: SerialStatus::Listening,
            error: None,
            created_at: WIRE_STATUS_CREATED_AT,
            log: Some(StatusLog {
                level: "info",
                source: "tcp",
                peer_id: Some("tcp-peer-1".into()),
                code: None,
                message: "TCP peer connected".into(),
                details: Some(json!({ "remoteAddress": "127.0.0.1:51000" })),
                created_at: WIRE_STATUS_CREATED_AT,
            }),
        }));
        persistence.flush().unwrap();

        let logs = store.logs.lock().unwrap();
        assert_eq!(logs[0][0].peer_id.as_deref(), Some("tcp-peer-1"));
        persistence.shutdown().unwrap();
    }

    #[test]
    fn udp_snapshots_preserve_peer_identity_source_and_exact_timestamps() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, test_config());

        persistence.handle(SerialEvent::Frames(FrameBatch {
            endpoint_id: "udp-server-1".into(),
            operation_id: "open-udp-server-1".into(),
            session_id: "udp-session-1".into(),
            frames: vec![WireFrame {
                message_type: None,
                framing: None,
                direction: "in",
                peer_id: Some("udp-peer-1".into()),
                bytes: vec![0x55],
                created_at: WIRE_FRAME_BASE_CREATED_AT,
            }],
        }));
        persistence.handle(SerialEvent::Status(StatusEvent {
            endpoint_id: "udp-server-1".into(),
            operation_id: "open-udp-server-1".into(),
            session_id: Some("udp-session-1".into()),
            status: SerialStatus::Listening,
            error: None,
            created_at: WIRE_STATUS_CREATED_AT,
            log: Some(StatusLog {
                level: "info",
                source: "udp",
                peer_id: Some("udp-peer-1".into()),
                code: None,
                message: "UDP peer discovered".into(),
                details: Some(json!({ "remoteAddress": "127.0.0.1:52000" })),
                created_at: WIRE_STATUS_CREATED_AT,
            }),
        }));
        persistence.flush().unwrap();

        let frames = store.frames.lock().unwrap();
        assert_eq!(frames[0][0].peer_id.as_deref(), Some("udp-peer-1"));
        assert_eq!(frames[0][0].created_at, WIRE_FRAME_BASE_CREATED_AT as i64);
        drop(frames);
        let logs = store.logs.lock().unwrap();
        assert_eq!(logs[0][0].source, "udp");
        assert_eq!(logs[0][0].peer_id.as_deref(), Some("udp-peer-1"));
        assert_eq!(logs[0][0].created_at, WIRE_STATUS_CREATED_AT as i64);
        drop(logs);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn writes_each_queue_immediately_at_two_hundred_rows() {
        let (frames_sent, frames_received) = mpsc::channel();
        let (logs_sent, logs_received) = mpsc::channel();
        let store = Arc::new(
            RecordingStore::new("raw")
                .with_frame_signal(frames_sent)
                .with_log_signal(logs_sent),
        );
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store, reports, test_config());

        persistence.handle(frames(
            &(0..200).map(|value| value as u8).collect::<Vec<_>>(),
        ));
        assert_eq!(
            frames_received
                .recv_timeout(Duration::from_secs(1))
                .unwrap(),
            200
        );
        for index in 0..200 {
            persistence.handle(status("log", json!({ "index": index })));
        }
        assert_eq!(
            logs_received.recv_timeout(Duration::from_secs(1)).unwrap(),
            200
        );
        persistence.shutdown().unwrap();
    }

    #[test]
    fn deterministic_tick_flushes_small_frame_and_log_batches() {
        let (frames_sent, frames_received) = mpsc::channel();
        let (logs_sent, logs_received) = mpsc::channel();
        let store = Arc::new(
            RecordingStore::new("raw")
                .with_frame_signal(frames_sent)
                .with_log_signal(logs_sent),
        );
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store, reports, test_config());

        persistence.handle(frames(&[7]));
        persistence.handle(status("timed", json!({ "tick": true })));
        assert!(frames_received.try_recv().is_err());
        assert!(logs_received.try_recv().is_err());

        persistence.tick().unwrap();

        assert_eq!(frames_received.try_recv().unwrap(), 1);
        assert_eq!(logs_received.try_recv().unwrap(), 1);
        assert_eq!(
            PersistenceConfig::default().flush_interval,
            Duration::from_secs(1)
        );
        persistence.shutdown().unwrap();
    }

    #[test]
    fn deadline_flushes_while_the_command_channel_stays_nonempty() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let reporter: Reporter = {
            let reports = reports.clone();
            Arc::new(move |report| reports.lock().unwrap().push(report))
        };
        let base = Instant::now();
        let clock_calls = Arc::new(AtomicUsize::new(0));
        let config = PersistenceConfig {
            clock: {
                let clock_calls = clock_calls.clone();
                Arc::new(move || {
                    if clock_calls.fetch_add(1, Ordering::SeqCst) == 0 {
                        base
                    } else {
                        base + Duration::from_secs(60)
                    }
                })
            },
            ..test_config()
        };
        let (commands, receiver) = mpsc::sync_channel(3);
        let (shutdown, shutdown_result) = mpsc::sync_channel(1);
        commands
            .send(Command::Event(Box::new(frames(&[1]))))
            .unwrap();
        commands
            .send(Command::Event(Box::new(frames(&[2]))))
            .unwrap();
        commands.send(Command::Shutdown(shutdown)).unwrap();

        run_worker(receiver, store.clone(), reporter, config);

        assert_eq!(shutdown_result.recv().unwrap(), Ok(()));
        assert_eq!(
            store
                .frames
                .lock()
                .unwrap()
                .iter()
                .map(Vec::len)
                .collect::<Vec<_>>(),
            vec![1, 1]
        );
        assert!(reports.lock().unwrap().is_empty());
    }

    #[test]
    fn bounded_row_buffers_independently_drop_oldest_rows_and_report_the_overflow() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(
            store.clone(),
            reports.clone(),
            PersistenceConfig {
                frame_capacity: 2,
                log_capacity: 2,
                ..test_config()
            },
        );

        persistence.handle(frames(&[1]));
        persistence.handle(frames(&[2]));
        persistence.handle(frames(&[3]));
        persistence.handle(status("first", json!({ "sequence": 1 })));
        persistence.handle(status("second", json!({ "sequence": 2 })));
        persistence.handle(status("third", json!({ "sequence": 3 })));
        persistence.flush().unwrap();

        assert_eq!(
            store.frames.lock().unwrap()[0]
                .iter()
                .map(|row| row.payload[0])
                .collect::<Vec<_>>(),
            vec![2, 3]
        );
        assert_eq!(
            store.logs.lock().unwrap()[0]
                .iter()
                .map(|row| row.message.as_str())
                .collect::<Vec<_>>(),
            vec!["second", "third"]
        );
        assert!(reports
            .lock()
            .unwrap()
            .iter()
            .any(|report| report.context == "frame buffer overflow"));
        assert!(reports
            .lock()
            .unwrap()
            .iter()
            .any(|report| report.context == "log buffer overflow"));
        persistence.shutdown().unwrap();
    }

    #[test]
    fn a_failed_frame_write_is_reported_without_blocking_log_persistence() {
        let store = Arc::new(RecordingStore::new("raw").failing_frames());
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports.clone(), test_config());

        persistence.handle(frames(&[1]));
        persistence.handle(status("still persisted", json!({ "after": "frame error" })));
        let error = persistence.flush().unwrap_err();

        assert_eq!(error, "frame batch write: injected frame write failure");
        assert!(store.frames.lock().unwrap().is_empty());
        assert_eq!(store.logs.lock().unwrap()[0][0].message, "still persisted");
        assert!(reports
            .lock()
            .unwrap()
            .iter()
            .any(|report| report.context == "frame batch write"
                && report.error == "injected frame write failure"));
        persistence.shutdown().unwrap();
    }

    #[test]
    fn transient_frame_and_log_failures_retry_without_losing_rows() {
        let store = Arc::new(RetryStore::new(1, 1));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = TransportPersistence::with_config(
            store.clone(),
            {
                let reports = reports.clone();
                move |report| reports.lock().unwrap().push(report)
            },
            test_config(),
        );

        persistence.handle(frames(&[7]));
        persistence.handle(status("retried", json!({ "transient": true })));
        persistence.flush().unwrap();

        assert_eq!(store.frame_attempts.load(Ordering::SeqCst), 2);
        assert_eq!(store.log_attempts.load(Ordering::SeqCst), 2);
        assert_eq!(store.frames.lock().unwrap().len(), 1);
        assert_eq!(store.logs.lock().unwrap().len(), 1);
        assert!(reports.lock().unwrap().is_empty());
        persistence.shutdown().unwrap();
    }

    #[test]
    fn exhausted_flush_retries_are_finite_report_once_and_return_failure() {
        let store = Arc::new(RetryStore::new(usize::MAX, usize::MAX));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let retry_calls = Arc::new(AtomicUsize::new(0));
        let persistence = TransportPersistence::with_config(
            store.clone(),
            {
                let reports = reports.clone();
                move |report| reports.lock().unwrap().push(report)
            },
            PersistenceConfig {
                retry_delay: {
                    let retry_calls = retry_calls.clone();
                    Arc::new(move |_| {
                        retry_calls.fetch_add(1, Ordering::SeqCst);
                    })
                },
                ..test_config()
            },
        );

        persistence.handle(frames(&[8]));
        persistence.handle(status("exhausted", json!({ "permanent": true })));
        let error = persistence.flush().unwrap_err();

        assert!(error.contains("frame batch write"));
        assert!(error.contains("log batch write"));
        assert_eq!(store.frame_attempts.load(Ordering::SeqCst), 3);
        assert_eq!(store.log_attempts.load(Ordering::SeqCst), 3);
        assert_eq!(retry_calls.load(Ordering::SeqCst), 4);
        let reports = reports.lock().unwrap();
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.context == "frame batch write")
                .count(),
            1
        );
        assert_eq!(
            reports
                .iter()
                .filter(|report| report.context == "log batch write")
                .count(),
            1
        );
        drop(reports);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn exhausted_shutdown_retries_return_failure_after_worker_cleanup() {
        let store = Arc::new(RetryStore::new(usize::MAX, usize::MAX));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = TransportPersistence::with_config(
            store.clone(),
            move |report| reports.lock().unwrap().push(report),
            test_config(),
        );

        persistence.handle(frames(&[9]));
        persistence.handle(status("shutdown", json!({ "permanent": true })));
        let error = persistence.shutdown().unwrap_err();

        assert!(error.contains("frame batch write"));
        assert!(error.contains("log batch write"));
        assert_eq!(store.frame_attempts.load(Ordering::SeqCst), 3);
        assert_eq!(store.log_attempts.load(Ordering::SeqCst), 3);
        assert!(persistence.shutdown().is_ok());
    }

    #[test]
    fn sustained_batch_failures_keep_bounded_state_and_shutdown_cleanly() {
        let store = Arc::new(RetryStore::new(usize::MAX, 0));
        let persistence = TransportPersistence::with_config(
            store.clone(),
            |_| {},
            PersistenceConfig {
                max_retries: 0,
                ..test_config()
            },
        );
        let rows = (0..200).map(|value| value as u8).collect::<Vec<_>>();

        for _ in 0..100 {
            persistence.handle(frames(&rows));
        }
        let error = persistence.shutdown().unwrap_err();

        assert!(error.contains("count=100"), "{error}");
        assert!(
            error.len() <= 640,
            "failure state was {} bytes",
            error.len()
        );
        assert_eq!(store.frame_attempts.load(Ordering::SeqCst), 100);
        assert!(persistence.shutdown().is_ok());
    }

    #[test]
    fn failure_count_saturates_without_growing_the_summary() {
        let mut summary = super::FailureSummary::default();
        summary.record("first".into());
        summary.count = u64::MAX;

        summary.record("latest".repeat(200));
        let error = summary.into_result().unwrap_err();

        assert!(error.contains(&format!("count={}", u64::MAX)));
        assert!(error.contains("first=first"));
        assert!(error.len() <= super::MAX_FAILURE_MESSAGE_BYTES);
    }

    #[test]
    fn writes_are_serialized_across_frame_and_log_batches() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, test_config());

        persistence.handle(frames(&[1]));
        persistence.handle(status("opened", json!({ "path": "/dev/ttyUSB0" })));
        persistence.flush().unwrap();

        assert_eq!(store.max_writes_in_flight.load(Ordering::SeqCst), 1);
        persistence.shutdown().unwrap();
    }

    #[test]
    fn explicit_flush_and_idempotent_shutdown_drain_pending_rows() {
        let store = Arc::new(RecordingStore::new("raw"));
        let reports = Arc::new(Mutex::new(Vec::new()));
        let persistence = persistence(store.clone(), reports, test_config());

        persistence.handle(frames(&[1]));
        persistence.flush().unwrap();
        persistence.handle(status("closed", json!({ "path": "/dev/ttyUSB0" })));
        persistence.shutdown().unwrap();
        persistence.shutdown().unwrap();

        assert_eq!(store.frames.lock().unwrap().iter().flatten().count(), 1);
        assert_eq!(store.logs.lock().unwrap().iter().flatten().count(), 1);
    }

    #[test]
    fn forwarding_happens_before_database_ack_and_a_full_channel_never_blocks_it() {
        let (batch_sent, batch_received) = mpsc::channel();
        let gate = Arc::new((Mutex::new(false), Condvar::new()));
        let store = Arc::new(
            RecordingStore::new("raw")
                .with_frame_signal(batch_sent)
                .blocked_frames(gate.clone()),
        );
        let reports = Arc::new(Mutex::new(Vec::new()));
        let order = Arc::new(Mutex::new(Vec::new()));
        let report_order = order.clone();
        let recorded_reports = reports.clone();
        let persistence = TransportPersistence::with_config(
            store,
            move |report| {
                if report.context == "event channel overflow" {
                    report_order.lock().unwrap().push("queue-attempt");
                }
                recorded_reports.lock().unwrap().push(report);
            },
            PersistenceConfig {
                command_capacity: 1,
                ..test_config()
            },
        );
        let (forwarded, received) = mpsc::channel();

        persistence.handle_then_forward(
            frames(&(0..200).map(|value| value as u8).collect::<Vec<_>>()),
            |event| {
                forwarded.send(event).unwrap();
            },
        );
        assert!(matches!(
            received.recv_timeout(Duration::from_secs(1)).unwrap(),
            SerialEvent::Frames(_)
        ));
        assert_eq!(
            batch_received.recv_timeout(Duration::from_secs(1)).unwrap(),
            200
        );

        persistence.handle(frames(&[201]));
        persistence.handle_then_forward(frames(&[202]), |event| {
            order.lock().unwrap().push("forward");
            forwarded.send(event).unwrap();
        });
        assert!(matches!(
            received.recv_timeout(Duration::from_millis(100)).unwrap(),
            SerialEvent::Frames(_)
        ));
        assert!(reports
            .lock()
            .unwrap()
            .iter()
            .any(|report| report.context == "event channel overflow"));
        assert_eq!(*order.lock().unwrap(), vec!["queue-attempt", "forward"]);

        *gate.0.lock().unwrap() = true;
        gate.1.notify_all();
        persistence.shutdown().unwrap();
    }
}
