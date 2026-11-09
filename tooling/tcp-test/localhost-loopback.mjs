#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { createWorkbenchModel } from '../../packages/workbench/src/model/createWorkbenchModel.js';
import { createUnavailableRuntimeAdapter } from '../../packages/runtime-contract/src/index.js';

const require = createRequire(import.meta.url);
const { TcpService } = require('../../apps/electron/electron/tcpService.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP_TIMEOUT_MS = 30_000;
const CHILD_TIMEOUT_MS = 120_000;
const managedChildren = new Set();

function createElectronHarness() {
  const events = [];
  let timestamp = Date.now();
  const service = new TcpService({
    clock: () => {
      timestamp += 1;
      return timestamp;
    },
    emitEvent: (channel, payload) => events.push({ channel, payload }),
  });
  return { service, events };
}

function payloads(events, channel) {
  return events.filter((event) => event.channel === channel).map((event) => event.payload);
}

function frameCount(events) {
  return payloads(events, 'transport:frames')
    .reduce((total, batch) => total + batch.frames.length, 0);
}

function logCount(events) {
  return payloads(events, 'transport:status').filter((status) => status.log !== null).length;
}

function framesFor(events, endpointId) {
  return payloads(events, 'transport:frames')
    .filter((batch) => batch.endpointId === endpointId)
    .flatMap((batch) => batch.frames);
}

function logsFor(events, endpointId) {
  return payloads(events, 'transport:status')
    .filter((status) => status.endpointId === endpointId && status.log !== null)
    .map((status) => status.log);
}

function hasFrame(events, endpointId, direction, bytes) {
  return payloads(events, 'transport:frames').some((batch) => (
    batch.endpointId === endpointId
      && batch.frames.some((frame) => (
        frame.direction === direction && arrayEqual(frame.bytes, bytes)
      ))
  ));
}

function arrayEqual(actual, expected) {
  return actual.length === expected.length
    && expected.every((byte, index) => actual[index] === byte);
}

async function waitFor(predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
}

function connectClient(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port });
  return new Promise((resolve, reject) => {
    socket.once('connect', () => resolve(socket));
    socket.once('error', reject);
  });
}

