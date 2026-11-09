#!/usr/bin/env node

import assert from 'node:assert/strict';
import { constants as fsConstants } from 'node:fs';
import { access, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { isProcessAlive, ProcessSupervisor, readFirstLine } from './processSupervisor.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const OVERALL_TIMEOUT_MS = 180_000;
const STEP_TIMEOUT_MS = 8_000;
const MIN_RUNTIME_HISTORY_TIMESTAMP = 1_000_000_000_000;
const require = createRequire(import.meta.url);
const { SerialPort } = require('serialport');
const { openConfigurationDatabase } = require('../../apps/electron/electron/database.cjs');
const { SerialService } = require('../../apps/electron/electron/serialService.cjs');
const { createTransportPersistence } = require('../../apps/electron/electron/transportPersistence.cjs');

const activePairs = new Set();
const childSupervisor = new ProcessSupervisor();
let signalCleanupStarted = false;

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    if (signalCleanupStarted) return;
    signalCleanupStarted = true;
    try {
      await cleanupAllResources();
      process.exit(signal === 'SIGINT' ? 130 : 143);
    } catch (error) {
      console.error(error);
      process.exit(1);
    }
  });
}

class PeerPort {
  constructor(handle) {
    this.handle = handle;
  }

  static async open(portPath) {
    const flags = fsConstants.O_RDWR | fsConstants.O_NOCTTY | fsConstants.O_NONBLOCK;
    return new PeerPort(await open(portPath, flags));
  }

  async write(bytes) {
    const source = Buffer.from(bytes);
    let offset = 0;
    while (offset < source.length) {
      try {
        const { bytesWritten } = await this.handle.write(source, offset, source.length - offset);
        offset += bytesWritten;
      } catch (error) {
        if (error.code !== 'EAGAIN') throw error;
        await delay(5);
      }
    }
  }

  async readExactly(length, label) {
    const result = Buffer.alloc(length);
    let offset = 0;
    await waitFor(async () => {
      try {
        const { bytesRead } = await this.handle.read(result, offset, length - offset, null);
        offset += bytesRead;
      } catch (error) {
        if (error.code !== 'EAGAIN' && error.code !== 'EWOULDBLOCK') throw error;
      }
      return offset === length;
    }, STEP_TIMEOUT_MS, label);
    return result;
  }

  async close() {
    await this.handle.close().catch(() => {});
  }
}

