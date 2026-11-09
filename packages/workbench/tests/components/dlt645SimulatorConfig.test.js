import { describe, expect, it } from 'vitest';

import {
  createDlt645SimulatorMeter,
  normalizeDlt645SimulatorConfig,
  validateDlt645SimulatorConfig,
} from '../../src/model/dlt645SimulatorConfig.js';

describe('DL/T 645 simulator configuration', () => {
  it('creates a practical electric meter template', () => {
    const meter = createDlt645SimulatorMeter(1);

    expect(meter.address).toBe('000000000001');
    expect(meter.tasks.map(({ identifier }) => identifier)).toEqual([
      '00000000', '02010100', '02020100', '02030000', '02060000',
    ]);
    expect(meter.tasks.find(({ identifier }) => identifier === '02010100')?.value).toBe(230.1);
  });

  it('normalizes serial defaults and validates duplicate addresses and overflowing values', () => {
    const meter = createDlt645SimulatorMeter(1);
    const config = normalizeDlt645SimulatorConfig({ path: '/dev/tty.sim', meters: [meter, meter] });
    config.meters[0].tasks[0].value = 123456789;
    const errors = validateDlt645SimulatorConfig(config);

    expect(config).toMatchObject({ baudRate: 2400, dataBits: 8, parity: 'even', stopBits: 1 });
    expect(errors['meters.1.address']).toMatch(/重复/);
    expect(errors['meters.0.tasks.0.value']).toMatch(/超出/);
  });
});


it('rejects signed power values that occupy the sign bit', () => {
  const meter = createDlt645SimulatorMeter(1);
  const config = { path: '/dev/tty.sim', meters: [meter] };
  const power = meter.tasks.find(({ identifier }) => identifier === '02030000');
  for (const value of [80, -80, 89.1234, -89.1234]) {
    power.value = value;
    expect(validateDlt645SimulatorConfig(config)['meters.0.tasks.3.value']).toBeTruthy();
  }
  for (const value of [79.9999, -79.9999]) {
    power.value = value;
    expect(validateDlt645SimulatorConfig(config)).toEqual({});
  }
});

it('rejects explicit raw simulator value and integer drafts while keeping omitted defaults', () => {
  for (const [field, value] of [
    ['value', ''], ['value', ' '], ['value', NaN], ['value', Infinity], ['value', null], ['value', true],
    ['decimals', 1.5], ['decimals', ''], ['byteLength', 2.5], ['byteLength', null],
  ]) {
    const meter = createDlt645SimulatorMeter(1);
    meter.tasks[0][field] = value;
    expect(validateDlt645SimulatorConfig({ path: '/dev/tty.sim', meters: [meter] })[`meters.0.tasks.0.${field}`])
      .toBeTruthy();
  }
  for (const field of ['baudRate', 'dataBits', 'stopBits', 'responseDelayMs', 'wakeUpBytes']) {
    expect(validateDlt645SimulatorConfig({ path: '/dev/tty.sim', [field]: '' })[field]).toBeTruthy();
  }
  expect(validateDlt645SimulatorConfig({ path: '/dev/tty.sim', meters: [{
    name: '旧模拟表', address: '123456789012', tasks: [{ identifier: '02010100' }],
  }] })).toEqual({});
});
