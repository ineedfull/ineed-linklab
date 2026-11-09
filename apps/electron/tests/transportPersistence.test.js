import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import net from 'node:net';
import { DatabaseSync } from 'node:sqlite';

const require = (await import('node:module')).createRequire(import.meta.url);
const { openConfigurationDatabase } = require('../electron/database.cjs');
const { createTransportPersistence } = require('../electron/transportPersistence.cjs');
const { TransportCoordinator } = require('../electron/transportCoordinator.cjs');

function createTimers() {
  let nextId = 1;
  const tasks = new Map();
  return {
    setTimeout(callback, delay) {
      const id = nextId;
      nextId += 1;
      tasks.set(id, { callback, delay });
      return id;
    },
    clearTimeout(id) {
      tasks.delete(id);
    },
    async run(delay) {
      const task = [...tasks.entries()].find(([, candidate]) => candidate.delay === delay);
      assert.ok(task, `missing timer with delay ${delay}`);
      tasks.delete(task[0]);
      await task[1].callback();
    },
    delays() {
      return [...tasks.values()].map(({ delay }) => delay);
    },
  };
}

async function createHarness(overrides = {}) {
  const frameBatches = [];
  const logBatches = [];
  const reports = [];
  const timers = createTimers();
  const database = {
    insertFrameBatch: async (rows) => frameBatches.push(rows),
    insertLogBatch: async (rows) => logBatches.push(rows),
    ...overrides.database,
  };
  const persistence = await createTransportPersistence({
    database,
    endpointReceiveMode: (endpointId) => {
      if (endpointId === 'delimiter-endpoint') return 'delimiter';
      if (endpointId === 'udp-server-1') return 'datagram';
      return 'raw';
    },
    reportError: (...args) => reports.push(args),
    timers,
    retryDelay: async () => {},
    ...overrides,
  });
  return { persistence, frameBatches, logBatches, reports, timers };
}

test('status persistence snapshots one structured log and skips null logs', async () => {
  const { persistence, logBatches } = await createHarness();
  const details = { path: '/dev/ttyUSB0', nested: ['stable'] };
  const log = {
    level: 'info', source: 'serial', code: null, message: '串口已打开: /dev/ttyUSB0',
    details, createdAt: 1_720_000_000_124,
  };

  persistence.handle('transport:status', {
    endpointId: 'serial-1', sessionId: 'session-1', status: 'open', error: null,
    createdAt: log.createdAt, log,
  });
  persistence.handle('transport:status', {
    endpointId: 'serial-1', sessionId: null, status: 'closed', error: null,
    createdAt: 1_720_000_000_002, log: null,
  });
  persistence.handle('transport:status', {
    endpointId: 'serial-1', sessionId: null, status: 'closed',
    error: { code: 'OPEN_CANCELLED', message: 'Serial open cancelled' },
    createdAt: 1_720_000_000_003, log: null,
  });
  details.path = 'mutated';
  details.nested[0] = 'mutated';
  await persistence.flush();

  assert.deepEqual(logBatches, [[{
    endpointId: 'serial-1', sessionId: 'session-1', peerId: null,
    level: 'info', source: 'serial', code: null, message: '串口已打开: /dev/ttyUSB0',
    details: { path: '/dev/ttyUSB0', nested: ['stable'] }, createdAt: 1_720_000_000_124,
  }]]);
});

test('status persistence preserves TCP peer log identity', async () => {
  const { persistence, logBatches } = await createHarness();

  persistence.handle('transport:status', {
    endpointId: 'tcp-server-1',
    sessionId: 'tcp-session-1',
    status: 'listening',
    error: null,
    createdAt: 1_720_000_000_127,
    log: {
      level: 'info',
      source: 'tcp',
      peerId: 'tcp-peer-1',
      code: null,
      message: 'TCP peer connected',
      details: { remoteAddress: '127.0.0.1:51000' },
      createdAt: 1_720_000_000_127,
    },
  });
  await persistence.flush();

  assert.equal(logBatches[0][0].peerId, 'tcp-peer-1');
});

test('frame persistence preserves every byte as HEX and resolves endpoint receive mode', async () => {
  const { persistence, frameBatches } = await createHarness();
  const bytes = [0, 128, 255];

  persistence.handle('transport:frames', {
    endpointId: 'delimiter-endpoint', sessionId: 'session-hex',
    frames: [{ direction: 'in', bytes, createdAt: 1_720_000_000_125 }],
  });
  bytes[0] = 42;
  await persistence.flush();

  assert.equal(frameBatches.length, 1);
  assert.equal(frameBatches[0].length, 1);
  assert.deepEqual(frameBatches[0][0], {
    endpointId: 'delimiter-endpoint', sessionId: 'session-hex', peerId: null,
    direction: 'in', format: 'hex', framing: 'delimiter',
    payload: Uint8Array.of(0, 128, 255), byteCount: 3, createdAt: 1_720_000_000_125,
  });
  assert.equal(frameBatches[0][0].payload instanceof Uint8Array, true);
});