async function createPtyPair(runtime) {
  const directory = await mkdtemp(path.join(tmpdir(), `ineed-phase03-${runtime}-`));
  const serviceLink = path.join(directory, 'service.pty');
  const peerLink = path.join(directory, 'peer.pty');
  const stderr = [];
  const childRecord = childSupervisor.spawn('socat', [
    '-d', '-d',
    `pty,raw,echo=0,link=${serviceLink}`,
    `pty,raw,echo=0,link=${peerLink}`,
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  const { child } = childRecord;
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => stderr.push(chunk));

  const pair = {
    runtime,
    directory,
    serviceLink,
    peerLink,
    servicePort: null,
    peerPort: null,
    child,
    childRecord,
    stderr,
    terminated: false,
    async terminateSocat() {
      if (this.terminated) return;
      this.terminated = true;
      await childSupervisor.terminate(childRecord);
    },
    async cleanup() {
      await this.terminateSocat();
      await rm(directory, { recursive: true, force: true });
      await assert.rejects(access(directory));
      activePairs.delete(this);
    },
  };
  activePairs.add(pair);

  try {
    await waitFor(async () => {
      if (child.exitCode !== null || child.signalCode !== null) {
        throw new Error(`socat exited before PTYs were ready: ${stderr.join('').trim()}`);
      }
      try {
        pair.servicePort = await realpath(serviceLink);
        pair.peerPort = await realpath(peerLink);
        return true;
      } catch (error) {
        if (error.code !== 'ENOENT') throw error;
        return false;
      }
    }, STEP_TIMEOUT_MS, `${runtime} PTY creation`);
    assert.notEqual(pair.servicePort, pair.peerPort);
    return pair;
  } catch (error) {
    await pair.cleanup();
    throw error;
  }
}

async function runElectron(pair) {
  const startedAt = Date.now();
  const observed = [];
  const ports = [];
  const databaseDirectory = await mkdtemp(path.join(tmpdir(), 'ineed-phase03-electron-history-'));
  const database = openConfigurationDatabase(path.join(databaseDirectory, 'history.sqlite'));
  const persistence = await createTransportPersistence({
    database,
    endpointReceiveMode(endpointId) {
      return database.listEndpoints().find(({ id }) => id === endpointId)?.config.receiveFraming.mode ?? 'raw';
    },
    reportError(error) {
      throw error;
    },
  });
  class TrackingSerialPort extends SerialPort {
    constructor(options) {
      super(options);
      ports.push(this);
    }

    static list() {
      return SerialPort.list();
    }
  }
  const service = new SerialService({
    SerialPort: TrackingSerialPort,
    emitEvent(channel, payload) {
      persistence.handle(channel, payload);
      observed.push({ channel, payload, observedAt: Date.now() });
    },
  });
  const peer = await PeerPort.open(pair.peerPort);
  const framingResults = {};
  let txBytes = 0;
  let rxBytes = 0;

  const openSession = async (name, receiveFraming) => {
    const endpoint = serialEndpoint(`electron-${name}-01`, pair.servicePort, receiveFraming);
    database.insertEndpoint({ ...endpoint, name: `Electron ${name} 01` });
    await service.open(endpoint, { operationId: `open-${name}` });
    return endpoint;
  };
  const assertClosed = async (port) => {
    await waitFor(() => port.listenerCount('data') === 0
      && port.listenerCount('error') === 0
      && port.listenerCount('close') === 0,
    STEP_TIMEOUT_MS, 'Electron listener cleanup');
    assert.equal(port.isOpen, false);
    assert.equal(port.listenerCount('data'), 0);
    assert.equal(port.listenerCount('error'), 0);
    assert.equal(port.listenerCount('close'), 0);
    assert.equal(service.sessions.size, 0);
  };

  try {
    const raw = await openSession('raw', { mode: 'raw' });
    const currentSessionId = service.sessions.get(raw.id).sessionId;
    await assert.rejects(service.send({ endpointId: raw.id, bytes: Uint8Array.of(0x68),
      target: { expectedSessionId: 'expired-simulator-session' } }), { code: 'OPEN_CANCELLED' });
    const textBytes = Buffer.from('TEXT:你好\n', 'utf8');
    const hexBytes = Buffer.from([0x00, 0x10, 0x7f, 0x80, 0xff]);
    const jsonBytes = Buffer.from(JSON.stringify({ phase: 3, runtime: 'electron' }), 'utf8');
    const outbound = [textBytes, hexBytes, jsonBytes];
    const outboundExpected = Buffer.concat(outbound);
    const batchStartedAt = Date.now();
    for (const bytes of outbound) {
      const requestBytes = new Uint8Array(bytes);
      await service.send({ endpointId: raw.id, bytes: requestBytes,
        target: { expectedSessionId: currentSessionId } });
      requestBytes.fill(0xaa);
      txBytes += bytes.length;
    }
    assert.deepEqual(await peer.readExactly(outboundExpected.length, 'Electron outbound bytes'), outboundExpected);
    await waitFor(() => outboundFrames(observed, raw.id).length === 3,
      STEP_TIMEOUT_MS, 'Electron 200 ms outbound batch');
    const outboundEvent = observed.find((event) => event.channel === 'transport:frames'
      && event.payload.endpointId === raw.id && event.payload.frames.some((frame) => frame.direction === 'out'));
    const batchDelayMs = outboundEvent.observedAt - batchStartedAt;
    assert.ok(batchDelayMs >= 150 && batchDelayMs < 2_000,
      `Electron frame batch delay was ${batchDelayMs} ms`);
    assert.deepEqual(outboundFrames(observed, raw.id).map((frame) => Buffer.from(frame.bytes)), outbound);

    const inbound = Buffer.concat(outbound);
    await peer.write(inbound);
    rxBytes += inbound.length;
    await waitFor(() => byteLength(inboundFrames(observed, raw.id)) === inbound.length,
      STEP_TIMEOUT_MS, 'Electron raw receive');
    assert.deepEqual(joinFrames(inboundFrames(observed, raw.id)), inbound);
    framingResults.raw = { frames: inboundFrames(observed, raw.id).length, bytes: inbound.length };
    await service.close(raw.id);
    await assertClosed(ports.at(-1));

    const historyEndpoint = await openSession('history', {
      mode: 'delimiter', delimiterBytes: [0x0d, 0x0a],
    });
    const historyOutbound = [Buffer.from('OUT-01'), Buffer.from('OUT-02')];
    const historyInbound = [Buffer.from('IN-01'), Buffer.from('IN-02')];
    for (const bytes of historyOutbound) {
      await service.send({ endpointId: historyEndpoint.id, bytes: new Uint8Array(bytes) });
      txBytes += bytes.length;
    }
    assert.deepEqual(
      await peer.readExactly(Buffer.concat(historyOutbound).length, 'Electron numbered outbound bytes'),
      Buffer.concat(historyOutbound),
    );
    await waitFor(() => outboundFrames(observed, historyEndpoint.id).length === historyOutbound.length,
      STEP_TIMEOUT_MS, 'Electron numbered outbound frames');
    await peer.write(Buffer.concat(historyInbound.flatMap((bytes) => [bytes, Buffer.from('\r\n')])));
    rxBytes += historyInbound.reduce((total, bytes) => total + bytes.length + 2, 0);
    await waitFor(() => inboundFrames(observed, historyEndpoint.id).length === historyInbound.length,
      STEP_TIMEOUT_MS, 'Electron numbered inbound frames');
    assert.deepEqual(inboundFrames(observed, historyEndpoint.id).map((frame) => Buffer.from(frame.bytes)), historyInbound);
    await service.close(historyEndpoint.id);
    await assertClosed(ports.at(-1));

    const delimiter = await openSession('delimiter', { mode: 'delimiter', delimiterBytes: [0x0d, 0x0a] });
    await peer.write(Buffer.from('alpha\r'));
    await delay(30);
    await peer.write(Buffer.from('\nbeta\r\n'));
    rxBytes += 13;
    await waitFor(() => inboundFrames(observed, delimiter.id).length === 2,
      STEP_TIMEOUT_MS, 'Electron delimiter receive');
    assert.deepEqual(inboundFrames(observed, delimiter.id).map((frame) => Buffer.from(frame.bytes)),
      [Buffer.from('alpha'), Buffer.from('beta')]);
    framingResults.delimiter = { frames: 2, bytes: 13, crossChunk: true };
    await service.close(delimiter.id);
    await assertClosed(ports.at(-1));

    const fixed = await openSession('fixed', { mode: 'fixed', length: 4 });
    const fixedBytes = Buffer.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
    await peer.write(fixedBytes);
    rxBytes += fixedBytes.length;
    await waitFor(() => inboundFrames(observed, fixed.id).length === 3,
      STEP_TIMEOUT_MS, 'Electron fixed receive');
    assert.deepEqual(inboundFrames(observed, fixed.id).map((frame) => Buffer.from(frame.bytes)),
      [fixedBytes.subarray(0, 4), fixedBytes.subarray(4, 8), fixedBytes.subarray(8, 12)]);
    framingResults.fixed = { frames: 3, bytes: fixedBytes.length };
    await service.close(fixed.id);
    await assertClosed(ports.at(-1));

    const idle = await openSession('idle', { mode: 'idle', idleMs: 90 });
    await peer.write(Buffer.from([0x41, 0x42]));
    await delay(40);
    assert.equal(inboundFrames(observed, idle.id).length, 0);
    const idleStartedAt = Date.now();
    await peer.write(Buffer.from([0x43, 0x44]));
    rxBytes += 4;
    await waitFor(() => inboundFrames(observed, idle.id).length === 1,
      STEP_TIMEOUT_MS, 'Electron idle receive');
    const idleDelayMs = Date.now() - idleStartedAt;
    assert.ok(idleDelayMs >= 70, `Electron idle frame emitted after only ${idleDelayMs} ms`);
    assert.deepEqual(Buffer.from(inboundFrames(observed, idle.id)[0].bytes), Buffer.from('ABCD'));
    framingResults.idle = { frames: 1, bytes: 4, idleDelayMs };
    await service.close(idle.id);
    await assertClosed(ports.at(-1));

    const removed = await openSession('removed', { mode: 'raw' });
    await pair.terminateSocat();
    await assert.rejects(
      service.send({ endpointId: removed.id, bytes: Uint8Array.of(0x55) }),
      (error) => error?.code === 'DEVICE_REMOVED',
    );
    await waitFor(() => statusEvents(observed, removed.id).some((status) => status.status === 'error'),
      STEP_TIMEOUT_MS, 'Electron removal error');
    const removalError = statusEvents(observed, removed.id)
      .find((status) => status.status === 'error')?.error;
    assert.equal(removalError?.code, 'DEVICE_REMOVED',
      `Electron removal mapped to ${JSON.stringify(removalError)}`);
    await waitFor(() => statusEvents(observed, removed.id).some((status) => status.status === 'closed'),
      STEP_TIMEOUT_MS, 'Electron closed after removal');
    await assertClosed(ports.at(-1));
    await delay(50);
    const terminalStatuses = statusEvents(observed, removed.id)
      .filter((status) => status.status === 'error' || status.status === 'closed');
    assert.equal(terminalStatuses.filter((status) => status.status === 'error').length, 1);
    assert.equal(terminalStatuses.filter((status) => status.status === 'closed').length, 1);
    assert.deepEqual(terminalStatuses.map((status) => [status.status, status.error?.code ?? null]), [
      ['error', 'DEVICE_REMOVED'],
      ['closed', null],
    ]);

    await service.shutdown();
    await persistence.flush();
    const history = assertElectronHistory({ database, observed, endpointId: historyEndpoint.id });
    return {
      runtime: 'electron',
      servicePort: pair.servicePort,
      peerPort: pair.peerPort,
      txBytes,
      rxBytes,
      framing: framingResults,
      batchDelayMs,
      removalError: 'DEVICE_REMOVED',
      terminalErrors: 1,
      terminalClosed: 1,
      closedAfterRemoval: true,
      resourcesClean: service.sessions.size === 0 && ports.every((port) => !port.isOpen),
      history,
      durationMs: Date.now() - startedAt,
    };
  } finally {
    await peer.close();
    service.forceShutdown();
    await persistence.dispose();
    database.close();
    await rm(databaseDirectory, { recursive: true, force: true });
  }
}

async function runTauri(pair) {
  const result = await runCommand('cargo', [
    'test',
    '--manifest-path', path.join(ROOT, 'apps/tauri/src-tauri/Cargo.toml'),
    'real_pty_transport_contract',
    '--', '--ignored', '--nocapture',
  ], {
    cwd: ROOT,
    env: {
      ...process.env,
      INEED_PHASE03_SERVICE_PTY: pair.serviceLink,
      INEED_PHASE03_PEER_PTY: pair.peerLink,
      INEED_PHASE03_SOCAT_PID: String(pair.child.pid),
    },
    timeoutMs: 120_000,
  });
  const match = result.stdout.match(/^PHASE03_TAURI_RESULT=(.+)$/m);
  assert.ok(match, `Tauri probe did not emit a result summary:\n${result.stdout}\n${result.stderr}`);
  const summary = JSON.parse(match[1]);
  assert.equal(summary.runtime, 'tauri');
  assert.equal(summary.terminalErrors, 1);
  assert.equal(summary.terminalClosed, 1);
  return summary;
}

function serialEndpoint(id, portPath, receiveFraming) {
  return {
    id,
    transport: 'serial',
    config: {
      path: portPath,
      baudRate: 115_200,
      dataBits: 8,
      parity: 'none',
      stopBits: 1,
      flowControl: 'none',
      receiveFraming,
    },
  };
}

function frameEvents(observed, endpointId) {
  return observed
    .filter((event) => event.channel === 'transport:frames' && event.payload.endpointId === endpointId)
    .flatMap((event) => event.payload.frames);
}

function inboundFrames(observed, endpointId) {
  return frameEvents(observed, endpointId).filter((frame) => frame.direction === 'in');
}

function outboundFrames(observed, endpointId) {
  return frameEvents(observed, endpointId).filter((frame) => frame.direction === 'out');
}

function statusEvents(observed, endpointId) {
  return observed
    .filter((event) => event.channel === 'transport:status' && event.payload.endpointId === endpointId)
    .map((event) => event.payload);
}

function joinFrames(frames) {
  return Buffer.concat(frames.map((frame) => Buffer.from(frame.bytes)));
}

function byteLength(frames) {
  return frames.reduce((total, frame) => total + frame.bytes.length, 0);
}

function assertRuntimeHistoryTimestamp(createdAt, label, latestEpochMillis) {
  assert.ok(Number.isSafeInteger(createdAt),
    `${label} timestamp must be a safe millisecond value: ${createdAt}`);
  assert.ok(createdAt >= MIN_RUNTIME_HISTORY_TIMESTAMP,
    `${label} timestamp must be a safe millisecond value: ${createdAt}`);
  assert.ok(createdAt <= latestEpochMillis,
    `${label} timestamp must be a current epoch-millisecond value: ${createdAt}`);
}

function assertSummaryHistoryTimestamps(rows, label, latestEpochMillis) {
  assert.ok(Array.isArray(rows), `${label} timestamp evidence must be an array`);
  for (const createdAt of rows) {
    assertRuntimeHistoryTimestamp(createdAt, label, latestEpochMillis);
  }
}

function assertElectronHistory({ database, observed, endpointId }) {
  const statusLogEvents = observed
    .filter((event) => event.channel === 'transport:status'
      && event.payload.endpointId === endpointId && event.payload.log !== null);
  for (const event of statusLogEvents) {
    assert.equal(event.payload.log.createdAt, event.payload.createdAt,
      'serial status log timestamp must match its owning status event timestamp');
  }
  const expectedFrames = observed
    .filter((event) => event.channel === 'transport:frames' && event.payload.endpointId === endpointId)
    .flatMap((event) => event.payload.frames.map((frame) => ({
      endpointId: event.payload.endpointId,
      sessionId: event.payload.sessionId,
      direction: frame.direction,
      payload: Buffer.from(frame.bytes),
      byteCount: frame.bytes.length,
      createdAt: frame.createdAt,
    })));
  const expectedLogs = statusLogEvents
    .map((event) => ({
      endpointId: event.payload.endpointId,
      sessionId: event.payload.sessionId,
      ...event.payload.log,
    }));
  const frames = database.queryFrames({ endpointId, page: 1, pageSize: 200 });
  const logs = database.queryLogs({ endpointId, page: 1, pageSize: 200 });
  const latestEpochMillis = Date.now() + 60_000;

  assert.equal(frames.total, expectedFrames.length, 'every serial frame must be persisted');
  assert.equal(frames.rows.length, expectedFrames.length, 'frame query must return the exact total');
  assert.equal(logs.total, expectedLogs.length, 'every serial status log must be persisted');
  assert.equal(logs.rows.length, expectedLogs.length, 'log query must return the exact total');

  const actualFrames = [...frames.rows].reverse().map((frame) => ({
    endpointId: frame.endpointId,
    sessionId: frame.sessionId,
    direction: frame.direction,
    payload: Buffer.from(frame.payloadBase64, 'base64'),
    byteCount: frame.byteCount,
    createdAt: frame.createdAt,
  }));
  assert.deepEqual(actualFrames, expectedFrames);
  for (const frame of frames.rows) {
    assert.equal(frame.byteCount, Buffer.from(frame.payloadBase64, 'base64').byteLength);
    assertRuntimeHistoryTimestamp(frame.createdAt, 'frame', latestEpochMillis);
  }

  const actualLogs = [...logs.rows].reverse().map((log) => ({
    endpointId: log.endpointId,
    sessionId: log.sessionId,
    level: log.level,
    source: log.source,
    code: log.code,
    message: log.message,
    details: log.details,
    createdAt: log.createdAt,
  }));
  assert.deepEqual(actualLogs, expectedLogs);
  assert.equal(logs.rows.some((log) => log.level === 'info' && log.source === 'serial'), true,
    'serial open and close events must persist info logs');
  assert.equal(logs.rows.some((log) => log.message.startsWith('串口已关闭:')), true,
    'serial close must be persisted before the explicit flush returns');
  for (const log of logs.rows) {
    assertRuntimeHistoryTimestamp(log.createdAt, 'log', latestEpochMillis);
  }

  return {
    frames: {
      total: frames.total,
      inbound: frames.rows.filter((frame) => frame.direction === 'in').length,
      outbound: frames.rows.filter((frame) => frame.direction === 'out').length,
      createdAt: actualFrames.map((frame) => frame.createdAt),
      payloads: actualFrames.map((frame) => ({
        direction: frame.direction,
        bytes: [...frame.payload],
      })),
    },
    logs: {
      total: logs.total,
      infoSerial: logs.rows.filter((log) => log.level === 'info' && log.source === 'serial').length,
      createdAt: actualLogs.map((log) => log.createdAt),
    },
  };
}

async function waitFor(predicate, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      if (await predicate()) return;
      lastError = undefined;
    } catch (error) {
      lastError = error;
    }
    await delay(10);
  }
  if (lastError) throw lastError;
  throw new Error(`Timed out after ${timeoutMs} ms waiting for ${label}`);
}

