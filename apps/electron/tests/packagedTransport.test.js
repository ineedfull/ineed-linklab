import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import net from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

async function packagedService(t, filename) {
  const root = await mkdtemp(path.join(tmpdir(), 'ineed-packaged-transport-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const app = path.join(root, 'app');
  const dependency = path.join(app, 'node_modules', '@ineed-linklab', 'codecs');
  await mkdir(path.join(app, 'electron'), { recursive: true });
  await mkdir(dependency, { recursive: true });
  await cp(new URL(`../electron/${filename}`, import.meta.url), path.join(app, 'electron', filename));
  for (const entry of ['package.json', 'src']) {
    await cp(new URL(`../../../packages/codecs/${entry}`, import.meta.url), path.join(dependency, entry), { recursive: true });
  }
  // This directory deliberately has no repository-level packages/ tree.
  return createRequire(import.meta.url)(path.join(app, 'electron', filename));
}

test('packaged TCP service opens without a repository-level codecs directory', { timeout: 5000 }, async t => {
  const { TcpService } = await packagedService(t, 'tcpService.cjs');
  const service = new TcpService({ emitEvent: () => {} });
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await service.shutdown();
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => server.close(resolve));
  });
  await service.open({
    id: 'packaged-tcp',
    transport: 'tcp-client',
    config: { host: '127.0.0.1', port: server.address().port, receiveFraming: { mode: 'raw' } },
  }, { operationId: 'packaged-open' });
  await service.send({ endpointId: 'packaged-tcp', bytes: Uint8Array.of(0x31, 0x32) });
});

test('packaged serial service loads its default framer from production dependencies', async t => {
  const { SerialService } = await packagedService(t, 'serialService.cjs');
  const service = new SerialService({ SerialPort: class {} });
  const frames = [];
  const framer = await service.framerFactory({
    framing: { mode: 'fixed', length: 2 },
    emitFrame: bytes => frames.push([...bytes]),
    timers: globalThis,
  });
  framer.push(Uint8Array.of(0x31));
  assert.equal(frames.length, 0);
  framer.push(Uint8Array.of(0x32));
  assert.deepEqual(frames, [[0x31, 0x32]]);
  framer.reset();
});
