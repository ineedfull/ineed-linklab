import assert from 'node:assert/strict';
import test from 'node:test';

import {
  createModbusPointTrendsController,
  groupModbusPointSeriesByUnit,
} from '../src/model/modbusPointTrends.js';

test('trend selection uses composite identities and enforces the six-point limit', () => {
  const controller = createModbusPointTrendsController(runtimeStub(), endpoint(), config(7), {
    clock: () => 1_800_000_000_000,
  });

  assert.equal(controller.points.length, 7);
  assert.deepEqual(controller.points[0].identity, {
    requestGroupId: 'group-1', requestId: 'request-1', pointId: 'point-1',
  });
  for (const point of controller.points.slice(0, 6)) controller.selectPoint(point.identity, true);
  assert.equal(controller.state.selected.length, 6);
  assert.equal(controller.selectPoint(controller.points[6].identity, true), false);
  assert.match(controller.state.selectionError, /最多.*6/);
  controller.selectPoint(controller.points[0].identity, false);
  assert.equal(controller.selectPoint(controller.points[6].identity, true), true);
  assert.equal(controller.state.selected.length, 6);
  controller.dispose();
});

test('series are grouped by exact unit without mixing unitless points', () => {
  const groups = groupModbusPointSeriesByUnit([
    series('temperature', 'C'), series('pressure', 'kPa'),
    series('ambient', 'C'), series('state', ''), series('label', null),
  ]);

  assert.deepEqual(groups.map(({ unit, series: values }) => [
    unit, values.map(({ pointId }) => pointId),
  ]), [
    ['C', ['temperature', 'ambient']],
    ['kPa', ['pressure']],
    ['', ['state', 'label']],
  ]);
});

test('preset and custom ranges issue bounded series queries derived from chart width', async () => {
  const queries = [];
  const runtime = runtimeStub();
  runtime.modbusHistory.querySeries = async (query) => {
    queries.push(query);
    return { series: [], from: query.from, to: query.to };
  };
  const now = 1_800_000_000_000;
  const controller = createModbusPointTrendsController(runtime, endpoint(), config(2), {
    clock: () => now,
  });
  controller.selectPoint(controller.points[0].identity, true);
  controller.setChartWidth(10);

  await controller.setPreset('1-hour');
  assert.deepEqual(queries[0], {
    endpointId: 'master-1',
    points: [controller.points[0].identity],
    from: now - 3_600_000,
    to: now,
    bucketCount: 50,
  });

  controller.setChartWidth(10_000);
  await controller.setCustomRange(now - 5_000, now - 1_000);
  assert.deepEqual(queries[1], {
    endpointId: 'master-1',
    points: [controller.points[0].identity],
    from: now - 5_000,
    to: now - 1_000,
    bucketCount: 2_000,
  });
  controller.dispose();
});

test('stale series results cannot overwrite a newer query or clear the selection', async () => {
  const first = deferred();
  const second = deferred();
  let calls = 0;
  const runtime = runtimeStub();
  runtime.modbusHistory.querySeries = () => (++calls === 1 ? first.promise : second.promise);
  const controller = createModbusPointTrendsController(runtime, endpoint(), config(1));
  controller.selectPoint(controller.points[0].identity, true);

  const oldQuery = controller.refresh();
  const newQuery = controller.refresh();
  second.resolve({ series: [series('new', 'C')], from: 1, to: 2 });
  await newQuery;
  first.resolve({ series: [series('old', 'C')], from: 1, to: 2 });
  await oldQuery;

  assert.deepEqual(controller.state.series.map(({ pointId }) => pointId), ['new']);
  assert.equal(controller.state.selected.length, 1);

  runtime.modbusHistory.querySeries = async () => { throw new Error('query failed'); };
  await assert.rejects(controller.refresh(), /query failed/);
  assert.equal(controller.state.selected.length, 1);
  assert.equal(controller.state.seriesError, 'query failed');
  controller.dispose();
});

test('detail paging, CSV export, and scoped clear forward the active selection and range', async () => {
  const calls = [];
  const runtime = runtimeStub();
  runtime.modbusHistory.queryRows = async (query) => {
    calls.push(['rows', query]);
    return { rows: [{ id: 1 }], total: 1, page: query.page, pageSize: query.pageSize };
  };
  runtime.modbusHistory.exportCsv = async (query) => {
    calls.push(['export', query]);
    return { canceled: false, path: '/tmp/history.csv' };
  };
  runtime.modbusHistory.clear = async (query) => {
    calls.push(['clear', query]);
    return 4;
  };
  runtime.modbusHistory.querySeries = async (query) => {
    calls.push(['series', query]);
    return { series: [], from: query.from, to: query.to };
  };
  const controller = createModbusPointTrendsController(runtime, endpoint(), config(1), {
    clock: () => 10_000,
  });
  controller.selectPoint(controller.points[0].identity, true);
  await controller.setCustomRange(1_000, 9_000);
  calls.length = 0;

  await controller.loadRows(2, 25);
  await controller.exportCsv();
  const deleted = await controller.clear();

  const scope = {
    endpointId: 'master-1',
    points: [controller.points[0].identity],
    from: 1_000,
    to: 9_000,
  };
  assert.deepEqual(calls[0], ['rows', { ...scope, page: 2, pageSize: 25 }]);
  assert.deepEqual(calls[1], ['export', { ...scope, page: 1, pageSize: 50 }]);
  assert.deepEqual(calls[2], ['clear', { ...scope, page: 1, pageSize: 50 }]);
  assert.equal(deleted, 4);
  assert.equal(controller.state.rowsTotal, 1);
  controller.dispose();
});

test('clear rejects an empty point selection instead of widening to the endpoint', async () => {
  const runtime = runtimeStub();
  let clearCalls = 0;
  runtime.modbusHistory.clear = async () => { clearCalls += 1; };
  const controller = createModbusPointTrendsController(runtime, endpoint(), config(1));

  await assert.rejects(controller.clear(), /请选择.*数据点/);
  assert.equal(clearCalls, 0);
  controller.dispose();
});

function config(pointCount) {
  return {
    requestGroups: [{
      id: 'group-1', name: 'Environment', order: 0,
      requests: [{
        id: 'request-1', name: 'Holding', order: 0,
        dataPoints: Array.from({ length: pointCount }, (_, index) => ({
          id: `point-${index + 1}`,
          key: `point_${index + 1}`,
          name: `Point ${index + 1}`,
          unit: index % 2 === 0 ? 'C' : 'kPa',
          dataType: 'float32',
          saveHistory: false,
        })),
      }],
    }],
  };
}

function endpoint() {
  return { id: 'master-1', name: 'Boiler master' };
}

function series(pointId, unit) {
  return {
    requestGroupId: 'group-1', requestId: 'request-1', pointId,
    pointKey: pointId, pointName: pointId, dataType: 'float32', unit,
    kind: 'numeric', samples: [], summary: {},
  };
}

function runtimeStub() {
  return {
    modbusHistory: {
      querySeries: async (query) => ({ series: [], from: query.from, to: query.to }),
      queryRows: async (query) => ({ rows: [], total: 0, page: query.page, pageSize: query.pageSize }),
      exportCsv: async () => ({ canceled: true }),
      clear: async () => 0,
    },
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((onResolve, onReject) => { resolve = onResolve; reject = onReject; });
  return { promise, resolve, reject };
}
