# TCP Production Transport Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement production TCP client and TCP server transports for Electron and Tauri with realtime frames, structured logs, peer lists, persistence, and real localhost acceptance.

**Architecture:** Keep serial as the proven baseline and add TCP beside it, not inside it. Generalize shared runtime event contracts from serial-only to transport-wide events, then route native commands by endpoint transport. TCP server peers use the existing `peerId` and `transport:peers` model, while persistence continues to use the existing frame/log tables.

**Tech Stack:** Vue 3, Node.js test runner, Vitest, Playwright, Electron, Node `net`, Rust `std::net`, Tauri 2, `rusqlite`, localhost TCP acceptance probes.

---

## File Structure

- Create `apps/electron/electron/tcpService.cjs`: Electron TCP client/server service using Node `net`.
- Create `apps/electron/tests/tcpService.test.js`: Electron TCP unit/integration tests with fake sockets and real localhost sockets.
- Modify `apps/electron/electron/transportCoordinator.cjs`: route serial vs TCP vs unsupported UDP.
- Modify `apps/electron/electron/main.cjs`: instantiate `TcpService`, wire shared persistence sink, and include TCP in shutdown.
- Modify `apps/electron/renderer/serialWireNormalizer.js`: re-export generalized transport normalizers while preserving serial-named exports.
- Modify `apps/electron/tests/serialService.test.js`: update coordinator tests for TCP routing and UDP controlled unavailability.
- Create `apps/tauri/src-tauri/src/tcp.rs`: Tauri TCP service using blocking sockets and worker threads.
- Modify `apps/tauri/src-tauri/src/lib.rs`: manage TCP service, include it in shutdown.
- Modify `apps/tauri/src-tauri/src/transport.rs`: route commands by endpoint transport and implement TCP `disconnectPeer`.
- Test in `apps/tauri/src-tauri/src/tcp.rs` and `apps/tauri/src-tauri/src/transport.rs`: Rust TCP service and command routing tests.
- Modify `packages/runtime-contract/src/serialWireNormalizer.js`: generalized transport event validation with `source: serial|tcp` and `status: listening`.
- Modify `packages/runtime-contract/src/index.js`: export transport normalizer aliases.
- Modify `packages/test-contracts/fixtures/serialRuntimeContract.js`: rename/generic helpers while retaining serial exports.
- Modify `packages/test-contracts/fixtures/serialRuntimeCases.json`: add TCP event fixtures.
- Modify `packages/runtime-contract/tests/runtimeContract.test.js` and related tests: TCP contract coverage.
- Modify `packages/workbench/src/model/createWorkbenchModel.js`: allow `listening` status and `source: tcp`.
- Modify `packages/workbench/src/model/endpointDraft.js` and `packages/workbench/src/components/EndpointDialog.vue`: expose TCP receive-framing controls.
- Modify workbench component/model tests: endpoint draft, send target, peer events, TCP history display.
- Create `tooling/tcp-test/localhost-loopback.mjs`: real TCP acceptance orchestrator for Electron/Tauri and mixed runtime pair.
- Modify `package.json`: add `verify:phase-04` gate.
- Create `docs/verification/phase-04.md`: verification evidence for TCP.

## Task 1: Generalize Runtime Transport Contracts

**Files:**
- Modify: `packages/runtime-contract/src/serialWireNormalizer.js`
- Modify: `packages/runtime-contract/src/index.js`
- Modify: `packages/runtime-contract/tests/runtimeContract.test.js`
- Modify: `packages/test-contracts/fixtures/serialRuntimeContract.js`
- Modify: `packages/test-contracts/fixtures/serialRuntimeCases.json`
- Modify: `apps/electron/renderer/serialWireNormalizer.js`
- Test: `packages/runtime-contract/tests/runtimeContract.test.js`
- Test: `apps/electron/tests/serialService.test.js`

- [ ] **Step 1: Write failing transport contract tests**

Add tests that prove:

```js
import {
  normalizeTransportFrameBatch,
  normalizeTransportStatusEvent,
  normalizeTransportPeerEvent,
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
} from '../src/index.js';

test('transport status accepts TCP source and listening status while serial aliases remain', () => {
  const event = normalizeTransportStatusEvent({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_000,
    log: {
      level: 'info',
      source: 'tcp',
      code: null,
      message: 'TCP 服务已监听: 127.0.0.1:41000',
      details: { listenHost: '127.0.0.1', listenPort: 41000 },
      createdAt: 1_720_000_000_000,
    },
  });
  assert.equal(event.status, 'listening');
  assert.equal(event.log.source, 'tcp');
  assert.equal(normalizeStatusWireEvent, normalizeTransportStatusEvent);
  assert.equal(normalizeFrameWireBatch, normalizeTransportFrameBatch);
});

test('transport peers validate exact TCP server peer records', () => {
  assert.deepEqual(normalizeTransportPeerEvent({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    peers: [{
      id: 'peer-1',
      remoteAddress: '127.0.0.1:51000',
      connectedAt: 1_720_000_000_001,
    }],
  }), {
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    peers: [{
      id: 'peer-1',
      remoteAddress: '127.0.0.1:51000',
      connectedAt: 1_720_000_000_001,
    }],
  });
});
```

