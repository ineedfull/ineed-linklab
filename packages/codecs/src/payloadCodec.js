const textEncoder = new globalThis.TextEncoder();
const textDecoder = new globalThis.TextDecoder();
const DEFAULT_MAX_DISPLAY_BYTES = 64 * 1024;
const DEFAULT_MAX_FORMAT_BYTES = 64 * 1024;

const lineEndings = Object.freeze({
  none: '',
  cr: '\r',
  lf: '\n',
  crlf: '\r\n',
});

export class PayloadValidationError extends Error {
  constructor(message, code, details = {}) {
    super(message);
    this.name = 'PayloadValidationError';
    this.code = code;
    this.details = details;
  }
}

export function encodeText(text, lineEnding = 'none') {
  if (typeof text !== 'string') {
    throw validationError('Text payload must be a string', 'INVALID_TEXT', {
      receivedType: typeof text,
    });
  }
  if (!Object.hasOwn(lineEndings, lineEnding)) {
    throw validationError('Unsupported line ending', 'INVALID_LINE_ENDING', { lineEnding });
  }

  return textEncoder.encode(text + lineEndings[lineEnding]);
}

export function parseHex(text) {
  if (typeof text !== 'string') {
    throw validationError('Hex payload must be a string', 'INVALID_HEX_TEXT', {
      receivedType: typeof text,
    });
  }

  let compact = '';
  for (const character of text) {
    if (/\s/u.test(character)) {
      if (compact.length % 2 !== 0) {
        throw validationError('Hex payload has an odd nibble count', 'ODD_HEX_NIBBLES', {});
      }
      continue;
    }
    if (!/[0-9a-f]/iu.test(character)) {
      throw validationError('Hex payload contains a non-hex character', 'INVALID_HEX', {});
    }
    compact += character;
  }

  if (compact.length % 2 !== 0) {
    throw validationError('Hex payload has an odd nibble count', 'ODD_HEX_NIBBLES', {});
  }

  const bytes = new Uint8Array(compact.length / 2);
  for (let index = 0; index < compact.length; index += 2) {
    bytes[index / 2] = Number.parseInt(compact.slice(index, index + 2), 16);
  }
  return bytes;
}

export function encodeJson(text) {
  if (typeof text !== 'string') {
    throw validationError('JSON payload must be a string', 'INVALID_JSON_TEXT', {
      receivedType: typeof text,
    });
  }

  let value;
  try {
    value = JSON.parse(text);
  } catch {
    throw validationError('JSON payload is malformed', 'INVALID_JSON', {});
  }
  return textEncoder.encode(JSON.stringify(value, null, 2));
}

export function formatFrame(bytes, format = 'text', limits = {}) {
  if (!(bytes instanceof Uint8Array)) {
    throw validationError('Frame bytes must be a Uint8Array', 'INVALID_FRAME_BYTES', {
      receivedType: typeof bytes,
    });
  }
  if (!['text', 'hex', 'json'].includes(format)) {
    throw validationError('Unsupported frame format', 'UNSUPPORTED_FORMAT', { format });
  }

  const { maxDisplayBytes, maxFormatBytes } = normalizeLimits(limits);
  const source = bytes.slice();
  const totalBytes = source.byteLength;

  if (format === 'hex') {
    const displayed = source.slice(0, maxDisplayBytes);
    return {
      text: [...displayed].map((byte) => byte.toString(16).padStart(2, '0').toUpperCase()).join(' '),
      totalBytes,
      truncated: displayed.byteLength < totalBytes,
    };
  }

  if (format === 'text') {
    return renderText(source, source, totalBytes, maxDisplayBytes);
  }

  if (totalBytes > maxFormatBytes) {
    return {
      ...renderText(source, source, totalBytes, maxDisplayBytes),
      json: { valid: null, formatted: false },
    };
  }

  try {
    const formatted = encodeJson(textDecoder.decode(source));
    return {
      ...renderText(formatted, source, totalBytes, maxDisplayBytes),
      json: { valid: true, formatted: true },
    };
  } catch (error) {
    if (!(error instanceof PayloadValidationError) || error.code !== 'INVALID_JSON') throw error;
    return {
      ...renderText(source, source, totalBytes, maxDisplayBytes),
      json: { valid: false, formatted: false },
    };
  }
}

function renderText(renderedBytes, sourceBytes, totalBytes, maxDisplayBytes) {
  const displayed = truncateUtf8(renderedBytes, maxDisplayBytes);
  return {
    text: textDecoder.decode(displayed),
    totalBytes,
    truncated: displayed.byteLength < renderedBytes.byteLength
      || (renderedBytes === sourceBytes && displayed.byteLength < totalBytes),
  };
}

function truncateUtf8(bytes, maxBytes) {
  const displayed = bytes.slice(0, maxBytes);
  if (displayed.byteLength === bytes.byteLength || displayed.byteLength === 0) return displayed;

  let sequenceStart = displayed.byteLength - 1;
  while (sequenceStart > 0 && isUtf8Continuation(displayed[sequenceStart])) {
    sequenceStart -= 1;
  }

  const availableBytes = displayed.byteLength - sequenceStart;
  return availableBytes < utf8SequenceLength(displayed[sequenceStart])
    ? displayed.slice(0, sequenceStart)
    : displayed;
}

function isUtf8Continuation(byte) {
  return (byte & 0xc0) === 0x80;
}

function utf8SequenceLength(firstByte) {
  if ((firstByte & 0x80) === 0) return 1;
  if ((firstByte & 0xe0) === 0xc0) return 2;
  if ((firstByte & 0xf0) === 0xe0) return 3;
  if ((firstByte & 0xf8) === 0xf0) return 4;
  return 1;
}

function normalizeLimits(limits) {
  if (limits === null || typeof limits !== 'object' || Array.isArray(limits)) {
    throw validationError('Frame limits must be an object', 'INVALID_LIMITS', {});
  }

  const maxDisplayBytes = limits.maxDisplayBytes === undefined
    ? DEFAULT_MAX_DISPLAY_BYTES
    : limits.maxDisplayBytes;
  const maxFormatBytes = limits.maxFormatBytes === undefined
    ? DEFAULT_MAX_FORMAT_BYTES
    : limits.maxFormatBytes;
  if (!isPositiveInteger(maxDisplayBytes) || !isPositiveInteger(maxFormatBytes)) {
    throw validationError('Frame limits must be positive integers', 'INVALID_LIMITS', {});
  }
  return { maxDisplayBytes, maxFormatBytes };
}

function isPositiveInteger(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function validationError(message, code, details) {
  return new PayloadValidationError(message, code, details);
}
