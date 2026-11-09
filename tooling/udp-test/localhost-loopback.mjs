#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import dgram from 'node:dgram';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { UdpService } = require('../../apps/electron/electron/udpService.cjs');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const STEP_TIMEOUT_MS = 30_000;
const CHILD_TIMEOUT_MS = 120_000;
const managedChildren = new Set();

function createElectronHarness() {
  const events = [];
  let timestamp = Date.now();
  const service = new UdpService({
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

function frameCount(events) {
  return payloads(events, 'transport:frames')
    .reduce((total, batch) => total + batch.frames.length, 0);
}

function logCount(events) {
  return payloads(events, 'transport:status').filter((status) => status.log !== null).length;
}

function hasFrame(events, endpointId, direction, bytes) {
  return framesFor(events, endpointId).some((frame) => (
    frame.direction === direction && arrayEqual(frame.bytes, bytes)
  ));
}

function arrayEqual(actual, expected) {
  return actual.length === expected.length
    && expected.every((byte, index) => actual[index] === byte);
}

function udpServerEndpoint(id) {
  return {
    id,
    name: id,
    transport: 'udp-server',
    config: { bindHost: '127.0.0.1', bindPort: 0, receiveFraming: { mode: 'raw' } },
  };
}

function udpClientEndpoint(id, port) {
  return {
    id,
    name: id,
    transport: 'udp-client',
    config: {
      bindHost: '127.0.0.1',
      bindPort: 0,
      targetHost: '127.0.0.1',
      targetPort: port,
      receiveFraming: { mode: 'raw' },
    },
  };
}

async function runElectronUdpLoopback() {
  const { service, events } = createElectronHarness();
  const peer = dgram.createSocket('udp4');
  const echo = dgram.createSocket('udp4');
  try {
    await service.open(udpServerEndpoint('phase05-electron-server'), {
      operationId: 'open-electron-server',
    });
    await bindSocket(peer);
    const serverPort = service.sessions.get('phase05-electron-server').socket.address().port;
    peer.send(Buffer.from([0x21, 0x22]), serverPort, '127.0.0.1');
    await waitFor(
      () => payloads(events, 'transport:peers').at(-1)?.peers.length === 1,
      'Electron UDP peer discovery',
    );
    const peerId = payloads(events, 'transport:peers').at(-1).peers[0].id;
    await waitFor(
      () => hasFrame(events, 'phase05-electron-server', 'in', [0x21, 0x22]),
      'Electron UDP server inbound frame',
    );
    const peerReply = waitForMessage(peer);
    await service.send({
      endpointId: 'phase05-electron-server',
      bytes: Uint8Array.of(0x31, 0x32),
      target: { peerId },
    });
    assert.deepEqual([...await peerReply], [0x31, 0x32]);

    echo.on('message', (bytes, remote) => {
      echo.send(Buffer.from([0x41, ...bytes]), remote.port, remote.address);
    });
    await bindSocket(echo);
    await service.open(
      udpClientEndpoint('phase05-electron-client', echo.address().port),
      { operationId: 'open-electron-client' },
    );
    await service.send({
      endpointId: 'phase05-electron-client',
      bytes: Uint8Array.of(0x51),
    });
    await waitFor(
      () => hasFrame(events, 'phase05-electron-client', 'in', [0x41, 0x51]),
      'Electron UDP client inbound frame',
    );

    await service.close('phase05-electron-client');
    await service.close('phase05-electron-server');
    const serverFrames = framesFor(events, 'phase05-electron-server');
    const udpLogs = payloads(events, 'transport:status')
      .filter((status) => status.log?.source === 'udp');
    assert.equal(serverFrames.every((frame) => frame.peerId === peerId), true);
    assert.equal(udpLogs.length >= 2, true);
    return {
      runtime: 'electron',
      scenario: 'electron-loopback',
      frames: frameCount(events),
      logs: logCount(events),
      peerFrames: serverFrames.filter((frame) => frame.peerId === peerId).length,
      udpLogs: udpLogs.length,
    };
  } finally {
    await service.shutdown();
    await closeSocket(peer);
    await closeSocket(echo);
  }
}

async function runTauriUdpLoopback() {
  const result = await runCommand('cargo', [
    'test',
    '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
    'real_udp_transport_contract',
    '--', '--ignored', '--nocapture',
  ]);
  const match = result.stdout.match(/^PHASE05_TAURI_RESULT=(.+)$/m);
  assert.ok(match, `Tauri UDP probe did not emit a result summary:\n${result.stdout}\n${result.stderr}`);
  return JSON.parse(match[1]);
}

async function runElectronClientToTauriServer() {
  const child = spawnManaged('cargo', [
    'test',
    '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
    'real_udp_transport_contract',
    '--', '--ignored', '--nocapture',
  ], {
    env: { ...process.env, INEED_PHASE05_UDP_MODE: 'server' },
  });
  try {
    const ready = JSON.parse(await waitForChildLine(child, /^PHASE05_TAURI_SERVER_READY=(.+)$/m));
    const { service, events } = createElectronHarness();
    try {
      await service.open(
        udpClientEndpoint('phase05-mixed-electron-client', ready.port),
        { operationId: 'open-mixed-electron-client' },
      );
      await service.send({
        endpointId: 'phase05-mixed-electron-client',
        bytes: Uint8Array.of(0x61, 0x62),
      });
      await waitFor(
        () => hasFrame(events, 'phase05-mixed-electron-client', 'in', [0x71, 0x72]),
        'mixed Electron UDP client inbound frame',
      );
      await service.close('phase05-mixed-electron-client');
    } finally {
      await service.shutdown();
    }
    const output = await waitForManagedExit(child);
    const match = output.stdout.match(/^PHASE05_TAURI_SERVER_RESULT=(.+)$/m);
    assert.ok(match, `Tauri mixed UDP server did not emit a result summary:\n${output.stdout}\n${output.stderr}`);
    const tauri = JSON.parse(match[1]);
    const electronLogs = logsFor(events, 'phase05-mixed-electron-client');
    assert.equal(electronLogs.every((log) => log.source === 'udp'), true);
    assert.equal(tauri.peerFrames >= 2, true);
    return {
      runtime: 'mixed',
      scenario: 'electron-client-to-tauri-server',
      frames: frameCount(events) + tauri.frames,
      logs: logCount(events) + tauri.logs,
      peerFrames: tauri.peerFrames,
      udpLogs: tauri.udpLogs,
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
    await service.open(udpServerEndpoint('phase05-mixed-electron-server'), {
      operationId: 'open-mixed-electron-server',
    });
    const port = service.sessions
      .get('phase05-mixed-electron-server')
      .socket.address().port;
    child = spawnManaged('cargo', [
      'test',
      '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
      'real_udp_transport_contract',
      '--', '--ignored', '--nocapture',
    ], {
      env: {
        ...process.env,
        INEED_PHASE05_UDP_MODE: 'client',
        INEED_PHASE05_UDP_SERVER_PORT: String(port),
      },
    });
    await waitFor(
      () => payloads(events, 'transport:peers').at(-1)?.peers.length === 1,
      'mixed Electron UDP server peer',
    );
    const peer = payloads(events, 'transport:peers').at(-1).peers[0];
    await waitFor(
      () => hasFrame(events, 'phase05-mixed-electron-server', 'in', [0x81, 0x82]),
      'mixed Electron UDP server inbound frame',
    );
    await service.send({
      endpointId: 'phase05-mixed-electron-server',
      bytes: Uint8Array.of(0x91, 0x92),
      target: { peerId: peer.id },
    });
    const output = await waitForManagedExit(child);
    const match = output.stdout.match(/^PHASE05_TAURI_CLIENT_RESULT=(.+)$/m);
    assert.ok(
      match,
      `Tauri mixed UDP client did not emit a result summary:\n${output.stdout}\n${output.stderr}`,
    );
    const tauri = JSON.parse(match[1]);
    await service.close('phase05-mixed-electron-server');
    const electronFrames = framesFor(events, 'phase05-mixed-electron-server');
    const electronLogs = logsFor(events, 'phase05-mixed-electron-server');
    assert.equal(electronFrames.every((frame) => frame.peerId === peer.id), true);
    assert.equal(electronLogs.every((log) => log.source === 'udp'), true);
    return {
      runtime: 'mixed',
      scenario: 'tauri-client-to-electron-server',
      frames: frameCount(events) + tauri.frames,
      logs: logCount(events) + tauri.logs,
      peerFrames: electronFrames.filter((frame) => frame.peerId === peer.id).length,
      udpLogs: electronLogs.length,
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

function bindSocket(socket) {
  return new Promise((resolve, reject) => {
    socket.once('error', reject);
    socket.bind(0, '127.0.0.1', () => {
      socket.off('error', reject);
      resolve();
    });
  });
}

function waitForMessage(socket) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('timed out waiting for UDP message'));
    }, STEP_TIMEOUT_MS);
    const onMessage = (bytes) => {
      cleanup();
      resolve(Buffer.from(bytes));
    };
    const onError = (error) => {
      cleanup();
      reject(error);
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off('message', onMessage);
      socket.off('error', onError);
    };
    socket.once('message', onMessage);
    socket.once('error', onError);
  });
}

function closeSocket(socket) {
  return new Promise((resolve) => {
    try {
      socket.close(resolve);
    } catch {
      resolve();
    }
  });
}

async function waitFor(predicate, label, timeoutMs = STEP_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), `timed out waiting for ${label}`);
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

function runCommand(command, args, options = {}) {
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
  try {
    summaries.push(await runElectronUdpLoopback());
    summaries.push(await runTauriUdpLoopback());
    summaries.push(await runElectronClientToTauriServer());
    summaries.push(await runTauriClientToElectronServer());
    assert.equal(summaries.every((summary) => summary.frames >= 4), true);
    assert.equal(summaries.every((summary) => summary.logs >= 2), true);
    assert.equal(summaries.every((summary) => summary.peerFrames >= 2), true);
    assert.equal(summaries.every((summary) => summary.udpLogs >= 2), true);
  } finally {
    await Promise.all([...managedChildren].map(terminateChild));
  }
  assert.equal(managedChildren.size, 0);
  process.stdout.write(`UDP_ACCEPTANCE_RESULT=${JSON.stringify({ summaries, managedChildren: 0 })}\n`);
}

await main();
