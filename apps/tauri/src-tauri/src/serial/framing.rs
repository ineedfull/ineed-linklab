// Bounded receive framing and frame batching, independent of session lifetime.
use super::*;

pub(super) struct FrameBatcher {
    started_at: u64,
    frames: Vec<WireFrame>,
}

impl FrameBatcher {
    pub(super) fn new(now: u64) -> Self {
        Self {
            started_at: now,
            frames: Vec::new(),
        }
    }

    pub(super) fn push(
        &mut self,
        direction: &'static str,
        bytes: Vec<u8>,
        created_at: u64,
    ) -> Option<Vec<WireFrame>> {
        if self.frames.is_empty() {
            self.started_at = created_at;
        }
        self.frames.push(WireFrame {
            message_type: None,
            framing: None,
            direction,
            peer_id: None,
            bytes,
            created_at,
        });
        (self.frames.len() >= FRAME_BATCH_LIMIT).then(|| self.take(created_at))
    }

    pub(super) fn flush_due(&mut self, now: u64) -> Option<Vec<WireFrame>> {
        (!self.frames.is_empty() && now.saturating_sub(self.started_at) >= FRAME_BATCH_MILLIS)
            .then(|| self.take(now))
    }

    pub(super) fn flush(&mut self) -> Option<Vec<WireFrame>> {
        (!self.frames.is_empty()).then(|| self.take(now_millis()))
    }

    fn take(&mut self, now: u64) -> Vec<WireFrame> {
        self.started_at = now;
        std::mem::take(&mut self.frames)
    }
}

pub(super) struct Framer {
    mode: ReceiveFraming,
    pub(super) pending: Vec<u8>,
    last_input_at: Option<u64>,
    failure: Option<SerialError>,
}

impl Framer {
    pub(super) fn new(mode: ReceiveFraming) -> Self {
        Self {
            mode,
            pending: Vec::new(),
            last_input_at: None,
            failure: None,
        }
    }

    pub(super) fn push(&mut self, bytes: &[u8], now: u64) -> Vec<Vec<u8>> {
        if bytes.is_empty() {
            return Vec::new();
        }
        match &self.mode {
            ReceiveFraming::Raw => vec![bytes.to_vec()],
            ReceiveFraming::Delimiter(delimiter) => {
                let delimiter = delimiter.clone();
                let mut frames = Vec::new();
                let mut remaining = bytes;
                while !remaining.is_empty() {
                    let available = MAX_PENDING_FRAME_BYTES - self.pending.len();
                    if available == 0 {
                        self.reject_overflow();
                        break;
                    }
                    let length = available.min(remaining.len());
                    let mut scan_start = self.pending.len().saturating_sub(delimiter.len() - 1);
                    self.append_bounded(&remaining[..length]);
                    remaining = &remaining[length..];
                    while let Some(offset) = find_subslice(&self.pending[scan_start..], &delimiter)
                    {
                        let index = scan_start + offset;
                        frames.push(self.pending[..index].to_vec());
                        self.pending.drain(..index + delimiter.len());
                        scan_start = 0;
                    }
                }
                frames
            }
            ReceiveFraming::Fixed(length) => {
                let length = *length;
                self.pending.extend_from_slice(bytes);
                let mut frames = Vec::new();
                while self.pending.len() >= length {
                    frames.push(self.pending.drain(..length).collect());
                }
                frames
            }
            ReceiveFraming::Idle(_) => {
                if bytes.len() > MAX_PENDING_FRAME_BYTES - self.pending.len() {
                    self.reject_overflow();
                    return Vec::new();
                }
                self.append_bounded(bytes);
                self.last_input_at = Some(now);
                Vec::new()
            }
        }
    }

    fn append_bounded(&mut self, bytes: &[u8]) {
        let required = self.pending.len() + bytes.len();
        if self.pending.capacity() < required {
            let capacity = required
                .max(self.pending.capacity().saturating_mul(2))
                .min(MAX_PENDING_FRAME_BYTES);
            self.pending.reserve_exact(capacity - self.pending.len());
        }
        self.pending.extend_from_slice(bytes);
    }

    fn reject_overflow(&mut self) {
        self.pending = Vec::new();
        self.last_input_at = None;
        self.failure = Some(SerialError::new(
            SerialErrorCode::IoError,
            format!(
                "Receive pending frame exceeds {} bytes; connection must be reopened",
                MAX_PENDING_FRAME_BYTES
            ),
        ));
    }

    pub(super) fn take_error(&mut self) -> Option<SerialError> {
        self.failure.take()
    }

    pub(super) fn flush_idle(&mut self, now: u64) -> Vec<Vec<u8>> {
        let ReceiveFraming::Idle(duration) = self.mode else {
            return Vec::new();
        };
        let elapsed = self
            .last_input_at
            .is_some_and(|last| now.saturating_sub(last) >= duration.as_millis() as u64);
        if elapsed && !self.pending.is_empty() {
            self.last_input_at = None;
            vec![std::mem::take(&mut self.pending)]
        } else {
            Vec::new()
        }
    }

    pub(super) fn flush(&mut self) -> Vec<Vec<u8>> {
        if self.pending.is_empty() {
            Vec::new()
        } else {
            self.last_input_at = None;
            vec![std::mem::take(&mut self.pending)]
        }
    }
}

fn find_subslice(haystack: &[u8], needle: &[u8]) -> Option<usize> {
    haystack
        .windows(needle.len())
        .position(|window| window == needle)
}