test('frame persistence preserves TCP server peer identity', async () => {
  const { persistence, frameBatches } = await createHarness();

  persistence.handle('transport:frames', {
    endpointId: 'tcp-server-1',
    sessionId: 'tcp-session-1',
    frames: [{
      direction: 'in',
      peerId: 'tcp-peer-1',
      bytes: [0x41],
      createdAt: 1_720_000_000_126,
    }],
  });
  await persistence.flush();

  assert.equal(frameBatches[0][0].peerId, 'tcp-peer-1');
});

test('UDP persistence preserves peer identity, source, and exact timestamps', async () => {
  const { persistence, frameBatches, logBatches } = await createHarness();

  persistence.handle('transport:frames', {
    endpointId: 'udp-server-1', sessionId: 'udp-session-1',
    frames: [{
      direction: 'in', peerId: 'udp-peer-1', bytes: [0x55], createdAt: 1_720_000_000_128,
    }],
  });
  persistence.handle('transport:status', {
    endpointId: 'udp-server-1', sessionId: 'udp-session-1', status: 'listening',
    error: null, createdAt: 1_720_000_000_129,
    log: {
      level: 'info', source: 'udp', peerId: 'udp-peer-1', code: null,
      message: 'UDP peer discovered', details: { remoteAddress: '127.0.0.1:52000' },
      createdAt: 1_720_000_000_129,
    },
  });
  await persistence.flush();

  assert.equal(frameBatches[0][0].peerId, 'udp-peer-1');
  assert.equal(frameBatches[0][0].framing, 'datagram');
  assert.equal(frameBatches[0][0].createdAt, 1_720_000_000_128);
  assert.equal(logBatches[0][0].source, 'udp');
  assert.equal(logBatches[0][0].peerId, 'udp-peer-1');
  assert.equal(logBatches[0][0].createdAt, 1_720_000_000_129);
});

test('each queue flushes immediately at 200 rows', async () => {
  const { persistence, frameBatches, logBatches } = await createHarness();
  persistence.handle('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: Array.from({ length: 200 }, (_, index) => ({
      direction: index % 2 === 0 ? 'in' : 'out', bytes: [index % 256], createdAt: index + 1,
    })),
  });
  for (let index = 0; index < 200; index += 1) {
    persistence.handle('transport:status', {
      endpointId: 'serial-1', sessionId: 'session-1', status: 'open', error: null,
      createdAt: index + 1,
      log: {
        level: 'debug', source: 'serial', code: null, message: `log ${index}`,
        details: { path: '/dev/serial-1' }, createdAt: index + 1,
      },
    });
  }
  assert.deepEqual(frameBatches, []);
  assert.deepEqual(logBatches, []);
  await persistence.flush();

  assert.deepEqual(frameBatches.map((rows) => rows.length), [200]);
  assert.deepEqual(logBatches.map((rows) => rows.length), [200]);
});

test('small independent queues flush after one second and explicit flush drains both', async () => {
  const timed = await createHarness();
  timed.persistence.handle('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1], createdAt: 1 }],
  });
  assert.deepEqual(timed.timers.delays(), [1_000]);
  assert.deepEqual(timed.frameBatches, []);
  await timed.timers.run(1_000);
  assert.deepEqual(timed.frameBatches.map((rows) => rows.length), [1]);

  timed.persistence.handle('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: [{ direction: 'out', bytes: [2], createdAt: 2 }],
  });
  timed.persistence.handle('transport:status', {
    endpointId: 'serial-1', sessionId: null, status: 'opening', error: null, createdAt: 3,
    log: {
      level: 'debug', source: 'serial', code: null, message: 'opening',
      details: { path: '/dev/serial-1' }, createdAt: 3,
    },
  });
  await timed.persistence.flush();
  assert.deepEqual(timed.frameBatches.map((rows) => rows.length), [1, 1]);
  assert.deepEqual(timed.logBatches.map((rows) => rows.length), [1]);
  assert.deepEqual(timed.timers.delays(), []);
});

