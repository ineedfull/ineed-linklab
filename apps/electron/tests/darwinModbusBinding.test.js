import assert from 'node:assert/strict';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { createDarwinModbusBinding } = require('../electron/darwinModbusBinding.cjs');

function fixture(overrides = {}) {
  const port = { isOpen: true, fd: 7, close() {}, write() {}, read() {} };
  const nativeBinding = { list: async () => ['native-port'], open: async () => port };
  return { port, nativeBinding, binding: createDarwinModbusBinding(nativeBinding, overrides) };
}

test('empty and retryable reads yield before the next read, preserving the caller buffer range', async () => {
  const buffer = Buffer.alloc(8);
  const trace = [];
  const answers = [0, Object.assign(new Error('again'), { code: 'EAGAIN' }), 2];
  const { binding, port } = fixture({
    read: async (fd, target, offset, length, position) => {
      trace.push('read');
      assert.equal(fd, 7); assert.equal(target, buffer);
      assert.equal(offset, 3); assert.equal(length, 2); assert.equal(position, null);
      const answer = answers.shift();
      if (answer instanceof Error) throw answer;
      target.set([12, 34].slice(0, answer), offset);
      return { bytesRead: answer, buffer: target };
    },
    wait: async milliseconds => { assert.ok(milliseconds > 0); trace.push('yield'); },
  });
  const write = port.write;
  assert.equal(await binding.open({}), port);
  assert.equal(port.write, write);
  assert.deepEqual(await binding.list(), ['native-port']);
  const result = await port.read(buffer, 3, 2);
  assert.equal(result.buffer, buffer); assert.equal(result.bytesRead, 2);
  assert.deepEqual([...buffer], [0, 0, 0, 12, 34, 0, 0, 0]);
  assert.deepEqual(trace, ['read', 'yield', 'read', 'yield', 'read']);
});

test('close during an idle wait cancels without reading a released or reused descriptor', async () => {
  let release;
  let reads = 0;
  const { binding, port } = fixture({
    read: async () => { reads++; return { bytesRead: 0 }; },
    wait: () => new Promise(resolve => { release = resolve; }),
  });
  await binding.open({});
  const pending = port.read(Buffer.alloc(8), 0, 8);
  await Promise.resolve();
  port.isOpen = false; port.fd = null;
  release();
  await assert.rejects(pending, error => error.canceled === true);
  assert.equal(reads, 1);
});

test('a late read result after close is cancelled instead of publishing stale data', async () => {
  let release;
  const { binding, port } = fixture({ read: () => new Promise(resolve => { release = resolve; }) });
  await binding.open({});
  const pending = port.read(Buffer.alloc(2), 0, 2);
  port.isOpen = false; port.fd = null;
  release({ bytesRead: 2, buffer: Buffer.from([1, 2]) });
  await assert.rejects(pending, error => error.canceled === true);
});

test('unplug errors retain their original details and request stream disconnection', async () => {
  const unplugged = Object.assign(new Error('device removed'), { code: 'ENXIO' });
  const { binding, port } = fixture({ read: async () => { throw unplugged; } });
  await binding.open({});
  await assert.rejects(port.read(Buffer.alloc(1), 0, 1), error => error === unplugged && error.disconnect);
});

test('invalid buffer ranges fail before native I/O', async () => {
  let reads = 0;
  const { binding, port } = fixture({ read: async () => { reads++; } });
  await binding.open({});
  await assert.rejects(port.read([], 0, 1), TypeError);
  for (const [offset, length] of [[-1, 1], [0, -1], [0.5, 1], [0, 3]]) {
    await assert.rejects(port.read(Buffer.alloc(2), offset, length), RangeError);
  }
  assert.equal(reads, 0);
});
