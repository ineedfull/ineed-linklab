import assert from 'node:assert/strict';
import test from 'node:test';

const presentationModule = await import('../src/model/framePresentation.js').catch(() => null);

test('frame previews bound large payloads and report truncation', () => {
  assert.ok(presentationModule, 'frame presentation module must exist');
  const presenter = presentationModule.createFramePresenter({ previewByteLimit: 32 });
  const bytes = new Uint8Array(10_000).fill(0x41);
  const [row] = presenter.present([{ direction: 'in', format: 'text', bytes }]);

  assert.ok(row.text.length <= 32);
  assert.equal(row.truncated, true);
  assert.equal(row.totalBytes, 10_000);
  assert.equal(row.format, 'text');
});

test('unbounded preformatted frame text is never rendered directly', () => {
  assert.ok(presentationModule, 'frame presentation module must exist');
  const presenter = presentationModule.createFramePresenter({ previewByteLimit: 32 });
  const [row] = presenter.present([{
    direction: 'in', format: 'text', bytes: Uint8Array.of(0x41), text: 'x'.repeat(100_000),
  }]);

  assert.equal(row.text, 'A');
});

test('frame presentation caps mounted rows at the latest 500', () => {
  assert.ok(presentationModule, 'frame presentation module must exist');
  const presenter = presentationModule.createFramePresenter();
  const frames = Array.from({ length: 700 }, (_, index) => ({
    id: `frame-${index}`, direction: 'in', bytes: Uint8Array.of(index % 255),
  }));

  const rows = presenter.present(frames);

  assert.equal(rows.length, 500);
  assert.equal(rows[0].frame.id, 'frame-200');
  assert.equal(rows.at(-1).frame.id, 'frame-699');
});

test('frames without IDs receive stable identity keys without index fallback', () => {
  assert.ok(presentationModule, 'frame presentation module must exist');
  const presenter = presentationModule.createFramePresenter();
  const frame = Object.freeze({ direction: 'out', bytes: Uint8Array.of(1, 2) });

  const first = presenter.present([frame])[0].key;
  const second = presenter.present([frame])[0].key;

  assert.equal(first, second);
  assert.match(first, /^frame-auto-/);
});

test('duplicate caller IDs still receive unique stable object keys', () => {
  assert.ok(presentationModule, 'frame presentation module must exist');
  const presenter = presentationModule.createFramePresenter();
  const firstFrame = Object.freeze({ id: 'duplicate', direction: 'in', bytes: Uint8Array.of(1) });
  const secondFrame = Object.freeze({ id: 'duplicate', direction: 'out', bytes: Uint8Array.of(2) });

  const firstKeys = presenter.present([firstFrame, secondFrame]).map(({ key }) => key);
  const retainedKeys = presenter.present([secondFrame]).map(({ key }) => key);

  assert.notEqual(firstKeys[0], firstKeys[1]);
  assert.equal(retainedKeys[0], firstKeys[1]);
});

test('full copy formatting preserves payloads larger than the preview limit', () => {
  assert.equal(typeof presentationModule.formatFrameForCopy, 'function');
  const textBytes = new TextEncoder().encode('A'.repeat(6_000));
  const hexBytes = new Uint8Array(5_000).fill(0xab);
  const presenter = presentationModule.createFramePresenter();

  assert.equal(presenter.present([{ format: 'text', bytes: textBytes }])[0].truncated, true);
  assert.equal(presentationModule.formatFrameForCopy({ format: 'text', bytes: textBytes }), 'A'.repeat(6_000));
  const copiedHex = presentationModule.formatFrameForCopy({ format: 'hex', bytes: hexBytes });
  assert.equal(copiedHex.split(' ').length, 5_000);
  assert.equal(copiedHex.startsWith('AB AB AB'), true);
});

test('original copy preserves JSON spacing and falls back to named HEX for non-UTF8 bytes', () => {
  assert.deepEqual(presentationModule.originalFrameContent({ bytes: new TextEncoder().encode('{ "v":1 }') }), { text: '{ "v":1 }', label: '复制原始文本' });
  assert.deepEqual(presentationModule.originalFrameContent({ bytes: Uint8Array.of(255, 0) }), { text: 'FF 00', label: '复制 HEX 字节' });
});

test('original copy preserves UTF-8 BOM bytes as part of the wire payload', () => {
  const text = '\uFEFF { "温度": 23 }\r\n';
  const bytes = new TextEncoder().encode(text);
  const result = presentationModule.originalFrameContent({ bytes });
  assert.equal(result.text, text);
  assert.deepEqual(new TextEncoder().encode(result.text), bytes);
});


test('streaming previews reuse unchanged immutable rows and refresh when the preview limit changes', () => {
  const presenter = presentationModule.createFramePresenter();
  const frames = Array.from({ length: 501 }, (_, id) => Object.freeze({ id: String(id), format: 'text', bytes: new TextEncoder().encode('ABCD') }));
  const first = presenter.present(frames.slice(0, 500));
  const next = presenter.present(frames.slice(1));
  assert.equal(next.length, 500);
  for (let index = 0; index < 499; index++) assert.equal(next[index], first[index + 1]);
  const [short] = presenter.present([frames[1]], { previewByteLimit: 2 });
  assert.equal(short.text, 'AB'); assert.equal(short.truncated, true);
  const [full] = presenter.present([frames[1]], { previewByteLimit: 4 });
  assert.equal(full.text, 'ABCD'); assert.equal(full.truncated, false);
});

test('mutable caller frames remain fresh when bytes or format change', () => {
  const presenter = presentationModule.createFramePresenter();
  const frame = { format: 'text', bytes: Uint8Array.of(65) };
  assert.equal(presenter.present([frame])[0].text, 'A');
  frame.bytes[0] = 66;
  assert.equal(presenter.present([frame])[0].text, 'B');
  frame.format = 'hex';
  assert.equal(presenter.present([frame])[0].text, '42');
});
