# TCP Keepalive and Automatic Reconnection Design

## Goal

Improve TCP resilience without changing the existing transport wire contract:

- Enable operating-system TCP keepalive by default for TCP client connections and accepted TCP server peers.
- Let users disable keepalive or configure its first-probe delay.
- Let users opt TCP client endpoints into automatic reconnection with deterministic exponential backoff.
- Ensure explicit user actions always win over delayed or stale reconnect work.

Keepalive and automatic reconnection solve different failures. Keepalive helps the operating system eventually detect a half-open socket after power loss or network loss. Automatic reconnection reacts after a connection attempt fails or a connection is known to have ended. Neither feature sends application payloads or implements a `PING`/`PONG` protocol.

## Scope

In scope:

- TCP keepalive configuration for `tcp-client` and `tcp-server` endpoint sockets.
- Electron and Tauri socket-level keepalive setup.
- Automatic reconnection for `tcp-client` endpoints only.
- Shared reconnect scheduling and lifecycle state in the workbench model.
- Endpoint dialog controls and reconnecting status/actions.
- Unit, component, native-service, and localhost acceptance coverage.

Out of scope:

- Automatic restart of TCP server listeners.
- Automatic reconnection for serial or UDP endpoints.
- Application-level heartbeat messages.
- Configurable retry intervals, retry limits, jitter, or retry policies by error code.
- Restoring an active connection or reconnect countdown after application restart.
- A new connection timeout; an individual connect attempt retains the operating system/runtime timeout behavior.
- Configuring keepalive probe interval or failure count. Those values remain operating-system defaults.

## Endpoint Configuration

TCP endpoint configuration gains these fields:

```json
{
  "keepAlive": {
    "enabled": true,
    "initialDelaySeconds": 30
  },
  "autoReconnect": false
}
```

`keepAlive` is valid on both `tcp-client` and `tcp-server`. `autoReconnect` is valid only on `tcp-client`.

Compatibility and normalization rules:

- A missing `keepAlive` value normalizes to `{ "enabled": true, "initialDelaySeconds": 30 }`.
- A missing `autoReconnect` value normalizes to `false`.
- `keepAlive.enabled` must be a boolean.
- `keepAlive.initialDelaySeconds` must be an integer from 1 through 3600, including when keepalive is disabled. Keeping a valid stored delay means disabling and re-enabling the option does not discard the user's value.
- `autoReconnect` must be a boolean when present.
- TCP server drafts do not persist `autoReconnect`; native parsers ignore no reconnect policy because reconnection is not a native-runtime responsibility.
- Non-TCP endpoint shapes remain unchanged.

The shared endpoint-draft module owns normalization and renderer validation. Electron and Tauri independently validate the native fields before touching a socket, so imported or externally modified endpoint data cannot bypass the constraints.

## Architecture

Keepalive belongs to the native TCP services because it configures an operating-system socket. Automatic reconnection belongs to the shared workbench model because it is a user-intent and lifecycle policy that must behave identically in Electron and Tauri.

The implementation adds a focused shared module:

`packages/workbench/src/model/tcpReconnectController.js`

The controller owns only reconnect intent, retry state, timers, and operation identities. It does not call a runtime adapter directly and does not mutate endpoint collections. `createWorkbenchModel.js` injects callbacks that run each retry through the same open implementation and endpoint lifecycle coordinator used by `commands.open`. This preserves cancellation, operation/session filtering, command-error behavior, and native event validation.

The model factors the current open body into one internal `openEndpoint(endpointId, operationId, { origin })` path. Public `commands.open` calls it with `origin: "manual"`, which cancels any older generation and arms a new desired-open intent when policy permits. The controller calls it with `origin: "reconnect"`, which retains and validates the current generation. This source distinction is private to the shared model; the runtime `transport.open` signature does not change.

`createWorkbenchModel` exposes reconnect state as a map keyed by endpoint id. UI components consume snapshots from that map but cannot mutate the controller.

## Reconnect State Machine

Each TCP client endpoint has an independent controller record with:

- `generation`: monotonically increasing identity for the current reconnect intent.
- `desiredOpen`: whether the endpoint should still be connected.
- `phase`: `idle`, `waiting`, or `connecting`.
- `attempt`: the one-based retry attempt number; the first retry is attempt 1.
- `nextRetryAt`: epoch milliseconds while waiting, otherwise `null`.
- `operationId`: the identity of the active automatic attempt, otherwise `null`.
- `lastError`: the most recent normalized connection error, otherwise `null`.
- `timer`: the private timer handle, never exposed in public state.

The delay before retry attempt `n` is:

```text
min(500 * 2^(n - 1), 30000) milliseconds
```

There is no jitter. The resulting sequence is `0.5s, 1s, 2s, 4s, 8s, 16s, 30s, 30s, ...` and continues until connection succeeds or the intent is cancelled.

State transitions:

