import {
  buildDlt645ErrorResponse,
  buildDlt645ReadRequest,
  buildDlt645ReadResponse,
  parseDlt645Frame,
} from '@ineed-linklab/codecs/dlt645.js';
import { describe, expect, test } from 'vitest';

import {
  appendDlt645Transaction,
  failDlt645Transaction,
} from '../../src/model/dlt645Transactions.js';

describe('DL/T 645 transaction pairing', () => {
  test('combines a request and response into one transaction while preserving directions', () => {
    const request = parsed(buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 4,
    }));
    const response = parsed(buildDlt645ReadResponse({
      address: '123456789012', dataIdentifier: '02010100', value: 230.1,
      decimals: 1, byteLength: 2,
    }));

    const first = appendDlt645Transaction([], frame(request, 'out', 100));
    const second = appendDlt645Transaction(first.transactions, frame(response, 'in', 112));

    expect(second.transactions).toHaveLength(1);
    expect(second.transaction).toMatchObject({
      request: { direction: 'out', createdAt: 100 },
      response: { direction: 'in', createdAt: 112 },
    });
  });

  test('pairs an abnormal response without a data identifier to its request', () => {
    const request = parsed(buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '04000101', wakeUpBytes: 0,
    }));
    const response = parsed(buildDlt645ErrorResponse({
      address: '123456789012', errorCode: 0x02,
    }));

    const first = appendDlt645Transaction([], frame(request, 'in', 100));
    const second = appendDlt645Transaction(first.transactions, frame(response, 'out', 101));

    expect(second.transactions).toHaveLength(1);
    expect(second.transaction.response.parsed.abnormal).toBe(true);
    expect(second.transaction.response.parsed.errorFlags).toEqual(['无请求数据']);
  });

  test('keeps unanswered requests and unmatched responses as visible single-sided transactions', () => {
    const request = parsed(buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0,
    }));
    const response = parsed(buildDlt645ReadResponse({
      address: '000000000002', dataIdentifier: '02010100', value: 220,
      decimals: 1, byteLength: 2,
    }));

    const first = appendDlt645Transaction([], frame(request, 'out', 100));
    const second = appendDlt645Transaction(first.transactions, frame(response, 'in', 110));

    expect(second.transactions).toHaveLength(2);
    expect(second.transactions[0]).toMatchObject({ request: null, response: { direction: 'in' } });
    expect(second.transactions[1]).toMatchObject({ request: { direction: 'out' }, response: null });
  });

  test('marks a matching single-sided request as failed without creating another record', () => {
    const request = parsed(buildDlt645ReadRequest({
      address: '123456789012', dataIdentifier: '02010100', wakeUpBytes: 0,
    }));
    const first = appendDlt645Transaction([], frame(request, 'out', 100));

    const failed = failDlt645Transaction(first.transactions, request, '响应超时');

    expect(failed.transactions).toHaveLength(1);
    expect(failed.transaction).toMatchObject({ error: '响应超时', response: null });
  });
});

function parsed(bytes) {
  return parseDlt645Frame(bytes);
}

function frame(parsedFrame, direction, createdAt) {
  return { parsed: parsedFrame, direction, createdAt };
}
