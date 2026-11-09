import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

export const PIXEL_THRESHOLD = 0.05;
export const MAX_DIFF_PIXEL_RATIO = 0.0001;

export function comparePngBuffers(expectedBuffer, actualBuffer) {
  const expected = PNG.sync.read(expectedBuffer);
  const actual = PNG.sync.read(actualBuffer);

  if (expected.width !== actual.width || expected.height !== actual.height) {
    return {
      matches: false,
      width: expected.width,
      height: expected.height,
      actualWidth: actual.width,
      actualHeight: actual.height,
      summary: `image dimensions differ: expected ${expected.width}x${expected.height}, received ${actual.width}x${actual.height}`,
    };
  }

  const totalPixels = expected.width * expected.height;
  const diffPixels = pixelmatch(expected.data, actual.data, null, expected.width, expected.height, {
    includeAA: true,
    threshold: PIXEL_THRESHOLD,
  });
  const diffRatio = diffPixels / totalPixels;

  return {
    matches: diffRatio <= MAX_DIFF_PIXEL_RATIO,
    width: expected.width,
    height: expected.height,
    diffPixels,
    diffRatio,
    summary: `${diffPixels}/${totalPixels} pixels differ (${(diffRatio * 100).toFixed(6)}%)`,
  };
}
