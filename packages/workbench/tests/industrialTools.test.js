import test from 'node:test';
import assert from 'node:assert/strict';
import { createToolDraft, createToolExample, INDUSTRIAL_TOOLS, runTool } from '../src/model/industrialTools.js';

test('checksum calculation only claims verification when a supplied wire checksum matches', () => {
  const draft = createToolDraft('crc');
  const computed = runTool('crc', '01 03 00 00 00 0A', draft.options);
  assert.equal(computed.verification, null);
  assert.equal(computed.rows.find(row => row.label === '发送字节').value, 'C5 CD');
  const valid = runTool('crc', '01 03 00 00 00 0A', { ...draft.options, expected: 'C5 CD' });
  assert.equal(valid.verification, true);
  const wrong = runTool('crc', '01 03 00 00 00 0A', { ...draft.options, expected: 'CD C5' });
  assert.equal(wrong.verification, false);
  assert.throws(() => runTool('crc', '01', { ...draft.options, expected: '00' }));
});
test('changing CRC preset keeps the chosen wire order explicit and exposes parameters', () => {
  const draft = createToolDraft('crc');
  const result = runTool('crc','31 32 33 34 35 36 37 38 39',{ ...draft.options,algorithm:'crc32-isohdlc',wireOrder:'big' });
  assert.equal(result.rows.find(row => row.label === '发送字节').value,'CB F4 39 26');
  assert.match(result.note,/04C11DB7/);
  assert.match(result.note,/refin=true/);
});
test('ASCII and BCD examples run without a runtime or connection', () => {
  assert.equal(runTool('ascii','A\r\n',createToolDraft('ascii').options).rows[0].value,'41 0D 0A');
  assert.equal(runTool('bcd','001234',createToolDraft('bcd').options).rows[0].value,'00 12 34');
});
test('integer and float forms expose their encoded wire bytes and actual interpretation', () => {
  assert.equal(runTool('integer','18446744073709551615',{ ...createToolDraft('integer').options,width:'64' }).rows[0].value,'FF FF FF FF FF FF FF FF');
  assert.equal(runTool('float','1',createToolDraft('float').options).rows[0].value,'3F 80 00 00');
});
test('form options and tool ids reject invalid selections instead of silently falling back', () => {
  assert.throws(() => runTool('integer','1',{ ...createToolDraft('integer').options,signed:'garbage' }));
  assert.throws(() => runTool('ascii','A',{ direction:'bogus' }));
  assert.throws(() => runTool('radix','1',{ ...createToolDraft('radix').options,width:'' }));
  assert.throws(() => runTool('unknown','',{}));
});

test('examples respect decoding direction, precision and byte order', () => {
  const ascii = createToolExample('ascii', { direction: 'decode' });
  assert.equal(ascii.input, '48 65 6C 6C 6F 0D 0A');
  const bcd = createToolExample('bcd', { direction: 'decode', decimals: '2', order: 'little' });
  assert.equal(bcd.input, '34 12 00');
  assert.equal(runTool('bcd', bcd.input, bcd.options).rows[0].value, '0012.34');
  const float = createToolExample('float', { direction: 'decode', width: '64', order: 'reverse' });
  assert.equal(runTool('float', float.input, float.options).rows[0].value, '0.1');
  const integer = createToolExample('integer', { direction: 'decode', width: '8', signed: 'signed', order: 'normal' });
  assert.equal(runTool('integer', integer.input, integer.options).rows[1].value, '-123');
});

test('examples preserve algorithm and send order and refresh an existing verification operand', () => {
  for (const algorithm of ['crc16-modbus', 'crc32-isohdlc']) {
    const options = { ...createToolDraft('crc').options, algorithm, wireOrder: 'big', expected: '00' };
    const example = createToolExample('crc', options);
    assert.equal(example.options.algorithm, algorithm);
    assert.equal(example.options.wireOrder, 'big');
    assert.equal(options.expected, '00'); // The caller's draft is not mutated.
    assert.equal(runTool('crc', example.input, example.options).verification, true);
  }
  assert.equal(createToolExample('crc', createToolDraft('crc').options).options.expected, '');
});

test('all supported example scenarios calculate and preserve configuration selections', () => {
  for (const tool of INDUSTRIAL_TOOLS) {
    let scenarios = [{}];
    for (const field of tool.fields) {
      const values = field.options?.map(item => item.value)
        ?? (field.key === 'decimals' ? Array.from({ length: 13 }, (_, index) => String(index)) : [field.initial]);
      scenarios = scenarios.flatMap(options => values.map(value => ({ ...options, [field.key]: value })));
    }
    for (const options of scenarios) {
      // A single byte cannot form a complete 16-bit word in either direction.
      if (options.width === '8' && ['swap-bytes', 'reverse-words'].includes(options.order)) continue;
      const example = createToolExample(tool.id, options);
      for (const field of tool.fields.filter(item => !['mask', 'expected'].includes(item.key))) {
        assert.equal(example.options[field.key], options[field.key], `${tool.id}: ${field.key}`);
      }
      const output = runTool(tool.id, example.input, example.options);
      assert.ok(output.rows.length > 0, `${tool.id}: ${JSON.stringify(options)}`);
    }
  }
});