test('database and mapping failures are reported without throwing through handle or dispose', async () => {
  const reports = [];
  const databaseError = Object.assign(new Error('database unavailable'), { code: 'SQLITE_BUSY' });
  const { persistence } = await createHarness({
    database: {
      insertFrameBatch: async () => { throw databaseError; },
      insertLogBatch: async () => {},
    },
    endpointReceiveMode: () => { throw new Error('missing endpoint mode'); },
    reportError: (...args) => reports.push(args),
  });

  assert.doesNotThrow(() => persistence.handle('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1], createdAt: 1 }],
  }));
  assert.equal(reports.length, 1);

  const failingDatabase = await createHarness({
    database: {
      insertFrameBatch: async () => { throw databaseError; },
      insertLogBatch: async () => {},
    },
    reportError: (...args) => reports.push(args),
  });
  failingDatabase.persistence.handle('transport:frames', {
    endpointId: 'serial-1', sessionId: 'session-1',
    frames: [{ direction: 'in', bytes: [1], createdAt: 1 }],
  });
  await assert.rejects(failingDatabase.persistence.dispose(), { code: 'HISTORY_INCOMPLETE' });
  assert.equal(reports.some(([error]) => error === databaseError), true);
});

test('closing endpoint A drains mixed A and B history before A can be deleted', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ineed-transport-durability-'));
  const database = openConfigurationDatabase(path.join(directory, 'history.db'));
  let persistence = null;
  t.after(async () => {
    await persistence?.dispose();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  for (const id of ['serial-a', 'serial-b']) {
    database.insertEndpoint({
      id, name: id, transport: 'serial', config: { path: `/dev/${id}` },
    });
  }
  const reports = [];
  persistence = await createTransportPersistence({
    database,
    endpointReceiveMode: () => 'raw',
    reportError: (...args) => reports.push(args),
    retryDelay: async () => {},
  });
  persistence.handle('transport:frames', {
    endpointId: 'serial-a', sessionId: 'session-a',
    frames: [{ direction: 'in', bytes: [0xa], createdAt: 1_720_000_000_210 }],
  });
  persistence.handle('transport:frames', {
    endpointId: 'serial-b', sessionId: 'session-b',
    frames: [{ direction: 'in', bytes: [0xb], createdAt: 1_720_000_000_211 }],
  });
  persistence.handle('transport:status', {
    endpointId: 'serial-b', sessionId: 'session-b', status: 'open', error: null,
    createdAt: 1_720_000_000_211,
    log: {
      level: 'info', source: 'serial', code: null, message: 'open',
      details: { path: '/dev/serial-b' }, createdAt: 1_720_000_000_211,
    },
  });
  const coordinator = new TransportCoordinator({
    database,
    persistence,
    serialService: {
      async close(endpointId) {
        assert.equal(endpointId, 'serial-a');
        for (const [status, level, createdAt] of [
          ['closing', 'debug', 1_720_000_000_212],
          ['closed', 'info', 1_720_000_000_213],
        ]) {
          persistence.handle('transport:status', {
            endpointId, sessionId: 'session-a', status, error: null, createdAt,
            log: {
              level, source: 'serial', code: null, message: status,
              details: { path: '/dev/serial-a' }, createdAt,
            },
          });
        }
        return { closed: true };
      },
    },
  });

  assert.deepEqual(await coordinator.closeEndpoint('serial-a'), { closed: true });
  assert.equal(database.queryFrames({ endpointId: 'serial-a' }).total, 1);
  assert.deepEqual(
    database.queryLogs({ endpointId: 'serial-a' }).rows.map(({ message }) => message),
    ['closed', 'closing'],
  );
  assert.equal(database.deleteEndpoint('serial-a'), true);
  await persistence.flush();

  assert.equal(database.queryFrames({ endpointId: 'serial-a' }).total, 0);
  assert.equal(database.queryFrames({ endpointId: 'serial-b' }).total, 1);
  assert.equal(database.queryLogs({ endpointId: 'serial-b' }).total, 1);
  assert.deepEqual(reports, []);
});


test('real SQLite lock rejects flush, reports loss, then accepts later history', async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-persistence-lock-'));
  const file = path.join(directory, 'history.db');
  const database = openConfigurationDatabase(file);
  database.insertEndpoint({ id: 'locked', name: 'Locked', transport: 'tcp-server', config: {} });
  const blocker = new DatabaseSync(file);
  const reports = [];
  const persistence = await createTransportPersistence({ database, retryDelay: async () => {},
    reportError: (error, context) => reports.push({ error, context }) });
  t.after(async () => {
    await persistence.dispose().catch(() => {}); blocker.close(); database.close();
    await rm(directory, { recursive: true, force: true });
  });
  blocker.exec('BEGIN IMMEDIATE');
  persistence.handle('transport:frames', { endpointId: 'locked', sessionId: 's', frames: [
    { direction: 'in', bytes: [1], createdAt: Date.now() },
  ] });
  await assert.rejects(persistence.flush(), { code: 'HISTORY_INCOMPLETE' });
  assert.equal(database.queryFrames({}).total, 0);
  assert.match(reports[0].error.message, /locked/i);
  assert.equal(reports[0].context.rowCount, 1);
  blocker.exec('ROLLBACK');
  persistence.handle('transport:frames', { endpointId: 'locked', sessionId: 's', frames: [
    { direction: 'in', bytes: [2], createdAt: Date.now() },
  ] });
  await persistence.flush();
  assert.equal(database.queryFrames({}).total, 1);
});

