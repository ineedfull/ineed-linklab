import { formatFrame } from '@ineed-linklab/codecs/payloadCodec.js';

export const DEFAULT_FRAME_PREVIEW_BYTES = 4096;
export const DEFAULT_FRAME_ROW_LIMIT = 500;

const formats = new Set(['hex', 'json', 'text']);
const fatalTextDecoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

export function createFramePresenter({
  previewByteLimit = DEFAULT_FRAME_PREVIEW_BYTES,
  rowLimit = DEFAULT_FRAME_ROW_LIMIT,
} = {}) {
  const automaticKeys = new WeakMap();
  const previews = new WeakMap();
  let nextKey = 0;

  function frameKey(frame) {
    let key = automaticKeys.get(frame);
    if (key === undefined) {
      nextKey += 1;
      const label = typeof frame.id === 'string' && frame.id.trim() !== ''
        ? frame.id
        : 'frame-auto';
      key = `${label}-${nextKey}`;
      automaticKeys.set(frame, key);
    }
    return key;
  }

  function present(frames, options = {}) {
    return frames.slice(-rowLimit).map((frame) => {
      const format = formats.has(frame.format) ? frame.format : 'text';
      const limit = options.previewByteLimit ?? previewByteLimit;
      // Workbench snapshots own their bytes and freeze frame records. Reuse the
      // other 499 previews when a new frame arrives; mutable callers stay fresh.
      const cached = previews.get(frame);
      if (Object.isFrozen(frame) && cached?.limit === limit) return cached.row;
      const preview = formatFrame(frame.bytes, format, {
        maxDisplayBytes: limit,
        maxFormatBytes: limit,
      });
      const row = {
        format,
        frame,
        key: frameKey(frame),
        text: preview.text,
        totalBytes: preview.totalBytes,
        truncated: preview.truncated,
      };
      if (Object.isFrozen(frame)) previews.set(frame, { limit, row });
      return row;
    });
  }

  return { present };
}

export function formatFrameForCopy(frame) {
  const bytes = frame?.bytes;
  const format = formats.has(frame?.format) ? frame.format : 'text';
  try {
    if (format !== 'hex') fatalTextDecoder.decode(bytes);
    const formatted = formatFrame(bytes, format, {
      maxDisplayBytes: Number.MAX_SAFE_INTEGER,
      maxFormatBytes: Number.MAX_SAFE_INTEGER,
    });
    if (format === 'json' && formatted.json?.valid !== true) return fullHex(bytes);
    if (formatted.truncated) return fullHex(bytes);
    return formatted.text;
  } catch {
    if (bytes instanceof Uint8Array) return fullHex(bytes);
    throw new TypeError('Frame copy requires Uint8Array bytes');
  }
}

function fullHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' ');
}

export function originalFrameContent(frame) {
  try { return { text: fatalTextDecoder.decode(frame.bytes), label: '复制原始文本' }; }
  catch { return { text: fullHex(frame.bytes), label: '复制 HEX 字节' }; }
}
