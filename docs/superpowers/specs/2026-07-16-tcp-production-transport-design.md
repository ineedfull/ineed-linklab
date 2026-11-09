# TCP Production Transport Design

## Goal

Bring `tcp-client` and `tcp-server` endpoints up to the same production level as the completed serial transport. TCP must work in both Electron and Tauri with real sockets, shared runtime contracts, realtime frames, structured logs, peer lists for server connections, historical persistence, and real localhost acceptance probes.

Serial remains the baseline implementation and regression target. UDP remains out of scope for this spec and will follow as a separate milestone after TCP is verified.

## Scope

- Implement production TCP client and TCP server transports in Electron.
- Implement production TCP client and TCP server transports in Tauri.
- Route `transport.open`, `transport.close`, `transport.send`, and `transport.disconnectPeer` by endpoint transport instead of rejecting non-serial endpoints.
- Emit realtime `transport:frames`, `transport:status`, and `transport:peers` events for TCP.
- Persist TCP frames and structured logs through the existing native transport persistence pipeline.
- Reuse existing endpoint configuration UI and send-target UI, adding only the TCP receive-framing fields and listening-state display required by this spec.
- Add real localhost TCP acceptance tests for Electron and Tauri.

Out of scope:

- UDP client/server production implementation.
- TLS, proxying, SOCKS, HTTP protocol parsing, or packet inspection.
- Cross-machine manual network verification.
- Browser-side storage or direct renderer socket access.

## Existing Baseline

The workbench already recognizes these transport types:

- `serial`
- `tcp-client`
- `tcp-server`
- `udp-client`
- `udp-server`

Endpoint creation, validation, labels, send-panel target selection, endpoint peer display, frame peer filters, and history peer display already have TCP/UDP-facing UI concepts. The native runtimes are the missing layer: Electron `TransportCoordinator` and Tauri transport commands currently route production behavior only to serial services and reject or ignore non-serial transports.

The current wire normalizer and contract files are named around serial, and status log semantics currently require `source: "serial"`. TCP implementation must generalize this contract without breaking existing serial tests or UI behavior.

## User Model

### TCP Client

A TCP client endpoint represents one outgoing socket connection to a configured `host:port`.

- Opening connects to the remote address.
- Sending writes bytes to that socket.
- Incoming bytes appear as RX frames.
- Outgoing bytes appear as TX frames.
- Closing closes the socket and ends the session.
- Remote close or socket failure emits a terminal error/closed sequence with a structured TCP log.

### TCP Server

A TCP server endpoint represents one listening socket on `listenHost:listenPort`.

- Opening starts listening and creates a server session.
- Each accepted client becomes a peer under the endpoint.
- The endpoint tree shows active peers for the server.
- Sending can target one peer or all peers, matching the existing send panel model.
- Incoming frames include the peer id.
- Outgoing frames include the target peer id.
- `disconnectPeer` closes one accepted client without stopping the listening server.
- Closing the endpoint stops listening, closes all peers, flushes persistence, and clears peer state.

## Runtime Contract

The existing runtime method names remain unchanged:

- `transport.open`
- `transport.cancelOpen`
- `transport.close`
- `transport.send`
- `transport.disconnectPeer`
- `transport.onFrames`
- `transport.onStatus`
- `transport.onPeers`

The event payload shape also remains compatible:

- Frame batches keep `endpointId`, `operationId`, `sessionId`, and `frames`.
- Frames keep `direction`, `bytes`, and `createdAt`; normalized internal rows include `peerId` where relevant.
- Status events keep `endpointId`, `operationId`, `sessionId`, `status`, `error`, `createdAt`, and optional `log`.
- Peer events carry the active peer list for an endpoint/session.

Contract generalization:

- Add transport-level normalizer exports for frame, status, and peer events.
- Keep backwards-compatible serial-named exports as aliases for existing serial tests during the transition.
- Allow structured status logs with `source: "serial"` or `source: "tcp"` in this TCP milestone.
- Keep serial-specific error semantics intact.
- Use the existing stable error envelope for TCP errors. TCP maps connect, bind, read, write, and reset failures to the existing `IO_ERROR`, `PORT_BUSY`, `PERMISSION_DENIED`, and `PORT_NOT_FOUND` codes where their meaning fits; the implementation plan must introduce any new code explicitly if one is unavoidable.

Status values:

- `opening`: TCP client is connecting, or TCP server is binding/listening setup.
- `open`: TCP client connected.
- `listening`: TCP server is accepting clients.
- `closing`: endpoint or peer is closing.
- `closed`: endpoint closed.
- `error`: connect, bind, accept, read, or write failure.

The shared status enum must add `listening`. Existing serial behavior remains unchanged, and serial services must not emit `listening`.

## Native Architecture

### Electron

Add a production TCP service beside `SerialService`.

Responsibilities:

- Use Node `net.Socket` for TCP client endpoints.
- Use Node `net.Server` for TCP server endpoints.
- Maintain endpoint sessions, peer records, close ownership, and shutdown behavior.
- Emit status, frames, and peers through the same event sink used by serial.
- Use a shared or parallel frame batching strategy for TCP inbound/outbound bytes.
- Support send targets:
  - TCP client: no peer target, endpoint socket only.
  - TCP server: `{ peerId }` for one peer or `{ broadcast: true }` for all peers.