- [ ] **Step 2: Run contract tests and verify RED**

Run:

```bash
node --test packages/runtime-contract/tests/runtimeContract.test.js apps/electron/tests/serialService.test.js
```

Expected: FAIL because `normalizeTransport*` exports do not exist, `listening` is rejected, and `source: "tcp"` is rejected.

- [ ] **Step 3: Implement generalized normalizers**

In `packages/runtime-contract/src/serialWireNormalizer.js`, add:

```js
const TRANSPORT_SOURCES = new Set(['serial', 'tcp']);
const STATUS_VALUES = new Set(['opening', 'open', 'listening', 'closing', 'closed', 'error']);

export function normalizeTransportFrameBatch(value) {
  return normalizeFrameWireBatch(value);
}

export function normalizeTransportStatusEvent(value) {
  return normalizeStatusWireEvent(value);
}

export function normalizeTransportPeerEvent(value) {
  const event = snapshotWirePayload(value);
  requireExactRecord(event, ['endpointId', 'operationId', 'sessionId', 'peers'], 'peer event');
  requireIdentity(event, 'peer event');
  const peers = readDenseArray(event.peers, 'peer event.peers').map((peer) => {
    requireExactRecord(peer, ['id', 'remoteAddress', 'connectedAt'], 'peer');
    requireId(peer.id, 'peer.id');
    requireId(peer.remoteAddress, 'peer.remoteAddress');
    requireTimestamp(peer.connectedAt, 'peer.connectedAt');
    return Object.freeze({
      id: peer.id,
      remoteAddress: peer.remoteAddress,
      connectedAt: peer.connectedAt,
    });
  });
  return Object.freeze({
    endpointId: event.endpointId,
    operationId: event.operationId,
    sessionId: event.sessionId,
    peers: Object.freeze(peers),
  });
}
```

Update status validation:

```js
if (!TRANSPORT_SOURCES.has(log.source)) {
  throw new TypeError('status log.source must be serial or tcp');
}
if (event.status === 'listening') {
  if (event.sessionId === null) throw new TypeError('listening status requires a sessionId');
  if (log.level !== 'info' || log.code !== null) {
    throw new TypeError('listening status log must use info without a code');
  }
  return;
}
```

Keep the existing serial-named functions exported as aliases.

- [ ] **Step 4: Export aliases**

In `packages/runtime-contract/src/index.js`, export the new names:

```js
export {
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
  normalizeTransportFrameBatch,
  normalizeTransportStatusEvent,
  normalizeTransportPeerEvent,
} from './serialWireNormalizer.js';
```

In `apps/electron/renderer/serialWireNormalizer.js`, re-export both serial and transport names from the runtime contract.

- [ ] **Step 5: Run contract tests and verify GREEN**

Run:

```bash
node --test packages/runtime-contract/tests/runtimeContract.test.js apps/electron/tests/serialService.test.js
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/runtime-contract/src/serialWireNormalizer.js \
  packages/runtime-contract/src/index.js \
  packages/runtime-contract/tests/runtimeContract.test.js \
  packages/test-contracts/fixtures/serialRuntimeContract.js \
  packages/test-contracts/fixtures/serialRuntimeCases.json \
  apps/electron/renderer/serialWireNormalizer.js \
  apps/electron/tests/serialService.test.js
git commit -m "feat: generalize transport wire events"
```

## Task 2: Workbench TCP Status, Peers, And Framing UI

**Files:**
- Modify: `packages/workbench/src/model/createWorkbenchModel.js`
- Modify: `packages/workbench/src/model/endpointDraft.js`
- Modify: `packages/workbench/src/components/EndpointDialog.vue`
- Modify: `packages/workbench/src/components/SessionStatusBar.vue`
- Test: `packages/workbench/tests/endpointDraft.test.js`
- Test: `packages/workbench/tests/components/EndpointDialog.test.js`
- Test: `packages/workbench/tests/components/SendPanel.test.js`
- Test: `packages/workbench/tests/createWorkbenchModel.test.js`
- Test: `packages/workbench/tests/uiContract.test.js`

- [ ] **Step 1: Write failing workbench tests**

Add tests that assert:

```js
test('workbench accepts TCP listening status and tcp structured logs', () => {
  const runtime = createRuntimeHarness();
  const model = createWorkbenchModel(runtime.adapter);
  model.replaceEndpoints([{ id: 'tcp-server-1', name: 'TCP Server', transport: 'tcp-server', config: {} }]);
  model.selectEndpoint('tcp-server-1');
  model.beginOpen('tcp-server-1', 'open-tcp-server-1');
  runtime.emitStatus({
    endpointId: 'tcp-server-1',
    operationId: 'open-tcp-server-1',
    sessionId: 'tcp-server-1-session',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_000,
    log: {
      level: 'info',
      source: 'tcp',
      code: null,
      message: 'TCP 服务已监听: 127.0.0.1:41000',
      details: { listenHost: '127.0.0.1', listenPort: 41000 },
      createdAt: 1_720_000_000_000,
    },
  });
  assert.equal(model.state.statuses.get('tcp-server-1').status, 'listening');
  assert.equal(model.visibleLogs[0].source, 'tcp');
});
```

Add EndpointDialog tests that TCP client/server show receive-framing controls:

```js
mountDialog({ endpoint: tcpEndpoint('tcp-a') });
expect(document.querySelector('select[name="tcp-receive-framing"]')).not.toBeNull();
await setValue('select[name="tcp-receive-framing"]', 'delimiter');
await setValue('input[name="tcp-receive-delimiter"]', '0D 0A');
button('保存').click();
expect(saveCommand.mock.calls[0][0].config.receiveFraming).toEqual({
  mode: 'delimiter',
  delimiterBytes: [0x0d, 0x0a],
});
```

- [ ] **Step 2: Run workbench tests and verify RED**

Run:

```bash
node --test packages/workbench/tests/endpointDraft.test.js packages/workbench/tests/createWorkbenchModel.test.js packages/workbench/tests/uiContract.test.js
npm run test:components -w @ineed-dev-tool/workbench -- --run tests/components/EndpointDialog.test.js tests/components/SendPanel.test.js
```

Expected: FAIL because `listening` and `source: tcp` are rejected or TCP framing controls are missing.

- [ ] **Step 3: Implement model and UI changes**

In `createWorkbenchModel.js`:

```js
const transportStatusValues = new Set(['opening', 'open', 'listening', 'closing', 'closed', 'error']);
const transportLogSources = new Set(['serial', 'tcp']);
```

Use these sets in status/log snapshots.

In `endpointDraft.js`, reuse `validateReceiveFraming(config)` for `tcp-client` and `tcp-server`:

```js
case 'tcp-client':
  return {
    ...validateHostAndPort(config, 'host', 'port', '服务器地址', '服务器端口'),
    ...validateReceiveFraming(config),
  };
case 'tcp-server':
  return {
    ...validateHostAndPort(config, 'listenHost', 'listenPort', '监听地址', '监听端口'),
    ...validateReceiveFraming(config),
  };
```

In `EndpointDialog.vue`, render TCP receive-framing controls with names:

- `tcp-receive-framing`
- `tcp-receive-delimiter`
- `tcp-receive-length`
- `tcp-receive-idle-ms`

Normalize saved TCP config with `receiveFraming`.

In `SessionStatusBar.vue`, map `listening` to a factual Chinese label such as `监听中`.

- [ ] **Step 4: Run workbench tests and verify GREEN**

Run the Step 2 commands. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/workbench/src/model/createWorkbenchModel.js \
  packages/workbench/src/model/endpointDraft.js \
  packages/workbench/src/components/EndpointDialog.vue \
  packages/workbench/src/components/SessionStatusBar.vue \
  packages/workbench/tests/endpointDraft.test.js \
  packages/workbench/tests/createWorkbenchModel.test.js \
  packages/workbench/tests/components/EndpointDialog.test.js \
  packages/workbench/tests/components/SendPanel.test.js \
  packages/workbench/tests/uiContract.test.js
git commit -m "feat: prepare workbench for TCP transport"
```

## Task 3: Electron TCP Service

**Files:**
- Create: `apps/electron/electron/tcpService.cjs`
- Create: `apps/electron/tests/tcpService.test.js`
- Modify: `apps/electron/electron/transportCoordinator.cjs`
- Modify: `apps/electron/electron/main.cjs`
- Test: `apps/electron/tests/tcpService.test.js`
- Test: `apps/electron/tests/serialService.test.js`

- [ ] **Step 1: Write failing Electron TCP service tests**

Create `apps/electron/tests/tcpService.test.js` with tests for client connect, server listen, peer accept, send, receive, close, peer disconnect, and shutdown. Use real localhost sockets for the integration path:

```js
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';

const require = (await import('node:module')).createRequire(import.meta.url);
const { TcpService } = require('../electron/tcpService.cjs');

