/* global require, process, console */
// An isolated process owns its libuv pool and both ends of a real PTY pair.
const fs = require('node:fs');
const { Buffer } = require('node:buffer');
const { pbkdf2 } = require('node:crypto');
const { performance } = require('node:perf_hooks');
const { setTimeout, clearTimeout } = require('node:timers');
const { setTimeout: pause } = require('node:timers/promises');
const { serialOptions } = require('../../electron/modbusService.cjs');

async function main() {
  const options = serialOptions({ baudRate: 9600, dataBits: 8, parity: 'none',
    stopBits: 1, flowControl: 'none' });
  const port = await options.binding.open({ ...options, path: process.argv[2] });
  const peer = fs.openSync(process.argv[3], fs.constants.O_RDWR | fs.constants.O_NOCTTY | fs.constants.O_NONBLOCK);
  try {
    // File and crypto operations share this pool. Serial input must remain
    // readable while all four workers are occupied by background operations.
    const background = Array.from({ length: 4 }, () => new Promise((resolve, reject) => {
      pbkdf2('isolated-test', 'salt', 16_000_000, 32, 'sha256', error => error ? reject(error) : resolve());
    }));
    const buffer = Buffer.alloc(32);
    const started = performance.now();
    const pending = port.read(buffer, 0, buffer.length);
    fs.writeSync(peer, Buffer.from('input-ready'));
    let timer;
    const result = await Promise.race([
      pending.then(value => ({ received: buffer.subarray(0, value.bytesRead).toString(), elapsedMs: performance.now() - started })),
      new Promise(resolve => { timer = setTimeout(() => resolve({ received: null, elapsedMs: performance.now() - started }), 600); }),
    ]);
    clearTimeout(timer);
    await Promise.all(background);
    await pending;
    console.log(JSON.stringify(result));
  } finally {
    await port.close();
    fs.closeSync(peer);
    await pause(10);
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
