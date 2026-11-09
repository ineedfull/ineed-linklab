import assert from 'node:assert/strict';
import test from 'node:test';
import { createMemoryObserver } from './memory-observer.mjs';

test('memory observer keeps only a summary for each independent ordered stream', () => {
  const observer = createMemoryObserver();
  for (let i = 1; i <= 10000; i++) for (const connection of ['server', 'client1', 'client2']) observer.push(connection, `load-tauri-${String(i).padStart(8, '0')}`);
  assert.equal(observer.count(), 30000); assert.equal(observer.size(), 3);
  assert.deepEqual(observer.snapshot('client2'), { count: 10000, lastSequence: 10000, prefix: 'load-tauri-', error: '' });
  assert(JSON.stringify(observer.snapshot('client2')).length < 120);
  observer.clear(); assert.equal(observer.count(), 0); assert.equal(observer.size(), 0);
});

test('memory observer rejects gaps, duplicates and prefix changes without storing bodies', () => {
  for (const bad of ['load-tauri-00000003', 'load-tauri-00000001', 'load-electron-00000002', 'load-tauri-bad']) {
    const observer = createMemoryObserver(); observer.push('client', 'load-tauri-00000001'); observer.push('client', bad);
    assert.match(observer.snapshot('client').error, /Out-of-order/);
  }
});