function createHarness() {
  const events = [];
  let timestamp = 1_720_000_000_000;
  const service = new TcpService({
    clock: () => timestamp++,
    emitEvent: (channel, payload) => events.push({ channel, payload }),
  });
  return { service, events };
}

test('TCP client connects to a real localhost server and persists frame-shaped events', async (t) => {
  const server = net.createServer((socket) => {
    socket.on('data', (bytes) => socket.write(Buffer.from([0x41, ...bytes])));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => server.close());
  const { port } = server.address();
  const { service, events } = createHarness();
  t.after(async () => { await service.shutdown(); });

  await service.open({
    id: 'tcp-client-1',
    name: 'TCP Client',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'open-client' });
  await service.send({ endpointId: 'tcp-client-1', bytes: Uint8Array.of(0x31, 0x32) });
  await eventually(() => payloads(events, 'transport:frames').some((batch) => (
    batch.frames.some((frame) => frame.direction === 'in')
  )));
  assert.equal(payloads(events, 'transport:status').at(-1).status, 'open');
  assert.deepEqual(
    payloads(events, 'transport:frames').flatMap((batch) => batch.frames).map((frame) => frame.direction),
    ['out', 'in'],
  );
});
```

Add routing tests in `serialService.test.js`:

```js
test('transport coordinator routes TCP endpoints and keeps UDP unavailable', async () => {
  const tcpService = {
    open: async (endpoint, options) => ({ sessionId: `${endpoint.id}-session`, operationId: options.operationId }),
    close: async (endpointId) => ({ closed: true, endpointId }),
    send: async (request) => ({ sent: request.bytes.length }),
    disconnectPeer: async (endpointId, peerId) => ({ disconnected: true, endpointId, peerId }),
    shutdown: async () => {},
    forceShutdown: async () => [],
  };
  const coordinator = new TransportCoordinator({
    serialService: fakeSerialService(),
    tcpService,
    database: { listEndpoints: () => [
      { id: 'tcp-client-1', transport: 'tcp-client', config: {} },
      { id: 'udp-client-1', transport: 'udp-client', config: {} },
    ] },
  });
  assert.equal((await coordinator.open('tcp-client-1', { operationId: 'open-tcp' })).sessionId, 'tcp-client-1-session');
  await assert.rejects(coordinator.open('udp-client-1', { operationId: 'open-udp' }), (error) => error.code === 'IO_ERROR');
});
```

- [ ] **Step 2: Run Electron TCP tests and verify RED**

Run:

```bash
node --test apps/electron/tests/tcpService.test.js apps/electron/tests/serialService.test.js
```

Expected: FAIL because `tcpService.cjs` and TCP coordinator routing do not exist.

- [ ] **Step 3: Implement `TcpService`**

Create `apps/electron/electron/tcpService.cjs` with this public surface and helper structure. The implementation may add private helpers in the same file, but every public method below must exist with the shown behavior:

```js
const net = require('node:net');
const { createFramer } = require('./serialService.cjs');

const FRAME_BATCH_MILLIS = 200;
const FRAME_BATCH_LIMIT = 200;

class TcpService {
  constructor({ clock = Date.now, emitEvent, timers = globalThis } = {}) {
    if (typeof emitEvent !== 'function') throw new TypeError('emitEvent is required');
    this.clock = clock;
    this.emitEvent = emitEvent;
    this.timers = timers;
    this.sessions = new Map();
  }

  async open(endpoint, { operationId } = {}) {
    requireNonblankString(operationId, 'operationId');
    if (endpoint.transport === 'tcp-client') return this.openClient(endpoint, operationId);
    if (endpoint.transport === 'tcp-server') return this.openServer(endpoint, operationId);
    throw tcpError('IO_ERROR', `Endpoint ${endpoint.id} is not a TCP endpoint`);
  }

  async send(request) {
    const session = this.requireSession(request.endpointId);
    if (session.kind === 'client') return this.sendClient(session, request.bytes);
    return this.sendServer(session, request);
  }

  async disconnectPeer(endpointId, peerId) {
    const session = this.requireSession(endpointId);
    if (session.kind !== 'server') throw tcpError('IO_ERROR', 'Only TCP server peers can be disconnected');
    return closePeer(session, peerId);
  }

  async close(endpointId) {
    const session = this.sessions.get(endpointId);
    if (!session) return { closed: true, endpointId };
    this.sessions.delete(endpointId);
    await session.close();
    this.emitPeers(session, []);
    return { closed: true, endpointId };
  }

  async shutdown() {
    for (const endpointId of [...this.sessions.keys()]) await this.close(endpointId);
  }

  forceShutdown() {
    for (const endpointId of [...this.sessions.keys()]) void this.close(endpointId).catch(() => {});
    return [];
  }

  requireSession(endpointId) {
    const session = this.sessions.get(endpointId);
    if (!session) throw tcpError('PORT_NOT_FOUND', `Endpoint ${endpointId} is not open`);
    return session;
  }

  emitStatus(session, status, { error = null, level = status === 'error' ? 'error' : 'info', code = null, message, details = null } = {}) {
    const createdAt = this.clock();
    this.emitEvent('transport:status', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: status === 'opening' || status === 'closed' ? null : session.sessionId,
      status,
      error,
      createdAt,
      log: message ? { level, source: 'tcp', code, message, details, createdAt } : null,
    });
  }

  emitFrames(session, frames) {
    if (frames.length === 0) return;
    this.emitEvent('transport:frames', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: session.sessionId,
      frames,
    });
  }

  emitPeers(session) {
    const peers = session.kind === 'server'
      ? [...session.peers.values()].map(({ id, remoteAddress, connectedAt }) => ({ id, remoteAddress, connectedAt }))
      : [];
    this.emitEvent('transport:peers', {
      endpointId: session.endpointId,
      operationId: session.operationId,
      sessionId: session.sessionId,
      peers,
    });
  }
}