async function runCommand(command, args, {
  cwd,
  env,
  timeoutMs,
  supervisor = childSupervisor,
}) {
  const record = supervisor.spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const { child } = record;
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  let timeout;
  const timeoutResult = new Promise((resolve) => {
    timeout = setTimeout(() => resolve({ type: 'timeout' }), timeoutMs);
  });
  const outcome = await Promise.race([
    record.exitPromise.then((result) => ({ type: 'exit', result })),
    timeoutResult,
  ]);
  clearTimeout(timeout);

  if (outcome.type === 'timeout') {
    const termination = await supervisor.terminate(record);
    const error = new Error(`${command} timed out after ${timeoutMs} ms`);
    Object.assign(error, { code: 'PROCESS_TIMEOUT', stdout, stderr, termination });
    throw error;
  }

  const result = await supervisor.finish(record);
  if (outcome.result.error) {
    Object.assign(outcome.result.error, { stdout, stderr });
    throw outcome.result.error;
  }
  if (result.code !== 0) {
    const error = new Error(`${command} exited with ${result.code ?? result.signal}\n${stdout}\n${stderr}`);
    Object.assign(error, { code: 'PROCESS_EXIT', stdout, stderr, result });
    throw error;
  }
  return { stdout, stderr };
}

async function cleanupPairs() {
  const results = await Promise.allSettled([...activePairs].map((pair) => pair.cleanup()));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure) throw failure.reason;
}

