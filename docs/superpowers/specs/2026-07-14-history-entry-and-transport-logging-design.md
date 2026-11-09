# History Entry And Transport Logging Design

## Goal

Move history access from the endpoint sidebar into the realtime message and log toolbar, make serial lifecycle logs visible with bilingual level labels, and persist transport frames and logs consistently in Electron and Tauri.

## Scope

- Remove the message-history and log-history buttons from the sidebar footer.
- Add one context-sensitive history button immediately before the realtime clear button.
- Display log levels as `DEBUG 调试`, `INFO 信息`, `WARN 警告`, and `ERROR 错误` everywhere.
- Generate structured logs for serial open, close, and failure transitions.
- Persist incoming/outgoing frames and structured logs in both desktop runtimes.
- Keep realtime clearing independent from historical deletion.

TCP and UDP production transport implementations remain outside this change.

## Toolbar Behavior

`FrameToolbar` owns the history entry because it already owns the active message/log view.

- In the message view, the button uses the history/file-clock icon and is labelled `打开消息历史`.
- In the log view, the button uses the log-history icon and is labelled `打开日志历史`.
- The history button appears immediately before `清空实时视图`.
- Clicking emits a history event with `frames` or `logs` according to the active view.
- `DevToolShell` remains responsible for calling `runtime.window.openHistory` and supplies the active endpoint ID when one is selected.
- The sidebar footer retains only Settings, About, and the runtime label. Its expanded and collapsed layouts must remain stable.

## Log Presentation

One shared level-label helper maps levels to bilingual labels:

| Value | Label |
| --- | --- |
| `debug` | `DEBUG 调试` |
| `info` | `INFO 信息` |
| `warn` / `warning` | `WARN 警告` |
| `error` | `ERROR 错误` |

The helper is used by realtime logs, history filters, history tables, history details, and the Settings log-level selector. Persisted values remain lowercase canonical values; only presentation changes.

## Structured Serial Logs

The existing status event keeps its optional `log` field. Native runtimes produce a log together with each meaningful status transition, and the runtime contract validates it instead of replacing it with `null`.

Required fields:

- `level`
- `source` with value `serial`
- `message`
- `createdAt`
- optional `code`
- optional plain-data `details`

Lifecycle mapping:

| Transition | Level | Message intent |
| --- | --- | --- |
| `opening` | `debug` | Opening the configured serial port |
| `open` | `info` | Serial port opened |
| `closing` | `debug` | Closing the serial port |
| normal `closed` | `info` | Serial port closed |
| unexpected removal/close | `warn` | Device disconnected unexpectedly |
| open/read/write failure | `error` | Operation failed, with stable error code |

An error followed by terminal closure must not create a misleading normal-close INFO entry. The terminal close log is DEBUG or omitted for that failure cycle.

Electron and Tauri implementations are checked against shared contract fixtures so level, source, code, and lifecycle semantics cannot drift.

## Historical Persistence

Transport persistence runs in the native/runtime layer, not in Vue components.

- Every normalized frame is queued for `transfer_frames`.
- Every non-null structured status log is queued for `runtime_logs`.
- Queues flush after one second or 200 rows, whichever occurs first.
- Writes are serialized and bounded. Overflow and exhausted retries are reported without blocking transport delivery.
- Transport events continue to reach the renderer even when persistence fails.
- Graceful close, application shutdown, history clear, and workspace import flush pending rows before completing their operation.
- History clear removes only historical frames, logs, and send history. Endpoint profiles and settings remain intact.

Electron extends the existing SQLite repository and uses the shared batching utility. Tauri adds equivalent Rust batch inserts and queue behavior around its existing database transaction boundary. Runtime contract tests use fixed event sequences and assert identical stored rows in both implementations.

## Data Flow

1. Native serial service changes state or receives/sends a frame.
2. The runtime creates the wire event and an optional structured log.
3. The persistence coordinator snapshots and queues historical rows.
4. The event is forwarded to the renderer immediately.
5. The workbench updates bounded realtime state.
6. The history window queries committed SQLite rows independently.

No browser storage is introduced.

## Error Handling

- Invalid wire logs are rejected at the runtime adapter boundary without mutating workbench state.
- Persistence failures never close an otherwise healthy serial session.
- Persistence error reporting must not enqueue another persistence log recursively.
- Device removal retains the stable `DEVICE_REMOVED` code and is displayed as WARN unless a more specific I/O failure was already emitted as ERROR.
- Opening history remains available with zero rows and displays the existing factual empty state.

## Verification

- Component tests verify sidebar removal, context-sensitive history buttons, button order, emitted history kind, and bilingual labels.
- Runtime contract tests verify every lifecycle-to-log mapping and malformed log rejection.
- Electron and Tauri persistence tests verify batching at 200 rows, one-second flush, shutdown flush, retry behavior, and exact historical counts.
- Virtual PTY acceptance tests verify open, send, echo, close, realtime counters, generated logs, and matching history rows.
- Full unit/component tests, lint, Electron/Tauri builds, Rust tests, and E2E tests must pass.
