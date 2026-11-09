/** Test-only sequence observer. Retains one summary per native connection. */
export function createMemoryObserver() {
  const streams = new Map();
  return {
    push(connection, body) {
      if (!body.startsWith('load-')) return;
      let stream = streams.get(connection);
      if (!stream) { stream = { count: 0, lastSequence: 0, prefix: '', error: '' }; streams.set(connection, stream); }
      const separator = body.lastIndexOf('-');
      const prefix = body.slice(0, separator + 1), sequence = Number(body.slice(separator + 1));
      if (!/^\d{8}$/.test(body.slice(separator + 1)) || sequence !== stream.lastSequence + 1 || stream.prefix && stream.prefix !== prefix) {
        stream.error ||= `Out-of-order load message after ${stream.lastSequence}: ${body}`;
      }
      stream.prefix = prefix; stream.lastSequence = sequence; stream.count++;
    },
    snapshot(connection) { return streams.has(connection) ? { ...streams.get(connection) } : { count: 0, lastSequence: 0, prefix: '', error: '' }; },
    count() { return [...streams.values()].reduce((total, stream) => total + stream.count, 0); },
    size() { return streams.size; },
    clear() { streams.clear(); },
  };
}
