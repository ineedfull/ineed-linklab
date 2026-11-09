import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { PNG } from 'pngjs';

import { comparePngBuffers } from '../e2e/support/visualParity.js';

const WIDTH = 200;
const HEIGHT = 200;

function pngWithPixels(changes = []) {
  const png = new PNG({ width: WIDTH, height: HEIGHT });
  png.data.fill(255);
  for (const { x, y, value } of changes) {
    const offset = (y * WIDTH + x) * 4;
    png.data[offset] = value;
    png.data[offset + 1] = value;
    png.data[offset + 2] = value;
    png.data[offset + 3] = 255;
  }
  return PNG.sync.write(png);
}

describe('decoded PNG visual parity', () => {
  test('accepts a few anti-aliasing pixel differences and reports their ratio', () => {
    const actual = pngWithPixels([
      { x: 10, y: 10, value: 210 },
      { x: 11, y: 10, value: 210 },
      { x: 10, y: 11, value: 210 },
      { x: 11, y: 11, value: 210 },
    ]);

    const result = comparePngBuffers(pngWithPixels(), actual);

    assert.deepEqual(result, {
      matches: true,
      width: WIDTH,
      height: HEIGHT,
      diffPixels: 4,
      diffRatio: 0.0001,
      summary: '4/40000 pixels differ (0.010000%)',
    });
  });

  test('rejects a large changed block as a visual or layout difference', () => {
    const changedBlock = [];
    for (let y = 40; y < 60; y += 1) {
      for (let x = 40; x < 60; x += 1) changedBlock.push({ x, y, value: 0 });
    }

    const result = comparePngBuffers(pngWithPixels(), pngWithPixels(changedBlock));

    assert.equal(result.matches, false);
    assert.equal(result.diffPixels, 400);
    assert.equal(result.diffRatio, 0.01);
    assert.equal(result.summary, '400/40000 pixels differ (1.000000%)');
  });

  test('rejects images with different decoded dimensions', () => {
    const differentSize = PNG.sync.write(new PNG({ width: 10, height: 20 }));

    const result = comparePngBuffers(pngWithPixels(), differentSize);

    assert.deepEqual(result, {
      matches: false,
      width: WIDTH,
      height: HEIGHT,
      actualWidth: 10,
      actualHeight: 20,
      summary: 'image dimensions differ: expected 200x200, received 10x20',
    });
  });
});
