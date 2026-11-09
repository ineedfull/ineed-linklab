import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import test from 'node:test';
const require = createRequire(import.meta.url);
const { TcpService } = require('../electron/tcpService.cjs');
const { UdpService } = require('../electron/udpService.cjs');
const { ModbusService } = require('../electron/modbusService.cjs');
const { TransportCoordinator } = require('../electron/transportCoordinator.cjs');

class PendingSocket extends EventEmitter {
  destroyed = false;
  listening = false;
  bind() {}
  listen() {}
  setNoDelay() {}
  setKeepAlive() {}
  pause() {}
  resume() {}
  destroy() { this.destroyed = true; this.emit('close'); }
  close(callback) { this.destroy(); callback?.(); }
}

for (const transport of ['tcp-client', 'tcp-server', 'udp-client', 'udp-server']) {
  test(`${transport} cancellation releases the opening resource and prevents late success`, async (t) => {
    const resource = new PendingSocket();
    const events = [];
    const emitEvent = (_channel, event) => events.push(event);
    const tcp = new TcpService({ emitEvent, netModule: {
      createConnection: () => resource, createServer: () => resource,
    } });
    const udp = new UdpService({ emitEvent, dgramModule: { createSocket: () => resource } });
    const endpoint = { id: 'endpoint', transport, config: {
      host: '127.0.0.1', port: 1502, listenHost: '127.0.0.1', listenPort: 1502,
      bindHost: '127.0.0.1', bindPort: 0, targetHost: '127.0.0.1', targetPort: 1502,
    } };
    const native = new TransportCoordinator({ serialService: {}, tcpService: tcp, udpService: udp,
      database: { listEndpoints: () => [endpoint] } });
    t.after(async () => { await tcp.closeAll(); await udp.closeAll(); });
    const opening = native.open('endpoint', { operationId: 'open-1' });
    const rejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
    await new Promise((resolve) => setImmediate(resolve));
    const stale = await native.cancelOpen('endpoint', { operationId: 'another-open' });
    assert.equal(stale.cancelled, false);
    assert.equal(resource.destroyed, false);
    const cancelled = await native.cancelOpen('endpoint', { operationId: 'open-1' });
    assert.equal(cancelled.cancelled, true);
    await rejected;
    assert.equal(resource.destroyed, true);
    resource.emit('connect');
    resource.emit('listening');
    assert.equal(events.some(({ status }) => ['open', 'listening'].includes(status)), false);
    assert.equal(tcp.sessions.size + udp.sessions.size, 0);
  });
}

test('Modbus cancellation owns the pending client and cleans a late connect completion', async (t) => {
  let resolveConnect;
  let closed = 0;
  const events = [];
  class PendingClient {
    setID() {}
    setTimeout() {}
    connectTCP() { return new Promise((resolve) => { resolveConnect = resolve; }); }
    close(callback) { closed += 1; callback(); }
  }
  const service = new ModbusService({ ModbusRTU: PendingClient,
    emitTransportEvent: (_channel, event) => events.push(event) });
  t.after(() => service.forceShutdown());
  const endpoint = { id: 'master', transport: 'modbus-tcp-master', config: { host: '127.0.0.1', port: 1502 } };
  const native = new TransportCoordinator({ serialService: {}, modbusService: service,
    database: { listEndpoints: () => [endpoint] } });
  const opening = native.open('master', { operationId: 'open-1' });
  const rejected = assert.rejects(opening, (error) => error.code === 'OPEN_CANCELLED');
  const cancelled = await native.cancelOpen('master', { operationId: 'open-1' });
  assert.equal(cancelled.cancelled, true);
  await rejected;
  resolveConnect();
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(closed > 0);
  assert.equal(service.sessions.size, 0);
  assert.equal(service.opening.size, 0);
  assert.equal(events.some(({ status }) => status === 'open'), false);
});

test('RTU master cancellation waits for the late serial open and releases its port', async () => {
  let resolveConnect;
  let portOpen = false;
  class PendingRtuClient {
    setID() {}
    setTimeout() {}
    connectRTUBuffered() { return new Promise((resolve) => { resolveConnect = () => { portOpen = true; resolve(); }; }); }
    // modbus-serial exposes destroy even when its RTU port cannot be destroyed.
    destroy(callback) { callback(); }
    close(callback) { portOpen = false; callback(); }
  }
  const service = new ModbusService({ ModbusRTU: PendingRtuClient });
  const opening = service.open({ id: 'rtu', transport: 'modbus-rtu-master', config: { path: '/dev/tty.test' } }, { operationId: 'open-rtu' });
  const rejected = assert.rejects(opening, { code: 'OPEN_CANCELLED' });
  let acknowledged = false;
  const cancelling = service.cancelOpen('rtu', { operationId: 'open-rtu' }).then(() => { acknowledged = true; });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(acknowledged, false);
  resolveConnect();
  await cancelling; await rejected;
  assert.equal(portOpen, false);
  assert.equal(service.sessions.size, 0);
});

test('a failed cancellation cleanup remains owned and can be retried', async () => {
  let resolveConnect;
  let attempts = 0;
  class PendingClient {
    setID() {}
    setTimeout() {}
    connectTCP() { return new Promise((resolve) => { resolveConnect = resolve; }); }
    close(callback) { attempts += 1; callback(attempts === 1 ? new Error('close failed') : null); }
  }
  const service = new ModbusService({ ModbusRTU: PendingClient });
  const endpoint = { id: 'retry', transport: 'modbus-tcp-master', config: {} };
  const opening = service.open(endpoint, { operationId: 'open-1' });
  const rejected = assert.rejects(opening);
  await assert.rejects(service.cancelOpen('retry', { operationId: 'open-1' }), /close failed/);
  await rejected;
  assert.equal(service.opening.size, 1);
  const result = await service.cancelOpen('retry', { operationId: 'open-1' });
  assert.equal(result.cancelled, true);
  assert.equal(service.opening.size, 0);
  resolveConnect(); await new Promise((resolve) => setImmediate(resolve));
  assert.equal(service.sessions.size, 0);
});
