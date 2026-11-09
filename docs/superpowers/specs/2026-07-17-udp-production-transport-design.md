# UDP Production Transport Design

## Goal

Bring `udp-client` and `udp-server` endpoints up to the same production level as the completed serial and TCP transports. UDP must work in both Electron and Tauri with real sockets, shared runtime contracts, realtime frames, structured logs, peer lists for server endpoints, historical persistence, and real localhost acceptance probes.

Serial and TCP remain the baseline implementations and regression targets.

## Scope

- Implement production UDP client and UDP server transports in Electron.
- Implement production UDP client and UDP server transports in Tauri.
- Route `transport.open`, `transport.close`, `transport.send` by endpoint transport for UDP.
- Emit realtime `transport:frames`, `transport:status`, and `transport:peers` events for UDP.
- Persist UDP frames and structured logs through the existing native transport persistence pipeline.
- Add `receiveFraming` controls to the UDP endpoint dialog, matching TCP.
- Add real localhost UDP acceptance tests for Electron and Tauri.

Out of scope:

- TLS, DTLS, multicast, broadcast (beyond `send` to all known peers), or packet inspection.
- Cross-machine manual network verification.
- `disconnectPeer` for UDP server (UDP is connectionless; peers are tracked passively from incoming traffic, not managed).

## User Model

### UDP Client

A UDP client endpoint represents one local socket bound to `bindHost:bindPort` with a required default target `targetHost:targetPort`.

- Opening binds the local socket.
- Sending writes a datagram to the default target.
- Incoming datagrams appear as RX frames.
- Outgoing datagrams appear as TX frames.
- Closing closes the socket and ends the session.
- No peer list (single default target, like TCP client).

### UDP Server

A UDP server endpoint represents one local socket bound to `bindHost:bindPort`.

- Opening binds the local socket and starts receiving.
- Each remote that sends a datagram becomes a peer under the endpoint.
- Sending can target one peer, all peers (broadcast), or the optional default target.
- Incoming frames include the peer id (derived from the remote address).
- Outgoing frames include the target peer id.
- Closing the endpoint closes the socket, flushes persistence, and clears peer state.
- `disconnectPeer` is unavailable for UDP server; peers are passive and derived from incoming traffic.

## Runtime Contract

- Add `source: "udp"` to allowed structured log sources alongside `serial` and `tcp`.
- UDP events use the same frame, status, and peer event shapes as serial and TCP.
- Frame `peerId` is used for UDP server peer traffic, matching TCP server semantics.

Status values:

- `opening`: UDP socket is being bound.
- `open`: UDP client socket is bound and ready.
- `listening`: UDP server socket is bound and receiving.
- `closing`: endpoint is closing.
- `closed`: endpoint closed.
- `error`: bind, read, or write failure.

## Native Architecture

### Electron

Add a production UDP service beside `TcpService`.

- Use Node `dgram` module (`createSocket('udp4')`).
- UDP client: bind, set default target, send/receive datagrams.
- UDP server: bind, track remote addresses as peers, send to specific or all peers.
- Emit status, frames, and peers through the same event sink.
- Support send targets: UDP client uses default target only; UDP server supports `{ peerId }`, `{ broadcast: true }`, or default target.

### Tauri

Add a production UDP module beside `tcp.rs`.

- Use `std::net::UdpSocket` with worker threads, matching the blocking-service style.
- Mirror Electron session, peer, send, close, and shutdown semantics.
- Emit the same transport wire events and persistence events.

## Framing

UDP datagrams are atomic messages. Each received datagram produces one frame in `raw` mode (the default). The existing receive-framing configuration (`raw`, `delimiter`, `fixed`, `idle`) is supported for consistency; in practice each datagram is fed to the framer, and `raw` mode produces one frame per datagram.

## Logs

UDP structured logs use `source: "udp"`.

Required lifecycle intents:

| Event | Level | Message intent |
| --- | --- | --- |
| client binding | `debug` | Binding UDP socket |
| client bound | `info` | UDP client ready |
| server binding | `debug` | Binding UDP socket |
| server listening | `info` | UDP server listening |
| peer seen | `info` | UDP peer discovered |
| endpoint closing | `debug` | Closing UDP endpoint |
| endpoint closed | `info` | UDP endpoint closed |
| bind/read/write failure | `error` | UDP operation failed |
| remote error | `warn` | UDP socket error |

## Persistence

UDP uses the existing persistence tables (`transfer_frames`, `runtime_logs`) with the same fields as TCP, including `peer_id` for UDP server peer traffic.

## UI Behavior

- UDP client rows open/close/send like TCP client rows.
- UDP server rows show nested peers when remotes have sent data.
- Selecting a server peer filters messages and selects the send target.
- Send panel target selector supports one peer or all peers for UDP server.
- UDP endpoint dialog exposes `receiveFraming` controls, matching TCP.

## Verification

- Runtime contract tests for UDP frame/status/peer events and `source: "udp"` logs.
- Electron UDP service tests for client bind, server listen, peer discovery, send, receive, close, and shutdown.
- Tauri UDP service tests with equivalent coverage.
- Transport coordinator tests verifying routing for UDP and controlled unavailability of `disconnectPeer`.
- Persistence tests proving UDP frames/logs are stored with exact timestamps and peer ids.
- Real acceptance: Electron localhost UDP loopback, Tauri localhost UDP loopback, at least one mixed pair.
- New `verify:phase-05` gate.
