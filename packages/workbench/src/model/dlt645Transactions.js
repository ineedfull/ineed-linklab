export function appendDlt645Transaction(transactions, frame, limit = 100) {
  if (!frame?.parsed) return { transactions, transaction: null };
  const entry = {
    id: `${frame.createdAt}-${frame.direction}-${transactions.length}`,
    direction: frame.direction,
    createdAt: frame.createdAt,
    parsed: frame.parsed,
  };
  if (!frame.parsed.response) {
    const transaction = {
      id: `dlt645-${entry.id}`,
      createdAt: entry.createdAt,
      request: entry,
      response: null,
    };
    return {
      transactions: [transaction, ...transactions].slice(0, limit),
      transaction,
    };
  }

  const index = transactions.findIndex((transaction) => (
    transaction.request
    && !transaction.response
    && matchingPair(transaction.request.parsed, frame.parsed)
  ));
  if (index >= 0) {
    const transaction = { ...transactions[index], response: entry, error: '' };
    const next = [...transactions];
    next[index] = transaction;
    return { transactions: next, transaction };
  }

  const transaction = {
    id: `dlt645-${entry.id}`,
    createdAt: entry.createdAt,
    request: null,
    response: entry,
  };
  return {
    transactions: [transaction, ...transactions].slice(0, limit),
    transaction,
  };
}

export function failDlt645Transaction(transactions, request, error) {
  const index = transactions.findIndex((transaction) => (
    transaction.request
    && !transaction.response
    && transaction.request.parsed.address === request.address
    && transaction.request.parsed.functionCode === request.functionCode
    && transaction.request.parsed.dataIdentifier === request.dataIdentifier
  ));
  if (index < 0) return { transactions, transaction: null };
  const transaction = { ...transactions[index], error: String(error || '通信失败') };
  const next = [...transactions];
  next[index] = transaction;
  return { transactions: next, transaction };
}

function matchingPair(request, response) {
  if (request.address !== response.address || request.functionCode !== response.functionCode) return false;
  return response.abnormal
    || request.dataIdentifier === null
    || response.dataIdentifier === null
    || request.dataIdentifier === response.dataIdentifier;
}
