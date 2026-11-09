import assert from 'node:assert/strict';
import test from 'node:test';
import { readSystemOutput } from './system-output.mjs';

test('slow native sampling leaves SDK heartbeat timers running', async () => {
  let heartbeats = 0;
  const timer = setInterval(() => { heartbeats++; }, 10);
  try {
    const output = await readSystemOutput(process.execPath, ['-e', 'setTimeout(() => process.stdout.write(JSON.stringify({ sampled: true })), 250)']);
    assert.deepEqual(JSON.parse(output), { sampled: true });
    assert(heartbeats >= 5, `SDK heartbeat timer ran only ${heartbeats} times`);
  } finally { clearInterval(timer); }
});

test('native sampling failures propagate instead of becoming successful evidence', async () => {
  await assert.rejects(async () => readSystemOutput(process.execPath, ['-e', 'process.exit(2)']));
});