function requireNonblankString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new TypeError(`${name} must be a nonblank string`);
  }
}

function tcpError(code, message) {
  const error = new Error(message);
  error.name = 'TcpError';
  error.code = code;
  return error;
}

module.exports = { TcpService, tcpError };
```

Implement private `openClient`, `openServer`, `sendClient`, `sendServer`, `closePeer`, `attachSocketReaders`, and `createFrameBatcher` helpers in the same file. `openClient` must create a `net.Socket`, emit `opening`, wait for `connect`, store `{ kind: 'client', endpointId, operationId, sessionId, socket }`, emit `open`, and return `{ sessionId }`. `openServer` must create a `net.Server`, emit `opening`, wait for `listen`, store `{ kind: 'server', endpointId, operationId, sessionId, server, peers: new Map() }`, emit `listening`, and return `{ sessionId }`. Every status log must use `source: 'tcp'` and `createdAt` equal to the owning status event timestamp.

- [ ] **Step 4: Route Electron coordinator**

Modify `transportCoordinator.cjs`:

```js
class TransportCoordinator {
  constructor({ serialService, tcpService = null, database, persistence = null } = {}) {
    this.serialService = serialService;
    this.tcpService = tcpService;
    this.database = database;
    this.persistence = persistence;
  }

  serviceFor(endpoint) {
    if (endpoint.transport === 'serial') return this.serialService;
    if (endpoint.transport === 'tcp-client' || endpoint.transport === 'tcp-server') {
      if (!this.tcpService) throw serialError('IO_ERROR', 'TCP transport is unavailable');
      return this.tcpService;
    }
    throw serialError('IO_ERROR', `${endpoint.transport} transport is unavailable`);
  }

  async open(endpointId, options) {
    const endpoint = this.database.listEndpoints().find(({ id }) => id === endpointId);
    if (!endpoint) throw serialError('PORT_NOT_FOUND', `Endpoint ${endpointId} was not found`);
    return this.serviceFor(endpoint).open(endpoint, options);
  }
}
```

Route `send`, `close`, `closeAll`, `shutdown`, `forceShutdown`, and `disconnectPeer` across serial and TCP services.

Modify `main.cjs` to instantiate `TcpService` and pass it to `TransportCoordinator`.

- [ ] **Step 5: Run Electron TCP tests and verify GREEN**

Run:

```bash
node --test apps/electron/tests/tcpService.test.js apps/electron/tests/serialService.test.js apps/electron/tests/transportPersistence.test.js
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/electron/electron/tcpService.cjs \
  apps/electron/electron/transportCoordinator.cjs \
  apps/electron/electron/main.cjs \
  apps/electron/tests/tcpService.test.js \
  apps/electron/tests/serialService.test.js