for (const transport of ['tcp-client', 'tcp-server']) {
  for (const framing of [{ mode: 'delimiter', delimiterBytes: [10] }, { mode: 'fixed', length: 4 }, { mode: 'idle', idleMs: 1000 }]) {
    for (const closure of ['eof', 'user']) {
      test(`real ${transport} ${framing.mode} ${closure} persists final tail once`, { timeout: 5000 }, async (t) => {
        const { TcpService } = require('../electron/tcpService.cjs');
        const directory = await mkdtemp(path.join(os.tmpdir(), 'linklab-tcp-tail-'));
        const database = openConfigurationDatabase(path.join(directory, 'history.db'));
        const persistence = await createTransportPersistence({ database, retryDelay: async () => {} });
        const service = new TcpService({ emitEvent: (channel, payload) => persistence.handle(channel, payload) });
        let remote = null;
        let server = null;
        t.after(async () => {
          remote?.destroy(); await service.shutdown(); await persistence.dispose();
          if (server?.listening) await new Promise((resolve) => server.close(resolve));
          database.close(); await rm(directory, { recursive: true, force: true });
        });
        let port = 0;
        if (transport === 'tcp-client') {
          server = net.createServer((socket) => { remote = socket; });
          await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
          port = server.address().port;
        }
        const endpoint = { id: 'tail', name: 'Tail', transport, config: {
          host: '127.0.0.1', port, listenHost: '127.0.0.1', listenPort: 0, receiveFraming: framing,
        } };
        database.insertEndpoint(endpoint);
        await service.open(endpoint, { operationId: 'open' });
        const session = service.sessions.get('tail');
        if (transport === 'tcp-server') {
          remote = net.createConnection({ host: '127.0.0.1', port: session.server.address().port });
          await new Promise((resolve, reject) => { remote.once('connect', resolve); remote.once('error', reject); });
        }
        await waitUntil(() => remote !== null && (transport === 'tcp-client' || session.peers.size === 1));
        remote.write('xy');
        const receiving = transport === 'tcp-client' ? session.socket : [...session.peers.values()][0].socket;
        await waitUntil(() => receiving.bytesRead === 2);
        if (closure === 'user') await service.close('tail');
        else {
          remote.end();
          await waitUntil(() => transport === 'tcp-client' ? !service.sessions.has('tail') : session.peers.size === 0);
        }
        await persistence.flush();
        assert.deepEqual(database.queryFrames({ endpointId: 'tail' }).rows.map((row) => (
          Buffer.from(row.payloadBase64, 'base64').toString()
        )), ['xy']);
        await service.shutdown(); await persistence.flush();
        assert.equal(database.queryFrames({ endpointId: 'tail' }).total, 1);
      });
    }
  }
}

async function waitUntil(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
  assert.ok(predicate(), 'loopback condition was not met');
}


test('failed frame flush still waits for the independent log queue before returning', async () => {
  let release;
  const pendingLog = new Promise((resolve) => { release = resolve; });
  const { persistence } = await createHarness({ database: {
    insertFrameBatch: async () => { throw new Error('frame write failed'); },
    insertLogBatch: async () => { await pendingLog; },
  } });
  persistence.handle('transport:frames', { endpointId: 'e', sessionId: 's', frames: [
    { direction: 'in', bytes: [1], createdAt: Date.now() },
  ] });
  persistence.handle('transport:status', { endpointId: 'e', sessionId: 's', log: {
    level: 'info', source: 'tcp', code: null, message: 'log', details: {}, createdAt: Date.now(),
  } });
  let settled = false;
  const flush = persistence.flush().finally(() => { settled = true; });
  const rejected = assert.rejects(flush, { code: 'HISTORY_INCOMPLETE' });
  await new Promise((resolve) => setImmediate(resolve));
  const settledBeforeLog = settled;
  release();
  await rejected;
  await persistence.dispose();
  assert.equal(settledBeforeLog, false, 'close barriers must wait for every queue even after one fails');
});
