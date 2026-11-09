#!/usr/bin/env node

const path = require('node:path');

const repositoryRoot = path.resolve(__dirname, '..', '..');
const ModbusRTU = require(path.join(repositoryRoot, 'node_modules', 'modbus-serial'));
const { ModbusService } = require(path.join(
  repositoryRoot,
  'apps',
  'electron',
  'electron',
  'modbusService.cjs',
));

const [role, transport, target] = process.argv.slice(2);
if (!['master', 'slave'].includes(role) || !['tcp', 'rtu'].includes(transport) || !target) {
  throw new Error('usage: electron-peer.cjs <master|slave> <tcp|rtu> <port|path>');
}

const service = new ModbusService({ ModbusRTU });

void main().catch(async (error) => {
  await service.forceShutdown().catch(() => {});
  console.error(error);
  process.exitCode = 1;
});

async function main() {
  if (role === 'master') {
    await service.open(masterEndpoint(), { operationId: 'electron-master-open' });
    const written = await service.execute({
      endpointId: 'electron-master',
      functionCode: 16,
      unitId: 1,
      address: 2,
      quantity: 2,
      values: [321, 654],
    });
    const read = await service.execute({
      endpointId: 'electron-master',
      functionCode: 3,
      unitId: 1,
      address: 2,
      quantity: 2,
      values: [],
    });
    console.log(`RESULT ${JSON.stringify({ written: written.success, values: read.values })}`);
    await service.shutdown();
    return;
  }

  await service.open(slaveEndpoint(), { operationId: 'electron-slave-open' });
  console.log('READY');
  process.stdin.resume();
  process.stdin.once('data', async () => {
    const map = service.readMap('electron-slave');
    console.log(`RESULT ${JSON.stringify({
      values: map.areas.holdingRegisters.values.slice(2, 4),
    })}`);
    await service.shutdown();
  });
}

function masterEndpoint() {
  return {
    id: 'electron-master',
    transport: transport === 'tcp' ? 'modbus-tcp-master' : 'modbus-rtu-master',
    config: transport === 'tcp'
      ? { host: '127.0.0.1', port: Number(target), unitId: 1, timeoutMs: 2_000 }
      : serialConfig(),
  };
}

function slaveEndpoint() {
  return {
    id: 'electron-slave',
    transport: transport === 'tcp' ? 'modbus-tcp-slave' : 'modbus-rtu-slave',
    config: {
      ...(transport === 'tcp'
        ? { listenHost: '127.0.0.1', listenPort: Number(target), unitId: 1 }
        : serialConfig()),
      dataAreas: { holdingRegisters: { start: 0, count: 10 } },
    },
  };
}

function serialConfig() {
  return {
    path: target,
    baudRate: 9600,
    dataBits: 8,
    parity: 'none',
    stopBits: 1,
    flowControl: 'none',
    unitId: 1,
    timeoutMs: 2_000,
  };
}