async function cleanupAllResources() {
  let pairError;
  try {
    await cleanupPairs();
  } catch (error) {
    pairError = error;
  }
  await childSupervisor.cleanupAll();
  if (pairError) throw pairError;
}

function stubbornProcessTreeCommand() {
  const source = [
    "trap '' TERM",
    "(trap '' TERM; while :; do sleep 1; done) &",
    'echo $!',
    'while :; do sleep 1; done',
  ].join('\n');
  return { command: '/bin/sh', args: ['-c', source] };
}

async function runProcessSupervisorSelfTest() {
  assert.notEqual(process.platform, 'win32', 'process-group self-test requires POSIX');
  const supervisor = new ProcessSupervisor({ termTimeoutMs: 100, killTimeoutMs: 1_000 });
  const stubbornTree = stubbornProcessTreeCommand();

  let timeoutError;
  try {
    await runCommand(stubbornTree.command, stubbornTree.args, {
      cwd: ROOT,
      env: process.env,
      timeoutMs: 1_000,
      supervisor,
    });
  } catch (error) {
    timeoutError = error;
  }
  assert.equal(timeoutError?.code, 'PROCESS_TIMEOUT');
  const timeoutDescendantPid = Number.parseInt(timeoutError.stdout.trim(), 10);
  assert.ok(Number.isSafeInteger(timeoutDescendantPid));
  const timeoutResult = {
    escalated: timeoutError.termination.escalated,
    leaderGone: !isProcessAlive(timeoutError.termination.pid),
    descendantGone: !isProcessAlive(timeoutDescendantPid),
  };

  const signalRecord = supervisor.spawn(stubbornTree.command, stubbornTree.args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const signalDescendantPid = Number.parseInt(await readFirstLine(signalRecord.child.stdout, 2_000), 10);
  assert.ok(Number.isSafeInteger(signalDescendantPid));
  const signalTermination = await supervisor.terminate(signalRecord);
  const signalResult = {
    escalated: signalTermination.escalated,
    leaderGone: !isProcessAlive(signalRecord.pid),
    descendantGone: !isProcessAlive(signalDescendantPid),
  };

  await runCommand(process.execPath, ['-e', ''], {
    cwd: ROOT,
    env: process.env,
    timeoutMs: 10_000,
    supervisor,
  });

  await supervisor.cleanupAll();
  return {
    timeout: timeoutResult,
    signal: signalResult,
    naturalExit: true,
    trackedChildren: supervisor.size,
  };
}

async function runProcessSupervisorSignalSelfTest() {
  assert.notEqual(process.platform, 'win32', 'process-group self-test requires POSIX');
  const stubbornTree = stubbornProcessTreeCommand();
  const record = childSupervisor.spawn(stubbornTree.command, stubbornTree.args, {
    cwd: ROOT,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const descendantPid = Number.parseInt(await readFirstLine(record.child.stdout, 2_000), 10);
  assert.ok(Number.isSafeInteger(descendantPid));
  console.log(`PROCESS_SUPERVISOR_SIGNAL_READY=${JSON.stringify({
    leaderPid: record.pid,
    descendantPid,
  })}`);
  await new Promise(() => {});
}

function selectedRuntimes() {
  const index = process.argv.indexOf('--runtime');
  const selected = index === -1 ? 'all' : process.argv[index + 1];
  assert.ok(['all', 'electron', 'tauri'].includes(selected),
    '--runtime must be all, electron, or tauri');
  return selected === 'all' ? ['electron', 'tauri'] : [selected];
}

async function main() {
  try {
    await runCommand('socat', ['-V'], {
      cwd: ROOT,
      env: process.env,
      timeoutMs: STEP_TIMEOUT_MS,
    });
  } catch (error) {
    if (error.code === 'ENOENT' && process.env.INEED_ALLOW_PTY_SKIP === '1') {
      console.log(`PHASE03_PTY_SKIPPED=${JSON.stringify({ reason: 'socat-not-installed' })}`);
      return;
    }
    if (error.code === 'ENOENT') {
      throw new Error('Phase 03 PTY probe failed: socat is not installed; install socat before verification', {
        cause: error,
      });
    }
    throw error;
  }

  const summaries = [];
  for (const runtime of selectedRuntimes()) {
    const pair = await createPtyPair(runtime);
    try {
      summaries.push(runtime === 'electron' ? await runElectron(pair) : await runTauri(pair));
    } finally {
      await pair.cleanup();
    }
  }
  const latestEpochMillis = Date.now() + 60_000;
  for (const summary of summaries) {
    const { history } = summary;
    assert.ok(history, `${summary.runtime} PTY result must include a flushed SQLite history query`);
    assert.equal(history.frames.total, history.frames.inbound + history.frames.outbound);
    assert.equal(history.frames.total, 4, `${summary.runtime} must persist four history frames`);
    assert.ok(history.frames.inbound > 0 && history.frames.outbound > 0);
    assert.ok(history.frames.payloads.every(({ bytes }) => Array.isArray(bytes) && bytes.length > 0));
    assert.equal(history.frames.createdAt.length, history.frames.total);
    assertSummaryHistoryTimestamps(history.frames.createdAt, `${summary.runtime} frame`, latestEpochMillis);
    assert.equal(history.logs.total, 4, `${summary.runtime} must persist four status logs`);
    assert.ok(history.logs.infoSerial > 0);
    assert.equal(history.logs.createdAt.length, history.logs.total);
    assertSummaryHistoryTimestamps(history.logs.createdAt, `${summary.runtime} log`, latestEpochMillis);
  }
  assert.equal(activePairs.size, 0, 'PTY pair registry must be empty before reporting success');
  assert.equal(childSupervisor.size, 0, 'child registry must be empty before reporting success');
  console.log(`PHASE03_PTY_RESULT=${JSON.stringify({ summaries, managedChildren: 0 })}`);
}

let overallTimer;
try {
  let work;
  if (process.argv.includes('--self-test-process-supervisor-signal')) {
    work = runProcessSupervisorSignalSelfTest();
  } else if (process.argv.includes('--self-test-process-supervisor')) {
    work = runProcessSupervisorSelfTest().then((summary) => {
      console.log(`PROCESS_SUPERVISOR_SELF_TEST=${JSON.stringify(summary)}`);
    });
  } else {
    work = main();
  }
  await Promise.race([
    work,
    new Promise((_, reject) => {
      overallTimer = setTimeout(() => reject(new Error(
        `Phase 03 PTY probe exceeded ${OVERALL_TIMEOUT_MS} ms overall timeout`,
      )), OVERALL_TIMEOUT_MS);
    }),
  ]);
} finally {
  clearTimeout(overallTimer);
  await cleanupAllResources();
}