function waitForData(socket) {
  return new Promise((resolve, reject) => {
    socket.once('data', (bytes) => resolve(Buffer.from(bytes)));
    socket.once('error', reject);
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    if (!socket || socket.destroyed) {
      resolve();
      return;
    }
    socket.once('close', resolve);
    socket.end();
    socket.setTimeout(100, () => socket.destroy());
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    if (!server.listening) {
      resolve();
      return;
    }
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function tcpServerEndpoint(id) {
  return {
    id,
    name: id,
    transport: 'tcp-server',
    config: { listenHost: '127.0.0.1', listenPort: 0, receiveFraming: { mode: 'raw' } },
  };
}

function tcpClientEndpoint(id, port) {
  return {
    id,
    name: id,
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port, receiveFraming: { mode: 'raw' } },
  };
}

async function runTcpReconnectAcceptance() {
  const reservation = net.createServer();
  let listener = null;
  let acceptedSocket = null;
  const endpointId = 'tcp-reconnect-acceptance';
  const attempts = [];
  const subscribers = { frames: new Set(), status: new Set(), peers: new Set() };
  const eventKindByChannel = {
    'transport:frames': 'frames',
    'transport:status': 'status',
    'transport:peers': 'peers',
  };
  const service = new TcpService({
    emitEvent(channel, payload) {
      const kind = eventKindByChannel[channel];
      if (!kind) return;
      for (const listener of subscribers[kind]) listener(payload);
    },
  });
  let model = null;
  try {
    await new Promise((resolve) => reservation.listen(0, '127.0.0.1', resolve));
    const port = reservation.address().port;
    await closeServer(reservation);

    const endpoint = {
      ...tcpClientEndpoint(endpointId, port),
      config: {
        ...tcpClientEndpoint(endpointId, port).config,
        autoReconnect: true,
      },
    };
    const adapter = createUnavailableRuntimeAdapter('tcp-reconnect-acceptance');
    adapter.endpoint.list = async () => [endpoint];
    adapter.transport.open = async (requestedEndpointId, { operationId }) => {
      assert.equal(requestedEndpointId, endpointId);
      attempts.push({ operationId, createdAt: Date.now() });
      return service.open(endpoint, { operationId });
    };
    adapter.transport.cancelOpen = (requestedEndpointId, options) => (
      service.cancelOpen(requestedEndpointId, options)
    );
    adapter.transport.close = (requestedEndpointId) => service.close(requestedEndpointId);
    for (const [kind, method] of Object.entries({
      frames: 'onFrames', status: 'onStatus', peers: 'onPeers',
    })) {
      adapter.transport[method] = (callback) => {
        subscribers[kind].add(callback);
        return () => subscribers[kind].delete(callback);
      };
    }
    model = createWorkbenchModel(adapter);
    await model.commands.loadEndpoints();

    const manual = await model.commands.open(endpointId, 'manual-reconnect-open');
    assert.equal(manual.ok, false, 'the unavailable manual connection must fail');
    let initialReconnectState = null;
    let initialWaitingObservedAt = null;
    await waitFor(
      () => {
        const reconnectState = model.reconnectStateFor(endpointId);
        if (reconnectState?.phase !== 'waiting' || reconnectState.attempt !== 1) return false;
        initialReconnectState = reconnectState;
        initialWaitingObservedAt = Date.now();
        return true;
      },
      'first TCP reconnect wait',
    );
    const initialScheduledDelay = initialReconnectState.nextRetryAt - initialWaitingObservedAt;
    assert.equal(initialScheduledDelay >= 350 && initialScheduledDelay <= 550, true,
      `initial retry must schedule 500 ms; observed ${initialScheduledDelay} ms`);
    await waitFor(() => attempts.length === 2, 'first TCP reconnect attempt');
    const firstRetryDelay = attempts[1].createdAt - attempts[0].createdAt;
    assert.equal(firstRetryDelay >= 450 && firstRetryDelay < 1_500, true);

    listener = net.createServer((socket) => {
      acceptedSocket = socket;
      socket.on('error', () => {});
    });
    await new Promise((resolve) => listener.listen(port, '127.0.0.1', resolve));
    await waitFor(() => attempts.length === 3, 'second TCP reconnect attempt');
    const secondRetryDelay = attempts[2].createdAt - attempts[1].createdAt;
    assert.equal(secondRetryDelay >= 900 && secondRetryDelay < 2_000, true);
    await waitFor(
      () => service.sessions.has(endpointId)
        && model.state.operations.get(endpointId)?.sessionId !== null
        && acceptedSocket !== null,
      'TCP reconnect success after listener starts',
    );

    const disconnectStartedAt = Date.now();
    acceptedSocket.destroy();
    await closeServer(listener);
    listener = null;
    let freshReconnectState = null;
    let waitingObservedAt = null;
    await waitFor(
      () => {
        const reconnectState = model.reconnectStateFor(endpointId);
        if (
          reconnectState?.phase !== 'waiting'
          || reconnectState.attempt !== 1
          || service.sessions.size !== 0
        ) return false;
        freshReconnectState = reconnectState;
        waitingObservedAt = Date.now();
        return true;
      },
      'fresh reconnect wait after remote close',
    );
    const freshRetryDelay = freshReconnectState.nextRetryAt - waitingObservedAt;
    assert.equal(freshRetryDelay >= 350 && freshRetryDelay <= 550, true,
      `remote-close retry must restart at 500 ms; observed ${freshRetryDelay} ms after ${Date.now() - disconnectStartedAt} ms`,
    );
    const callsBeforeCancellation = attempts.length;
    const cancelled = await model.commands.cancelReconnect(endpointId);
    assert.equal(cancelled.ok, true);
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(attempts.length, callsBeforeCancellation);
    assert.equal(model.reconnectStateFor(endpointId), null);
    assert.equal(new Set(attempts.map(({ operationId }) => operationId)).size, attempts.length);
    assert.equal(service.sessions.size, 0);
    model.dispose();
    model = null;
    return {
      runtime: 'shared-electron',
      scenario: 'tcp-reconnect',
      attempts: attempts.length,
      uniqueOperationIds: new Set(attempts.map(({ operationId }) => operationId)).size,
      cancelled: true,
      managedSessions: service.sessions.size,
    };
  } finally {
    model?.dispose();
    acceptedSocket?.destroy();
    await closeServer(reservation).catch(() => {});
    if (listener) await closeServer(listener).catch(() => {});
    await service.shutdown();
  }
}

async function runElectronTcpLoopback() {
  const { service, events } = createElectronHarness();
  let peerSocket = null;
  let echoServer = null;
  try {
    await service.open(tcpServerEndpoint('phase04-electron-server'), {
      operationId: 'open-electron-server',
    });
    const serverSession = service.sessions.get('phase04-electron-server');
    peerSocket = await connectClient(serverSession.server.address().port);
    await waitFor(
      () => payloads(events, 'transport:peers').at(-1)?.peers.length === 1,
      'Electron TCP peer connection',
    );
    const peer = payloads(events, 'transport:peers').at(-1).peers[0];
    peerSocket.write(Buffer.from([0x21, 0x22]));
    await waitFor(
      () => hasFrame(events, 'phase04-electron-server', 'in', [0x21, 0x22]),
      'Electron TCP server inbound frame',
    );
    await service.send({
      endpointId: 'phase04-electron-server',
      peerId: peer.id,
      bytes: Uint8Array.of(0x31, 0x32),
    });
    assert.deepEqual([...await waitForData(peerSocket)], [0x31, 0x32]);

    echoServer = net.createServer((socket) => {
      socket.on('data', (bytes) => socket.write(Buffer.from([0x41, ...bytes])));
    });
    await new Promise((resolve) => echoServer.listen(0, '127.0.0.1', resolve));
    await service.open(tcpClientEndpoint(
      'phase04-electron-client',
      echoServer.address().port,
    ), { operationId: 'open-electron-client' });
    await service.send({
      endpointId: 'phase04-electron-client',
      bytes: Uint8Array.of(0x51),
    });
    await waitFor(
      () => hasFrame(events, 'phase04-electron-client', 'in', [0x41, 0x51]),
      'Electron TCP client inbound frame',
    );

    await service.close('phase04-electron-client');
    await service.close('phase04-electron-server');
    await closeSocket(peerSocket);
    await closeServer(echoServer);
    const serverFrames = framesFor(events, 'phase04-electron-server');
    const serverLogs = logsFor(events, 'phase04-electron-server');
    assert.equal(serverFrames.every((frame) => frame.peerId === peer.id), true);
    assert.equal(serverLogs.every((log) => log.source === 'tcp'), true);
    assert.equal(serverLogs.some((log) => log.peerId === peer.id), true);
    return {
      runtime: 'electron',
      scenario: 'electron-loopback',
      frames: frameCount(events),
      logs: logCount(events),
      peers: payloads(events, 'transport:peers').length,
      peerFrames: serverFrames.filter((frame) => frame.peerId === peer.id).length,
      tcpLogs: serverLogs.length,
    };
  } finally {
    peerSocket?.destroy();
    await service.shutdown();
    if (echoServer) await closeServer(echoServer).catch(() => {});
  }
}

async function runTauriTcpLoopback() {
  const result = await runCommand('cargo', [
    'test',
    '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
    'real_tcp_transport_contract',
    '--', '--ignored', '--nocapture',
  ]);
  const match = result.stdout.match(/^PHASE04_TAURI_RESULT=(.+)$/m);
  assert.ok(match, `Tauri TCP probe did not emit a result summary:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(match[1]);
}

async function runElectronClientToTauriServer() {
  const child = spawnManaged('cargo', [
    'test',
    '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
    'real_tcp_transport_contract',
    '--', '--ignored', '--nocapture',
  ], {
    env: { ...process.env, INEED_PHASE04_TCP_MODE: 'server' },
  });
  try {
    const ready = JSON.parse(await waitForChildLine(child, /^PHASE04_TAURI_SERVER_READY=(.+)$/m));
    const { service, events } = createElectronHarness();
    try {
      await service.open(tcpClientEndpoint('phase04-mixed-electron-client', ready.port), {
        operationId: 'open-mixed-electron-client',
      });
      await service.send({
        endpointId: 'phase04-mixed-electron-client',
        bytes: Uint8Array.of(0x61, 0x62),
      });
      await waitFor(
        () => hasFrame(events, 'phase04-mixed-electron-client', 'in', [0x71, 0x72]),
        'mixed Electron client inbound frame',
      );
      await service.close('phase04-mixed-electron-client');
    } finally {
      await service.shutdown();
    }
    const output = await waitForManagedExit(child);
    const match = output.stdout.match(/^PHASE04_TAURI_SERVER_RESULT=(.+)$/m);
    assert.ok(match, `Tauri mixed server did not emit a result summary:\n${output.stdout}\n${output.stderr}`);
    const tauri = JSON.parse(match[1]);
    const electronLogs = logsFor(events, 'phase04-mixed-electron-client');
    assert.equal(electronLogs.every((log) => log.source === 'tcp'), true);
    assert.equal(tauri.peerFrames >= 2, true);
    return {
      runtime: 'mixed',
      scenario: 'electron-client-to-tauri-server',
      frames: frameCount(events) + tauri.frames,
      logs: logCount(events) + tauri.logs,
      peerFrames: tauri.peerFrames,
      tcpLogs: tauri.tcpLogs,
      electron: { frames: frameCount(events), logs: logCount(events) },
      tauri,
    };
  } catch (error) {
    await terminateChild(child);
    throw error;
  }
}

async function runTauriClientToElectronServer() {
  const { service, events } = createElectronHarness();
  let child = null;
  try {
    await service.open(tcpServerEndpoint('phase04-mixed-electron-server'), {
      operationId: 'open-mixed-electron-server',
    });
    const port = service.sessions
      .get('phase04-mixed-electron-server')
      .server.address().port;
    child = spawnManaged('cargo', [
      'test',
      '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
      'real_tcp_transport_contract',
      '--', '--ignored', '--nocapture',
    ], {
      env: {
        ...process.env,
        INEED_PHASE04_TCP_MODE: 'client',
        INEED_PHASE04_TCP_SERVER_PORT: String(port),
      },
    });
    await waitFor(
      () => payloads(events, 'transport:peers').at(-1)?.peers.length === 1,
      'mixed Electron TCP server peer',
    );
    const peer = payloads(events, 'transport:peers').at(-1).peers[0];
    await waitFor(
      () => hasFrame(events, 'phase04-mixed-electron-server', 'in', [0x81, 0x82]),
      'mixed Electron TCP server inbound frame',
    );
    await service.send({
      endpointId: 'phase04-mixed-electron-server',
      peerId: peer.id,
      bytes: Uint8Array.of(0x91, 0x92),
    });
    const output = await waitForManagedExit(child);
    const match = output.stdout.match(/^PHASE04_TAURI_CLIENT_RESULT=(.+)$/m);
    assert.ok(
      match,
      `Tauri mixed client did not emit a result summary:\n${output.stdout}\n${output.stderr}`,
    );
    const tauri = JSON.parse(match[1]);
    await service.close('phase04-mixed-electron-server');
    const electronFrames = framesFor(events, 'phase04-mixed-electron-server');
    const electronLogs = logsFor(events, 'phase04-mixed-electron-server');
    assert.equal(electronFrames.every((frame) => frame.peerId === peer.id), true);
    assert.equal(electronLogs.every((log) => log.source === 'tcp'), true);
    return {
      runtime: 'mixed',
      scenario: 'tauri-client-to-electron-server',
      frames: frameCount(events) + tauri.frames,
      logs: logCount(events) + tauri.logs,
      peerFrames: electronFrames.filter((frame) => frame.peerId === peer.id).length,
      tcpLogs: electronLogs.length,
      electron: { frames: frameCount(events), logs: logCount(events) },
      tauri,
    };
  } catch (error) {
    if (child) await terminateChild(child);
    throw error;
  } finally {
    await service.shutdown();
  }
}

function spawnManaged(command, args, options = {}) {
  const child = spawn(command, args, {
    cwd: ROOT,
    env: process.env,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
  const record = {
    child,
    stdout: '',
    stderr: '',
    exited: false,
    exitCode: null,
    signal: null,
  };
  managedChildren.add(record);
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { record.stdout += chunk; });
  child.stderr.on('data', (chunk) => { record.stderr += chunk; });
  child.on('exit', (code, signal) => {
    record.exited = true;
    record.exitCode = code;
    record.signal = signal;
    managedChildren.delete(record);
  });
  return record;
}

async function runCommand(command, args, options = {}) {
  return waitForManagedExit(spawnManaged(command, args, options));
}

async function waitForChildLine(record, pattern, timeoutMs = CHILD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const match = record.stdout.match(pattern);
    if (match) return match[1];
    if (record.exited) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for child output ${pattern}.\nstdout:\n${record.stdout}\nstderr:\n${record.stderr}`);
}

async function waitForManagedExit(record, timeoutMs = CHILD_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (record.exited) {
      if (record.exitCode !== 0) {
        throw new Error(`Command failed with ${record.exitCode ?? record.signal}\nstdout:\n${record.stdout}\nstderr:\n${record.stderr}`);
      }
      return { stdout: record.stdout, stderr: record.stderr };
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await terminateChild(record);
  throw new Error(`Command timed out after ${timeoutMs} ms\nstdout:\n${record.stdout}\nstderr:\n${record.stderr}`);
}

async function terminateChild(record) {
  if (record.exited) return;
  signalProcessGroup(record, 'SIGTERM');
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if (record.exited) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  if (!record.exited) signalProcessGroup(record, 'SIGKILL');
  while (!record.exited) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function signalProcessGroup(record, signal) {
  try {
    process.kill(-record.child.pid, signal);
  } catch {
    record.child.kill(signal);
  }
}

async function main() {
  const summaries = [];
  summaries.push(await runElectronTcpLoopback());
  summaries.push(await runTauriTcpLoopback());
  summaries.push(await runElectronClientToTauriServer());
  summaries.push(await runTauriClientToElectronServer());
  summaries.push(await runTcpReconnectAcceptance());
  const transportLoopbacks = summaries.filter((summary) => 'frames' in summary);
  assert.equal(transportLoopbacks.every((summary) => summary.frames >= 4), true);
  assert.equal(transportLoopbacks.every((summary) => summary.logs >= 2), true);
  assert.equal(transportLoopbacks.every((summary) => summary.peerFrames >= 2), true);
  assert.equal(transportLoopbacks.every((summary) => summary.tcpLogs >= 2), true);
  assert.equal(managedChildren.size, 0);
  console.log(`TCP_ACCEPTANCE_RESULT=${JSON.stringify({ summaries, managedChildren: 0 })}`);
}

main().catch(async (error) => {
  await Promise.all([...managedChildren].map((child) => terminateChild(child)));
  console.error(error);
  process.exit(1);
});
