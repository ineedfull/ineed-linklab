# Cross-Runtime Client/Server Acceptance Design

## Goal

Extend the TCP and UDP localhost acceptance probes so both production transport
implementations are tested against each other in both client/server directions:

1. Electron client to Rust/Tauri server (existing).
2. Rust/Tauri client to Electron server (new).

The tests must exercise the real transport services, not substitute sockets for
either application runtime.

## Scope

The change is limited to the existing acceptance harnesses and the ignored Rust
transport contract probes:

- `tooling/tcp-test/localhost-loopback.mjs`
- `tooling/udp-test/localhost-loopback.mjs`
- `apps/tauri/src-tauri/src/tcp.rs`
- `apps/tauri/src-tauri/src/udp.rs`

No production transport behavior, UI, endpoint persistence, or serial testing
is changed.

## Test Architecture

For each protocol, the Node acceptance harness starts an Electron server using
the production Electron transport service. The server binds to localhost on an
ephemeral port and reports that port to a Rust test child process through an
environment variable.

The Rust child runs the existing ignored transport contract test in a new
`client` mode. It opens the production Rust/Tauri client endpoint, sends a
fixed request payload, waits for the Electron response payload, closes the
endpoint, and emits a machine-readable result line.

The Electron harness waits for the request frame, verifies peer attribution,
sends the fixed response to that peer, waits for the Rust child to exit, and
combines both sides' frame and log counts into the acceptance summary.

TCP and UDP use separate mode names and result prefixes consistent with their
existing server probes.

## Assertions

Each new scenario must verify:

- The Rust/Tauri client reaches the Electron server on the announced port.
- Electron records the exact inbound request bytes.
- Rust/Tauri records the exact inbound response bytes.
- Electron server frames include the discovered peer identifier.
- Transport logs use the expected `tcp` or `udp` source.
- Both endpoints close normally.
- The child process exits successfully.
- `managedChildren` is empty after the complete acceptance run.

The top-level TCP and UDP summaries will contain four scenarios each:

1. Electron loopback.
2. Rust/Tauri loopback.
3. Electron client to Rust/Tauri server.
4. Rust/Tauri client to Electron server.

## Error Handling

Readiness and result lines retain bounded timeouts. Any assertion failure,
unexpected child exit, or timeout terminates the managed process group. The
existing final cleanup remains responsible for closing Electron services and
removing every tracked child.

## Verification

Implementation will follow a red-green sequence:

1. Add the new scenario expectation to each Node acceptance harness and confirm
   it fails because Rust client mode/result output is missing.
2. Add the minimal Rust client probe and Electron server orchestration.
3. Run the standalone TCP and UDP localhost acceptance commands.
4. Run `npm run verify:phase-05` to confirm the broader transport and UI suite.
5. Confirm a clean process state and inspect the final Git diff.
