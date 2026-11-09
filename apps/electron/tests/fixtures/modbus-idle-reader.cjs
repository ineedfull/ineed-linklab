/* global require, process, console */
// Separate process so syscall observation cannot affect other native tests.
const fs = require('node:fs');
const assert = require('node:assert/strict');
const { setTimeout: pause } = require('node:timers/promises');
const originalRead = fs.read;
let reads = 0;
let emptyReads = 0;
fs.read = function (...args) {
  reads++;
  const callback = args.at(-1);
  args[args.length - 1] = function (error, bytesRead, ...rest) {
    if (!error && bytesRead === 0) emptyReads++;
    return callback.call(this, error, bytesRead, ...rest);
  };
  return originalRead.apply(this, args);
};
// Keep Node's custom promisify metadata: serialport captures it on require.
for (const symbol of Object.getOwnPropertySymbols(originalRead)) {
  Object.defineProperty(fs.read, symbol, Object.getOwnPropertyDescriptor(originalRead, symbol));
}
const ModbusRTU = require('modbus-serial');
const { ModbusService } = require('../../electron/modbusService.cjs');

async function main() {
  const service = new ModbusService({ ModbusRTU });
  const config = { baudRate: 9600, dataBits: 8, parity: 'none', stopBits: 1,
    flowControl: 'none', unitId: 1, timeoutMs: 1000 };
  const slave = { id: 'idle-slave', transport: 'modbus-rtu-slave', config: {
    ...config, path: process.argv[2],
    dataAreas: { holdingRegisters: { start: 0, count: 2, values: [12, 34] } },
  } };
  const master = { id: 'idle-master', transport: 'modbus-rtu-master', config: {
    ...config, path: process.argv[3],
  } };
  try {
    await service.open(slave, { operationId: 'first-slave' });
    await service.open(master, { operationId: 'first-master' });
    const before = reads;
    await pause(200);
    const idleReads = reads - before;
    // Empty PTYs should wait for readability, rather than queue thousands of
    // successful zero-byte fs.read calls and promises while no data exists.
    assert.ok(idleReads <= 256, `Idle serial read loop: ${idleReads} reads / 200ms (${emptyReads} empty)`);
    const result = await service.execute({ endpointId: master.id,
      functionCode: 3, unitId: 1, address: 0, quantity: 2 });
    assert.deepEqual(result.values, [12, 34]);
    await service.closeAll();
    await service.open(slave, { operationId: 'reopened-slave' });
    await service.open(master, { operationId: 'reopened-master' });
    const reopened = await service.execute({ endpointId: master.id,
      functionCode: 3, unitId: 1, address: 0, quantity: 2 });
    assert.deepEqual(reopened.values, [12, 34]);
    console.log(JSON.stringify({ idleReads, emptyReads, values: reopened.values }));
  } finally {
    await service.forceShutdown();
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; });