1. An explicit open of an auto-reconnect-enabled TCP client sets `desiredOpen = true` and starts the normal open flow immediately. It is not counted as a retry.
2. A failed connect or an accepted terminal `error`/`closed` event schedules attempt 1 when `desiredOpen` is still true.
3. The timer firing changes the phase to `connecting`, creates a fresh operation id, and invokes the shared internal open path with reconnect origin.
4. Another failed attempt increments `attempt` and schedules the next delay.
5. A successful `open` acknowledgement/status clears the visible reconnect state and resets the backoff. A later remote disconnect therefore starts again at 0.5 seconds.
6. Repeated `error` and `closed` signals for the same operation/session are deduplicated and cannot create parallel timers.
7. A terminal signal, timer callback, command result, or status event whose generation or operation/session identity is stale is ignored.

For a TCP client with `autoReconnect: false`, all open, error, and close behavior remains the current behavior and no controller record or timer is created. TCP servers never enter this state machine.

## User Intent and Cancellation

The controller is armed by an explicit open, not merely by endpoint configuration. Loading an endpoint whose saved configuration has `autoReconnect: true` does not connect it automatically.

The following actions disarm the endpoint, increment its generation, clear any timer, and prevent late events from rearming it:

- Explicit close.
- Explicit cancellation while opening or waiting to retry.
- Opening the endpoint editor.
- Saving edits to that endpoint.
- Deleting the endpoint.
- Workspace reset/import that invalidates the endpoint.
- Workbench disposal/application exit.

If an automatic connect attempt is already in flight, cancellation also goes through the existing lifecycle coordinator and native `cancelOpen` path. The controller never waits for the timer delay to finish before acknowledging cancellation.

An explicit manual open while a retry is waiting first cancels the old reconnect generation, then creates a new desired-open generation and starts immediately. Any callback from the old generation is inert. An explicit close marks `desiredOpen = false` before asking the runtime to close, so the resulting native `closed` event cannot schedule another connection.

Editing only cancels reconnect intent; it does not introduce new semantics for editing an already-open endpoint beyond the workbench's existing endpoint-edit behavior.

## Operation and Session Isolation

Every automatic attempt receives a new nonblank operation id. The default id factory combines a reconnect prefix, the current clock value, and a monotonic sequence. Tests inject the clock, timer API, and id factory so no test depends on wall-clock time.

Automatic attempts use the same internal open/lifecycle path as `model.commands.open(endpointId, operationId)`, with the private reconnect origin described above. Consequently:

- The lifecycle coordinator cancels or supersedes the previous intent.
- A successful runtime acknowledgement must return a valid session id.
- Frames, peers, and status events still have to match the active operation/session gate.
- A stale attempt cannot replace a newer manual operation.
- Duplicate operation ids remain rejected by the existing guard.

The reconnect controller additionally compares its own generation and automatic operation id before applying an asynchronous result. This second gate protects user intent even after native callbacks have already been queued.

## Native Keepalive Mapping

### Electron

The Electron TCP config parser normalizes and validates `keepAlive` alongside host, port, and receive framing.

- A client `net.Socket` calls `socket.setKeepAlive(enabled, initialDelaySeconds * 1000)` before the connection is reported as open.
- Every socket accepted by a TCP server receives the same endpoint keepalive setting before it is registered as a peer or starts reading.
- The listening `net.Server` itself is not a connected socket and receives no keepalive setting.
- `setNoDelay(true)` and existing read/framing behavior remain unchanged.

A client keepalive setup failure fails that open attempt through the existing TCP error status and can therefore trigger automatic reconnection. An accepted-peer setup failure closes only that peer, keeps the listener healthy, and emits a warning TCP log.

### Tauri

The Tauri crate adds a direct `socket2 = "0.6.4"` dependency, matching the version already present in `Cargo.lock`. The TCP config parser stores the normalized keepalive values.

For client streams and accepted peer streams, `configure_stream` uses `socket2::SockRef`:

- `set_keepalive(enabled)` controls the socket option.
- When enabled, `TcpKeepalive::new().with_time(Duration::from_secs(initialDelaySeconds))` is applied through `SockRef::set_tcp_keepalive` and configures only the first-probe delay.
- Probe interval and retry count are deliberately not set.

Keepalive is configured before a stream is cloned or exposed to a reader thread. A client setup failure follows the existing failed-open cleanup. An accepted-peer setup failure closes only that stream and records a warning without stopping the accept loop.

The supported production targets are macOS, Windows, and Linux. Tests must avoid asserting platform-specific interval or retry defaults.

## Event, Error, and Log Behavior

No runtime wire status is added. `opening`, `open`, `listening`, `error`, and `closed` retain their current meanings.

`reconnecting` is a workbench-derived UI state, not a native transport status. This avoids synthetic runtime events that would diverge from native persistence or weaken operation/session validation.

Each automatic attempt travels through the native open path, so the existing TCP connecting, connected, and failure logs remain the source of truth and continue to be persisted. The controller catches rejected command promises/results, stores the normalized `lastError`, and never creates an unhandled rejection. Duplicate terminal events do not duplicate timers or retry attempts.

