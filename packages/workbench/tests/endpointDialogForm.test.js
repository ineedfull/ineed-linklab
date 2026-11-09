import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEndpointConfig, createEndpointForm } from '../src/model/endpointDialogForm.js';
import { MAX_MODBUS_AREA_COUNT, validateEndpointDraft } from '../src/model/endpointDraft.js';

test('Modbus slave form rejects unsafe counts without expanding the data area', () => {
  for (const count of [MAX_MODBUS_AREA_COUNT + 1, 1e9, Infinity, NaN, -1, 1.5]) {
    const form = createEndpointForm();
    form.transport = 'modbus-tcp-slave';
    form.modbusCoilsCount = count;
    const config = buildEndpointConfig(form);
    assert.equal(config.dataAreas.coils.count, count);
    assert.equal(config.dataAreas.coils.values.length, 0);
    assert.ok(validateEndpointDraft({ transport: form.transport, config }).coilsCount);
  }
});

test('resizing a slave data area preserves its prefix without changing the saved endpoint', () => {
  const endpoint = {
    id: 'slave', name: 'Slave', transport: 'modbus-tcp-slave',
    config: { dataAreas: { holdingRegisters: { start: 10, count: 3, values: [12, 34, 56] } } },
  };
  const form = createEndpointForm(endpoint);
  form.modbusHoldingRegistersCount = 2;
  assert.deepEqual(buildEndpointConfig(form, endpoint).dataAreas.holdingRegisters,
    { start: 10, count: 2, values: [12, 34] });
  form.modbusHoldingRegistersCount = 4;
  assert.deepEqual(buildEndpointConfig(form, endpoint).dataAreas.holdingRegisters,
    { start: 10, count: 4, values: [12, 34, 56, 0] });
  assert.deepEqual(endpoint.config.dataAreas.holdingRegisters.values, [12, 34, 56]);
});
