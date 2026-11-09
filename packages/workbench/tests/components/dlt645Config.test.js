import { describe, expect, it } from 'vitest';

import {
  applyDlt645CatalogItem,
  createDlt645Meter,
  normalizeDlt645Config,
  validateDlt645Config,
} from '../../src/model/dlt645Config.js';

describe('DL/T 645 configuration', () => {
  it('uses the standard 2400 8E1 defaults without discarding meters', () => {
    const meter = createDlt645Meter(3);
    const config = normalizeDlt645Config({ meters: [meter] });
    expect(config).toMatchObject({ baudRate: 2400, dataBits: 8, parity: 'even', stopBits: 1 });
    expect(config.meters[0]).toMatchObject({ name: '电表 3', address: '000000000003' });
  });

  it('applies standard data item metadata', () => {
    expect(applyDlt645CatalogItem({ id: 'task-1' }, '02010100')).toMatchObject({
      id: 'task-1', name: 'A 相电压', unit: 'V', decimals: 1, byteLength: 2,
    });
  });

  it.each(['baudRate', 'dataBits', 'stopBits', 'timeoutMs', 'minRequestGapMs', 'wakeUpBytes',
    'decimals', 'byteLength', 'pollIntervalMs'])('rejects explicit invalid numeric drafts for %s', (field) => {
    for (const invalid of ['', '  ', 1.5, NaN, null, false, [], 'invalid']) {
      const config = normalizeDlt645Config({ path: '/dev/ttyUSB0', meters: [createDlt645Meter()] });
      const taskField = ['decimals', 'byteLength', 'pollIntervalMs'].includes(field);
      const target = taskField ? config.meters[0].tasks[0] : config;
      target[field] = invalid;
      const key = taskField ? `meters.0.tasks.0.${field}` : field;
      expect(validateDlt645Config(config)[key], `${field}=${String(invalid)}`).toBeTruthy();
    }
  });

  it('keeps omitted defaults and accepts valid numeric strings from forms', () => {
    const config = { path: '/dev/ttyUSB0', meters: [{
      name: '电表', address: '000000000001',
      tasks: [{ identifier: '02010100', decimals: '1', byteLength: '2', pollIntervalMs: '5000' }],
    }] };
    expect(validateDlt645Config(config)).toEqual({});
    expect(validateDlt645Config({ path: '/dev/ttyUSB0' })).toEqual({});
  });

  it('validates addresses, identifiers, duplicates, and polling bounds', () => {
    const config = normalizeDlt645Config({
      path: '/dev/ttyUSB0',
      meters: [{
        id: 'm1', name: '电表', address: '123',
        tasks: [{ id: 't1', name: '', identifier: 'XYZ', pollIntervalMs: 100 }],
      }],
    });
    const errors = validateDlt645Config(config);
    expect(errors['meters.0.address']).toBeTruthy();
    expect(errors['meters.0.tasks.0.identifier']).toBeTruthy();
    expect(errors['meters.0.tasks.0.pollIntervalMs']).toBeTruthy();
  });
});
