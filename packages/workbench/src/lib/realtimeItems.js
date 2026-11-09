const DEFAULT_LIMIT = 300;
const MAX_LIMIT = 50000;
let realtimeItemSequence = 0;

export function normalizeLimit(value, fallback = DEFAULT_LIMIT) {
  const normalizedFallback = normalizePositiveNumber(fallback) ?? DEFAULT_LIMIT;
  return normalizePositiveNumber(value) ?? normalizedFallback;
}

export function appendRealtimeItem(items, item, limit = DEFAULT_LIMIT) {
  return trimRealtimeItems([...items, item], limit);
}

export function trimRealtimeItems(items, limit = DEFAULT_LIMIT) {
  const normalized = normalizeLimit(limit);
  return items.length > normalized ? items.slice(-normalized) : items;
}

export function trimRealtimeItemsByEndpoint(items, limit = DEFAULT_LIMIT) {
  const normalized = normalizeLimit(limit);
  const counts = new Map();
  const kept = [];

  for (let index = items.length - 1; index >= 0; index -= 1) {
    const endpointId = items[index]?.endpointId ?? '';
    const count = counts.get(endpointId) ?? 0;
    if (count >= normalized) continue;
    counts.set(endpointId, count + 1);
    kept.push(items[index]);
  }

  return kept.reverse();
}

export function appendRealtimeItemsByEndpoint(items, newItems, limit = DEFAULT_LIMIT) {
  if (!newItems?.length) return items;
  return trimRealtimeItemsByEndpoint([...items, ...newItems], limit);
}

export function createRealtimeItemId(prefix = 'item', now = Date.now) {
  if (typeof now !== 'function') throw new TypeError('now must be a function');
  realtimeItemSequence += 1;
  return `${prefix}-${now()}-${realtimeItemSequence}`;
}

function normalizePositiveNumber(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric <= 0) return null;
  return Math.min(MAX_LIMIT, Math.max(1, Math.floor(numeric)));
}
