import { encodeJson, encodeText, parseHex } from '@ineed-linklab/codecs/payloadCodec.js';

const modes = new Set(['hex', 'json', 'text']);

export function encodeSendPayload({ mode, payload, appendCrlf = false }) {
  if (!modes.has(mode)) return failure('不支持的数据格式');
  if (typeof payload !== 'string' || payload.length === 0) return failure('发送内容为空');

  try {
    if (mode === 'hex') {
      const bytes = parseHex(payload);
      return bytes.length === 0 ? failure('HEX 内容为空') : success(bytes);
    }
    if (mode === 'json') return success(encodeJson(payload));
    return success(encodeText(payload, appendCrlf ? 'crlf' : 'none'));
  } catch (error) {
    return failure(error instanceof Error ? error.message : String(error));
  }
}

function success(bytes) {
  return { ok: true, bytes, error: null };
}

function failure(message) {
  return { ok: false, bytes: null, error: message };
}