git commit -m "feat: add Electron TCP transport"
```

## Task 4: Tauri TCP Service

**Files:**
- Create: `apps/tauri/src-tauri/src/tcp.rs`
- Modify: `apps/tauri/src-tauri/src/lib.rs`
- Modify: `apps/tauri/src-tauri/src/transport.rs`
- Test: `apps/tauri/src-tauri/src/tcp.rs`
- Test: `apps/tauri/src-tauri/src/transport.rs`

- [ ] **Step 1: Write failing Rust TCP tests**

Add `mod tcp;` to `lib.rs` and create `tcp.rs` tests:

```rust
#[test]
fn tcp_client_connects_to_localhost_echo_server_and_emits_frames() {
    let server = std::net::TcpListener::bind(("127.0.0.1", 0)).unwrap();
    let address = server.local_addr().unwrap();
    std::thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        let mut buffer = [0_u8; 2];
        socket.read_exact(&mut buffer).unwrap();
        socket.write_all(&[0x41, buffer[0], buffer[1]]).unwrap();
    });
    let sink = Arc::new(RecordingTcpSink::default());
    let service = TcpService::new(sink.clone(), Arc::new(TestClock::new(1_720_000_000_000)));
    service.open(tcp_client_endpoint("tcp-client-1", address), "open-client").unwrap();
    service.send("tcp-client-1", &[0x31, 0x32], None).unwrap();
    sink.wait_for_inbound("tcp-client-1");
    assert!(sink.frames().iter().any(|batch| batch.frames.iter().any(|frame| frame.direction == "in")));
}
```

Add transport routing tests for TCP and UDP controlled unavailability.

- [ ] **Step 2: Run Rust TCP tests and verify RED**

Run:

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml tcp::tests transport::tests
```

Expected: FAIL because `tcp.rs` service and command routing are missing.

- [ ] **Step 3: Implement `tcp.rs` service**

Create these public shapes:

```rust
pub(crate) type TcpResult<T> = Result<T, serial::SerialError>;

#[derive(Debug, Clone)]
pub(crate) struct TcpEndpoint {
    pub(crate) endpoint_id: String,
    pub(crate) transport: String,
    pub(crate) config: serde_json::Value,
}

pub(crate) struct TcpService {
    sink: Arc<dyn serial::SerialEventSink>,
    sessions: Mutex<HashMap<String, Arc<TcpSession>>>,
}

impl TcpService {
    pub(crate) fn new(sink: Arc<dyn serial::SerialEventSink>) -> Self {
        Self { sink, sessions: Mutex::new(HashMap::new()) }
    }

    pub(crate) fn open(
        &self,
        endpoint: TcpEndpoint,
        operation_id: &str,
    ) -> TcpResult<serial::OpenAcknowledgement> {
        require_id(operation_id, "operationId")?;
        match endpoint.transport.as_str() {
            "tcp-client" => self.open_client(endpoint, operation_id),
            "tcp-server" => self.open_server(endpoint, operation_id),
            _ => Err(serial::SerialError::new(
                serial::SerialErrorCode::IoError,
                format!("{} is not a TCP endpoint", endpoint.endpoint_id),
            )),
        }
    }

    pub(crate) fn send(
        &self,
        endpoint_id: &str,
        bytes: &[u8],
        target: Option<&serde_json::Value>,
    ) -> TcpResult<serial::SendAcknowledgement> {
        let session = self.session(endpoint_id)?;
        match session.kind {
            TcpSessionKind::Client => self.send_client(&session, bytes),
            TcpSessionKind::Server => self.send_server(&session, bytes, target),
        }
    }

    pub(crate) fn close(&self, endpoint_id: &str) -> TcpResult<serial::CloseAcknowledgement> {
        let session = self.sessions.lock().unwrap().remove(endpoint_id);
        if let Some(session) = session {
            session.close()?;
            self.emit_peers(&session, Vec::new());
        }
        Ok(serial::CloseAcknowledgement { endpoint_id: endpoint_id.into(), closed: true })
    }

    pub(crate) fn disconnect_peer(
        &self,
        endpoint_id: &str,
        peer_id: &str,
    ) -> TcpResult<serde_json::Value> {
        let session = self.session(endpoint_id)?;
        session.disconnect_peer(peer_id)?;
        self.emit_peers(&session, session.peer_records());
        Ok(serde_json::json!({ "endpointId": endpoint_id, "peerId": peer_id, "disconnected": true }))
    }

    pub(crate) fn shutdown(&self) -> TcpResult<()> {
        let endpoint_ids: Vec<String> = self.sessions.lock().unwrap().keys().cloned().collect();
        for endpoint_id in endpoint_ids {
            self.close(&endpoint_id)?;
        }
        Ok(())
    }

    pub(crate) fn force_shutdown(&self) -> Vec<String> {
        let _ = self.shutdown();
        Vec::new()
    }
}
```

Implement private `open_client`, `open_server`, `send_client`, `send_server`, `session`, `emit_status`, `emit_frames`, and `emit_peers` helpers. Reuse `serial::ReceiveFraming` and `serial::SerialEvent` payload structs. TCP logs must use `source: "tcp"`.

- [ ] **Step 4: Wire Tauri command routing**

Modify `AppState` in `lib.rs`:

```rust
pub(crate) tcp_service: Arc<tcp::TcpService>,
```

Instantiate it with the same persistence event sink.

Modify `transport.rs`:

```rust
match snapshot.transport.as_str() {
    "serial" => { /* existing serial path */ }
    "tcp-client" | "tcp-server" => {
        Ok(state.tcp_service.open(tcp::TcpEndpoint {
            endpoint_id: snapshot.id,
            transport: snapshot.transport,
            config: snapshot.config,
        }, &operation.operation_id))
    }
    _ => Ok(Err(serial::SerialError::new(
        serial::SerialErrorCode::IoError,
        format!("{} transport is unavailable", snapshot.transport),
    ))),
}
```

Route `send`, `close`, shutdown, and `disconnectPeer` similarly.

- [ ] **Step 5: Run Rust TCP tests and verify GREEN**

Run:

```bash
cargo fmt --manifest-path apps/tauri/src-tauri/Cargo.toml --check
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml tcp::tests transport::tests
```

Expected: all selected tests pass.

- [ ] **Step 6: Commit**

```bash
git add apps/tauri/src-tauri/src/tcp.rs \
  apps/tauri/src-tauri/src/lib.rs \
  apps/tauri/src-tauri/src/transport.rs
git commit -m "feat: add Tauri TCP transport"
```

## Task 5: TCP Persistence And History Parity

**Files:**
- Modify: `apps/electron/tests/transportPersistence.test.js`
- Modify: `apps/electron/tests/managementDatabase.test.js`
- Modify: `apps/tauri/src-tauri/src/persistence.rs`
- Modify: `apps/tauri/src-tauri/src/database.rs`
- Test: existing persistence/database tests

- [ ] **Step 1: Write failing persistence parity tests**

Add Electron test:

```js
test('TCP server peer frames and logs persist peer identity and exact timestamps', async (t) => {
  const fixture = await openFixture(t);
  const frame = validFrameRow({
    endpointId: 'tcp-server-1',
    sessionId: 'tcp-server-session',
    peerId: 'peer-127-0-0-1-51000',
    direction: 'in',
    payload: Uint8Array.of(0x41),
    byteCount: 1,
    createdAt: 1_720_000_000_111,
  });
  const log = validLogRow({
    endpointId: 'tcp-server-1',
    sessionId: 'tcp-server-session',
    peerId: 'peer-127-0-0-1-51000',
    source: 'tcp',
    message: 'TCP peer connected',
    details: { remoteAddress: '127.0.0.1:51000' },
    createdAt: 1_720_000_000_111,
  });
  fixture.database.insertFrameBatch([frame]);
  fixture.database.insertLogBatch([log]);
  assert.equal(fixture.database.queryFrames({ endpointId: 'tcp-server-1' }).rows[0].peerId, 'peer-127-0-0-1-51000');
  assert.equal(fixture.database.queryLogs({ endpointId: 'tcp-server-1' }).rows[0].source, 'tcp');
});
```

Add Rust equivalent in `database.rs` for TCP `peer_id` and `source`.

- [ ] **Step 2: Run persistence tests and verify RED if source validation rejects TCP**

Run:

```bash
node --test apps/electron/tests/managementDatabase.test.js apps/electron/tests/transportPersistence.test.js
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml database::tests persistence::tests
```

Expected: FAIL only if log source validation still assumes serial; otherwise PASS confirms existing schema supports TCP.

- [ ] **Step 3: Implement any required source validation updates**

If Electron or Tauri log write validators restrict `source` to serial, update them to allow:

```js
const LOG_SOURCES = new Set(['serial', 'tcp']);
if (!LOG_SOURCES.has(value.source)) {
  throw new TypeError(`${label}.source must be serial or tcp`);
}
```

Rust equivalent:

```rust
if !matches!(row.source.as_str(), "serial" | "tcp") {
    return Err("source must be serial or tcp".into());
}
```

- [ ] **Step 4: Run persistence tests and verify GREEN**

Run the Step 2 commands. Expected: all selected tests pass.

- [ ] **Step 5: Commit**

```bash
git add apps/electron/tests/managementDatabase.test.js \
  apps/electron/tests/transportPersistence.test.js \
  apps/electron/electron/database.cjs \
  apps/tauri/src-tauri/src/database.rs \
  apps/tauri/src-tauri/src/persistence.rs
git commit -m "test: cover TCP history persistence"
```

## Task 6: Real TCP Acceptance Probe And Verification Gate

**Files:**
- Create: `tooling/tcp-test/localhost-loopback.mjs`
- Modify: `package.json`
- Create: `docs/verification/phase-04.md`
- Test: real TCP acceptance command

- [ ] **Step 1: Write failing TCP acceptance probe**

Create `tooling/tcp-test/localhost-loopback.mjs` with assertions:

```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import net from 'node:net';

const summaries = [];

async function runElectronTcpLoopback() {
  throw new Error('Electron TCP loopback is not implemented yet');
}

async function runTauriTcpLoopback() {
  throw new Error('Tauri TCP loopback is not implemented yet');
}

async function runElectronClientToTauriServer() {
  throw new Error('mixed Electron client to Tauri server TCP loopback is not implemented yet');
}

async function main() {
  summaries.push(await runElectronTcpLoopback());
  summaries.push(await runTauriTcpLoopback());
  summaries.push(await runElectronClientToTauriServer());
  assert.equal(summaries.every((summary) => summary.frames >= 4), true);
  assert.equal(summaries.every((summary) => summary.logs >= 2), true);
  console.log(`TCP_ACCEPTANCE_RESULT=${JSON.stringify({ summaries })}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
```

The initial command should fail because TCP services or Rust ignored test are incomplete.

- [ ] **Step 2: Run acceptance probe and verify RED**

Run:

```bash
node tooling/tcp-test/localhost-loopback.mjs
```

Expected: FAIL before service acceptance hooks exist.

- [ ] **Step 3: Complete acceptance orchestration**

Implement:

- Electron same-runtime client/server loopback using `TcpService`.
- Tauri ignored test invocation:

```bash
cargo test --manifest-path apps/tauri/src-tauri/Cargo.toml real_tcp_transport_contract -- --ignored --nocapture
```

- Mixed pair by starting the Tauri TCP server ignored test in listener-only mode and connecting an Electron `TcpService` client to it. The script must include one mixed runtime summary named `electron-client-to-tauri-server`.
- Output `TCP_ACCEPTANCE_RESULT`.
- Assert no child process remains unmanaged.

- [ ] **Step 4: Add verification gate**

In `package.json`, add:

```json
"verify:phase-04": "npm run verify:phase-03 && node tooling/tcp-test/localhost-loopback.mjs && git diff --check"
```

- [ ] **Step 5: Update verification docs**

Create `docs/verification/phase-04.md` with:

```markdown
# Phase 04 Verification

Verified on 2026-07-16 in the local `ineed-dev-tool` repository.

## Scope

Phase 04 delivers production TCP client and TCP server transports for Electron and Tauri. Serial remains covered by the Phase 03 gate. UDP remains a controlled unavailable transport until the UDP milestone.

## Automated Gates

| Command | Exact result |
| --- | --- |
| `node tooling/tcp-test/localhost-loopback.mjs` | PASS, Electron TCP loopback, Tauri TCP loopback, one mixed Electron/Tauri pair |
| `npm run verify:phase-04` | PASS, includes Phase 03 gate, TCP acceptance, and `git diff --check` |

## Evidence

- TCP client connects, sends, receives, closes, logs, and persists history in both runtimes.
- TCP server listens, accepts peers, emits peer lists, sends to one peer or all peers, logs, and persists peer-scoped history.
- TCP status logs use `source: tcp`; serial logs remain `source: serial`.
- UDP endpoints remain unavailable with controlled errors.
```

Replace the PASS row with fresh exact counts from the actual run before committing.

- [ ] **Step 6: Run gates and verify GREEN**

Run:

```bash
node tooling/tcp-test/localhost-loopback.mjs
npm run verify:phase-04
```

Expected: both pass.

- [ ] **Step 7: Commit**

```bash
git add tooling/tcp-test/localhost-loopback.mjs package.json docs/verification/phase-04.md
git commit -m "test: verify TCP transport acceptance"
```

## Task 7: Full TCP Integration Review And Fix Loop

**Files:**
- Review full range from this plan base to HEAD.
- Fix any review findings in the relevant files.

- [ ] **Step 1: Run complete verification**

Run:

```bash
npm run verify:phase-04
```

Expected: PASS.

- [ ] **Step 2: Request spec compliance review**

Review against:

- `docs/superpowers/specs/2026-07-16-tcp-production-transport-design.md`
- This implementation plan

Required verdict: no spec gaps.

- [ ] **Step 3: Request code quality review**

Review categories:

- Runtime contract compatibility.
- Serial regression risk.
- TCP socket cleanup and shutdown.
- Peer identity lifecycle.
- Persistence exactness.
- Real acceptance robustness.
- UI target selection and history behavior.

Required verdict: no Critical or Important issues.

- [ ] **Step 4: Fix review findings**

For each Critical or Important issue:

1. Add or update a failing focused test.
2. Run the focused command and verify RED.
3. Implement the fix.
4. Run focused command and verify GREEN.
5. Commit with a focused `fix:` or `test:` message.
6. Re-run the relevant reviewer.

- [ ] **Step 5: Final commit state check**

Run:

```bash
git status --short
git log --oneline -20
npm run verify:phase-04
```

Expected:

- `git status --short` prints nothing.
- `npm run verify:phase-04` passes.
