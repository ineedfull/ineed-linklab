const visibleStringFields = [
  'id', 'endpointId', 'sessionId', 'peerId', 'direction', 'text', 'ascii', 'hex',
  'message', 'payload', 'remoteAddress',
];

export function createDirectionPredicate(direction = 'all') {
  return direction === 'all'
    ? () => true
    : (frame) => frame?.direction === direction;
}

export function createPeerPredicate(peerId = 'all') {
  return peerId === 'all' || peerId === null || peerId === undefined
    ? () => true
    : (frame) => frame?.peerId === peerId;
}

export function createKeywordPredicate(keyword = '', { peers = [] } = {}) {
  const needle = normalizeSearchText(String(keyword).trim());
  if (needle === '') return () => true;
  const compactHexNeedle = compactHex(needle);

  const addresses = new Map(peers.map(({ id, remoteAddress }) => [id, remoteAddress]));
  return (frame) => visibleStringFields.some((field) => {
    const value = frame?.[field];
    if (typeof value !== 'string' && typeof value !== 'number') return false;
    const visible = normalizeSearchText(String(value));
    return visible.includes(needle)
      || (field === 'hex' && compactHexNeedle !== null
        && compactHex(visible)?.includes(compactHexNeedle));
  }) || normalizeSearchText(String(addresses.get(frame?.peerId) ?? '')).includes(needle)
    || matchesBytes(frame?.bytes, needle, compactHexNeedle);
}

export function createFramePredicate(filters = {}, context) {
  const predicates = [
    createDirectionPredicate(filters.direction),
    createPeerPredicate(filters.peerId),
    createKeywordPredicate(filters.keyword, context),
  ];
  return (frame) => predicates.every((predicate) => predicate(frame));
}

export function filterFrames(frames, filters, context) {
  return frames.filter(createFramePredicate(filters, context));
}

function matchesBytes(bytes, needle, compactHexNeedle) {
  if (!(bytes instanceof Uint8Array)) return false;
  // No full-payload text/HEX cache: temporary windows scale with the keyword
  // and a small chunk, independently of the frame size or retained frame count.
  const decoder = new TextDecoder('utf-8', { ignoreBOM: true });
  const searchHex = /^[0-9a-f ]+$/.test(needle);
  const overlap = Math.max(needle.normalize('NFD').length * 2, 4);
  const pendingLimit = Math.max(4096, overlap);
  const textMatcher = createTextMatcher(needle);
  let textTail = '';
  let hexTail = '';
  let compactTail = '';
  for (let offset = 0; offset < bytes.length; offset += 4096) {
    const chunk = bytes.subarray(offset, offset + 4096);
    const final = offset + chunk.length === bytes.length;
    const text = textTail + decoder.decode(chunk, { stream: !final });
    // Defer the last starter and its marks: a following chunk may turn e into
    // é, or finish a Hangul syllable. Pathological nonstarter runs exceeding
    // pendingLimit use finite normalization windows, keeping memory bounded.
    const boundary = final ? text.length : Math.max(
      normalizationBoundary(text), text.length - pendingLimit,
    );
    if (textMatcher.push(text.slice(0, boundary).normalize('NFC'), final)) return true;
    textTail = text.slice(boundary);
    if (!searchHex) continue;
    let hex = '';
    for (const byte of chunk) hex += `${byte.toString(16).padStart(2, '0')} `;
    const spaced = hexTail + hex;
    if (spaced.trimEnd().includes(needle)) return true;
    hexTail = needle.length > 1 ? spaced.slice(-(needle.length - 1)) : '';
    if (compactHexNeedle !== null) {
      const compact = compactTail + hex.replaceAll(' ', '');
      if (compact.includes(compactHexNeedle)) return true;
      compactTail = compact.slice(-Math.max(compactHexNeedle.length - 1, 0));
    }
  }
  return false;
}

function createTextMatcher(needle) {
  // KMP retains only the keyword's prefix table and current match position.
  // Source casing is consumed once, without lowercased overlapping windows.
  const prefixes = new Uint32Array(needle.length);
  for (let index = 1, prefix = 0; index < needle.length; index += 1) {
    while (prefix > 0 && needle[index] !== needle[prefix]) prefix = prefixes[prefix - 1];
    if (needle[index] === needle[prefix]) prefix += 1;
    prefixes[index] = prefix;
  }
  const consume = (state, value) => {
    for (let index = 0; index < value.length && !state.matched; index += 1) {
      const unit = value[index];
      while (state.prefix > 0 && unit !== needle[state.prefix]) {
        state.prefix = prefixes[state.prefix - 1];
      }
      if (unit === needle[state.prefix]) state.prefix += 1;
      if (state.prefix === needle.length) state.matched = true;
    }
  };
  let state = { prefix: 0, matched: false };
  let sigmaBranches = null;
  let precedingCased = false;
  return {
    push(text, final) {
      for (const character of text) {
        const ignorable = /\p{Case_Ignorable}/u.test(character);
        const cased = /\p{Cased}/u.test(character);
        // Default Unicode lowercasing has one contextual rule: final sigma.
        // Keep both possible match states until a non-ignorable character
        // decides it. Even an arbitrarily long punctuation run stays bounded,
        // and a tentative final-sigma match cannot become a false positive.
        if (sigmaBranches && !ignorable) {
          state = cased ? sigmaBranches.nonfinal : sigmaBranches.final;
          sigmaBranches = null;
          if (state.matched) return true;
        }
        if (character === 'Σ' && precedingCased) {
          sigmaBranches = { nonfinal: { ...state }, final: { ...state } };
          consume(sigmaBranches.nonfinal, 'σ');
          consume(sigmaBranches.final, 'ς');
        } else {
          const lower = character.toLowerCase();
          if (sigmaBranches) {
            consume(sigmaBranches.nonfinal, lower);
            consume(sigmaBranches.final, lower);
          } else {
            consume(state, lower);
          }
        }
        if (!ignorable) precedingCased = cased;
        if (sigmaBranches
          ? sigmaBranches.nonfinal.matched && sigmaBranches.final.matched
          : state.matched) return true;
      }
      if (final && sigmaBranches) {
        state = sigmaBranches.final;
        sigmaBranches = null;
      }
      return !sigmaBranches && state.matched;
    },
  };
}

function normalizationBoundary(text) {
  const trailingMarks = /[\p{M}\u1160-\u11ff]*$/u.exec(text);
  let boundary = trailingMarks.index;
  // Retain two preceding code points for Hangul composition and the base
  // character of a combining sequence. Avoid cutting a surrogate pair.
  for (let index = 0; index < 2 && boundary > 0; index += 1) {
    boundary -= 1;
    if (boundary > 0 && /[\udc00-\udfff]/u.test(text[boundary])) boundary -= 1;
  }
  return boundary;
}

function compactHex(value) {
  const compact = value.replaceAll(' ', '');
  return compact.length > 0 && compact.length % 2 === 0 && /^[0-9a-f]+$/.test(compact)
    ? compact
    : null;
}

function normalizeSearchText(value) {
  return value.normalize('NFC').toLowerCase();
}