- Implement `disconnectPeer(endpointId, peerId)` for TCP server peers.

The Electron `TransportCoordinator` becomes a router over transport services:

- `serial` routes to `SerialService`.
- `tcp-client` and `tcp-server` route to `TcpService`.
- Unsupported transports still return controlled errors until their milestone is implemented.

### Tauri

Add a production TCP module beside `serial.rs`.

Responsibilities:

- Use `std::net::TcpStream` and `std::net::TcpListener` with worker threads, matching the current blocking-service style used by serial.
- Keep blocking socket work off command handlers.
- Mirror Electron session, peer, send, close, and shutdown semantics.
- Emit the same transport wire events and persistence events as Electron.
- Implement `disconnect_peer` for server peer sockets.

The Tauri transport command layer routes by endpoint transport:

- `serial` routes to `SerialService`.
- `tcp-client` and `tcp-server` route to the new TCP service.
- UDP remains unavailable with a controlled error until the UDP milestone.

## Framing

TCP is a byte stream, so received data must use explicit frame boundaries.

The first TCP milestone reuses the existing receive-framing configuration already available for serial:

- `raw`
- `delimiter`
- `fixed`
- `idle`

For TCP client and TCP server endpoint configs, `receiveFraming` is optional and defaults to `{ mode: "raw" }`, matching legacy serial behavior. The endpoint dialog must expose the same receive-framing controls for TCP endpoints that it exposes for serial endpoints, using TCP wording where needed. Tests must verify at least raw and delimiter behavior for TCP.

## Logs

TCP structured logs use `source: "tcp"`.

Required lifecycle intents:

| Event | Level | Message intent |
| --- | --- | --- |
| client connecting | `debug` | Connecting to remote host |
| client connected | `info` | TCP connection established |
| server binding/listening | `debug` | Starting TCP listener |
| server listening | `info` | TCP listener started |
| peer accepted | `info` | TCP peer connected |
| endpoint closing | `debug` | Closing TCP endpoint |
| endpoint closed | `info` | TCP endpoint closed |
| peer disconnected | `info` | TCP peer disconnected |
| connect/bind/read/write failure | `error` | TCP operation failed |
| remote close/reset | `warn` | TCP peer disconnected unexpectedly |

The exact message text can remain Chinese, consistent with existing serial runtime messages. Error codes should remain stable and contract-tested.

## Persistence

TCP uses the existing persistence tables:

- `transfer_frames`
- `runtime_logs`

Rows must keep:

- `endpoint_id`
- `session_id`
- `peer_id` for TCP server peer traffic
- `direction`
- `payload`
- `byte_count`
- `created_at`
- structured log fields

The runtime-history millisecond validation added in the previous milestone applies unchanged. TCP services must capture one epoch-millisecond timestamp per event and pass it through to persistence without reading a second clock for the corresponding status log.

## UI Behavior

No large redesign is required.

Expected behavior:

- TCP client rows open/close/send like serial rows.
- TCP server rows show nested peers when connected clients exist.
- Selecting a server peer filters messages and selects the send target.
- Send panel target selector supports one peer or all peers for TCP server.
- History views show peer ids / remote addresses for TCP server traffic.
- Empty peer states remain factual, not instructional.

Only small UI changes are allowed if needed to expose TCP receive framing or clarify TCP server listening state.

## Error Handling

- Connect failure returns a controlled transport error and emits an error status/log.
- Bind failure returns a controlled transport error and does not leave a half-open server.
- Remote peer disconnect updates peers and emits logs without closing the whole server.
- TCP server endpoint close closes every peer before completing.
- Persistence failures do not kill a healthy TCP socket or listener.
- Shutdown and force shutdown close all TCP sockets/listeners and then flush/dispose persistence.
- Renderer event validation failures remain isolated and cannot mutate workbench state.

## Verification

Focused tests:

- Runtime contract tests for TCP frame/status/peer events and `source: "tcp"` logs.
- Electron TCP service tests for client connect, server listen, peer accept, send, receive, close, peer disconnect, and shutdown.
- Tauri TCP service tests with equivalent coverage.
- Transport coordinator tests verifying routing for serial vs TCP and controlled UDP unavailability.
- Persistence tests proving TCP frames/logs are stored with exact timestamps and peer ids.
- Workbench model/component tests proving peer events, TCP server target selection, and history peer display.

Real acceptance:

- Electron localhost TCP client/server loopback.
- Tauri localhost TCP client/server loopback.
- At least one mixed Electron/Tauri localhost pair:
  - Electron client to Tauri server, or
  - Tauri client to Electron server.

Gate:

- Existing `npm run verify:phase-03` remains green.
- A new TCP verification command or Phase 04 gate must run unit, Rust, E2E, and real TCP acceptance checks.

## Implementation Order

1. Generalize shared runtime event contracts and tests from serial-only logs to transport logs.
2. Implement Electron TCP client/server service and coordinator routing.
3. Implement Tauri TCP client/server service and command routing.
4. Connect persistence, peer events, and shutdown behavior.
5. Add workbench peer/send/history coverage.
6. Add real TCP acceptance probes and verification documentation.

## Plan Decisions

- TCP server wire status uses `listening`.
- TCP endpoint dialogs expose receive-framing controls.
- TCP acceptance includes same-runtime loopbacks and at least one mixed Electron/Tauri pair.