When automatic reconnection is enabled, the latest failed attempt may remain visible as the endpoint command error while the retry state shows that another attempt is pending. A successful attempt clears that transport command error through the existing command runner. Cancellation does not report an error unless native cancellation itself fails.

Keepalive does not guarantee failure detection at exactly the configured delay. The first-probe delay only controls when the operating system may begin probing an otherwise idle connection; platform defaults determine subsequent probes and the final failure time.

## UI Behavior

The TCP section of `EndpointDialog.vue` gains a compact advanced-settings group:

- A keepalive checkbox/toggle, enabled by default.
- A numeric `首次探测延迟（秒）` input, default `30`, minimum `1`, maximum `3600`, disabled visually when keepalive is off while retaining its value.
- An `自动重连` checkbox/toggle shown only for TCP clients and disabled by default.

Opening legacy endpoints displays the normalized defaults. Saving writes the explicit normalized values, so subsequent opens behave consistently across runtimes.

Endpoint rows and the active session status bar derive these states from the controller map:

- `waiting`: show `等待重连（第 N 次）` and a cancel control.
- `connecting`: show `正在重连（第 N 次）` and a cancel control.
- Successful connection: return to the existing `已打开`/`已连接` state.
- Cancelled or disabled: return to the existing closed/error state with the normal open control.

The UI does not run its own retry timers and does not infer retry eligibility from an error string. It only renders controller state and invokes model actions.

## Testing

### Shared Model

- Endpoint draft normalization proves legacy defaults, explicit enabled/disabled values, integer boundaries, invalid types, and TCP-client-only auto reconnect.
- Controller tests use fake timers and deterministic ids to prove the exact delay sequence, 30-second cap, unlimited continuation, single timer ownership, and reset after success.
- Tests cover connect failure, normal remote close, abnormal error/close pairs, and duplicate terminal event deduplication.
- Tests cover cancellation by close, cancel-open, edit, save, delete, workspace reset/import, disposal, and manual open replacement.
- Race tests prove stale timers, stale command results, and stale operation/session events cannot reopen or overwrite a newer user action.
- Workbench integration tests prove every retry uses the existing open/lifecycle path and successful retries clear command errors.

### UI

- Endpoint dialog component tests cover defaults, conditional controls, retained delay, validation focus, editing legacy endpoints, and the saved config shape.
- Endpoint row and status-bar tests cover waiting, connecting, cancel, success, and disabled behavior.
- Playwright exercises a failed TCP client with auto reconnect enabled, cancels a pending retry, and verifies the endpoint remains stopped.

### Native Services

- Electron service tests assert `setKeepAlive` arguments for client and accepted-peer sockets, including disabled mode, default normalization, invalid input, and setup failure isolation.
- Tauri unit tests cover config normalization/validation and the keepalive configuration helper. Localhost tests cover enabled and disabled client/server sockets without depending on platform-specific probe timing.
- Existing TCP send, framing, multi-peer, shutdown, and open-cancellation suites remain green.

### Acceptance

- Start a client with auto reconnect enabled while its localhost target is unavailable; verify repeated attempts follow the expected backoff and connect after the server starts.
- Stop an established localhost server; verify the client returns to retry state and reconnects after the server restarts.
- Cancel during a retry wait; verify no later socket is opened and no managed child process remains.
- Run the acceptance flow for Electron and Tauri at supported test seams, plus the existing mixed-runtime transport gate.
- Keep `npm run verify:phase-05` green and extend it to include the focused reconnect/keepalive coverage and resource-leak checks.

Because half-open failure timing depends on the host operating system and network path, automated acceptance verifies correct socket configuration and reconnect behavior after an observable disconnect. It does not wait for a real cable-loss keepalive timeout.

## Implementation Order

1. Add shared TCP resilience normalization and endpoint-draft tests.
2. Add the deterministic reconnect controller with exhaustive state-machine tests.
3. Integrate the controller with workbench commands, lifecycle events, cancellation paths, and derived state.
4. Add endpoint dialog controls and reconnecting UI states.
5. Apply keepalive in the Electron TCP service and tests.
6. Apply keepalive through `socket2` in the Tauri TCP service and tests.
7. Extend Playwright, localhost acceptance, Phase 05 verification, and verification documentation.

## Fixed Decisions

- Keepalive defaults to enabled with a 30-second first-probe delay.
- The allowed first-probe delay is 1 through 3600 seconds.
- Operating-system keepalive interval and failure count remain untouched.
- Automatic reconnection defaults to disabled and applies only to TCP clients.
- Retry uses an exact, jitter-free exponential sequence capped at 30 seconds and has no attempt limit.
- Explicit user actions always cancel and supersede automatic work.
- Reconnect policy is shared-model behavior; native runtimes remain single-attempt socket services.
- `socket2` is the Tauri portability layer for keepalive configuration.
