const MAX_SELECTED_POINTS = 6;
const DEFAULT_PAGE_SIZE = 50;
const RANGE_DURATIONS = Object.freeze({
  '1-hour': 3_600_000,
  '24-hours': 86_400_000,
  '7-days': 7 * 86_400_000,
  '30-days': 30 * 86_400_000,
});

export function createModbusPointTrendsController(runtime, endpoint, config, {
  clock = Date.now,
} = {}) {
  if (typeof runtime?.modbusHistory?.querySeries !== 'function') {
    throw new TypeError('runtime.modbusHistory is required');
  }
  if (typeof endpoint?.id !== 'string' || !endpoint.id.trim()) {
    throw new TypeError('endpoint is required');
  }
  if (typeof clock !== 'function') throw new TypeError('clock must be a function');

  const points = Object.freeze(buildPointCatalog(config));
  const now = clock();
  const state = {
    selected: points.filter(({ saveHistory }) => saveHistory).slice(0, MAX_SELECTED_POINTS)
      .map(({ identity }) => structuredClone(identity)),
    selectionError: '',
    preset: '24-hours',
    from: Math.max(0, now - RANGE_DURATIONS['24-hours']),
    to: now,
    chartWidth: 800,
    series: [],
    seriesLoading: false,
    seriesError: '',
    rows: [],
    rowsTotal: 0,
    page: 1,
    pageSize: DEFAULT_PAGE_SIZE,
    rowsLoading: false,
    rowsError: '',
  };
  const listeners = new Set();
  let seriesGeneration = 0;
  let rowsGeneration = 0;
  let disposed = false;

  function selectPoint(identity, selected) {
    const normalized = requireCatalogIdentity(points, identity);
    const index = state.selected.findIndex((candidate) => sameIdentity(candidate, normalized));
    if (!selected) {
      if (index !== -1) state.selected.splice(index, 1);
      state.selectionError = '';
      publish();
      return true;
    }
    if (index !== -1) return true;
    if (state.selected.length >= MAX_SELECTED_POINTS) {
      state.selectionError = '最多同时选择 6 个数据点。';
      publish();
      return false;
    }
    state.selected.push(structuredClone(normalized));
    state.selectionError = '';
    publish();
    return true;
  }

  function setChartWidth(width) {
    if (Number.isFinite(width) && width > 0) state.chartWidth = width;
  }

  async function setPreset(preset) {
    if (!Object.hasOwn(RANGE_DURATIONS, preset)) throw new TypeError('unknown trend range preset');
    const current = clock();
    state.preset = preset;
    state.from = Math.max(0, current - RANGE_DURATIONS[preset]);
    state.to = current;
    state.page = 1;
    publish();
    return Promise.all([refresh(), loadRows(1, state.pageSize)]);
  }

  async function setCustomRange(from, to) {
    requireRange(from, to);
    state.preset = 'custom';
    state.from = from;
    state.to = to;
    state.page = 1;
    publish();
    return Promise.all([refresh(), loadRows(1, state.pageSize)]);
  }

  async function refresh() {
    const generation = ++seriesGeneration;
    state.seriesError = '';
    if (state.selected.length === 0) {
      state.series = [];
      state.seriesLoading = false;
      publish();
      return { series: [], from: state.from, to: state.to };
    }
    state.seriesLoading = true;
    publish();
    try {
      const result = await runtime.modbusHistory.querySeries(seriesQuery());
      if (!disposed && generation === seriesGeneration) {
        state.series = structuredClone(result.series ?? []);
        publish();
      }
      return result;
    } catch (error) {
      if (!disposed && generation === seriesGeneration) {
        state.seriesError = errorMessage(error);
        publish();
      }
      throw error;
    } finally {
      if (!disposed && generation === seriesGeneration) {
        state.seriesLoading = false;
        publish();
      }
    }
  }

  async function loadRows(page = state.page, pageSize = state.pageSize) {
    const generation = ++rowsGeneration;
    state.rowsError = '';
    if (state.selected.length === 0) {
      state.rows = [];
      state.rowsTotal = 0;
      state.page = 1;
      state.pageSize = pageSize;
      state.rowsLoading = false;
      publish();
      return { rows: [], total: 0, page: 1, pageSize };
    }
    state.rowsLoading = true;
    publish();
    try {
      const result = await runtime.modbusHistory.queryRows({
        ...activeScope(), page, pageSize,
      });
      if (!disposed && generation === rowsGeneration) {
        state.rows = structuredClone(result.rows ?? []);
        state.rowsTotal = result.total ?? 0;
        state.page = result.page ?? page;
        state.pageSize = result.pageSize ?? pageSize;
        publish();
      }
      return result;
    } catch (error) {
      if (!disposed && generation === rowsGeneration) {
        state.rowsError = errorMessage(error);
        publish();
      }
      throw error;
    } finally {
      if (!disposed && generation === rowsGeneration) {
        state.rowsLoading = false;
        publish();
      }
    }
  }

  async function load() {
    return Promise.allSettled([refresh(), loadRows(1, state.pageSize)]);
  }

  function exportCsv() {
    return runtime.modbusHistory.exportCsv({
      ...activeScope(), page: 1, pageSize: DEFAULT_PAGE_SIZE,
    });
  }

  async function clear() {
    if (state.selected.length === 0) throw new RangeError('请选择至少一个数据点。');
    const deleted = await runtime.modbusHistory.clear({
      ...activeScope(), page: 1, pageSize: DEFAULT_PAGE_SIZE,
    });
    if (!disposed) await Promise.allSettled([refresh(), loadRows(1, state.pageSize)]);
    return deleted;
  }

  function activeScope() {
    return {
      endpointId: endpoint.id,
      points: state.selected.map((identity) => structuredClone(identity)),
      from: state.from,
      to: state.to,
    };
  }

  function seriesQuery() {
    return { ...activeScope(), bucketCount: bucketCountForWidth(state.chartWidth) };
  }

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (disposed) return () => {};
    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function publish() {
    for (const listener of [...listeners]) {
      try { listener(state); } catch { /* View observers do not own query state. */ }
    }
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    seriesGeneration += 1;
    rowsGeneration += 1;
    listeners.clear();
  }

  return {
    state,
    points,
    get seriesGroups() { return groupModbusPointSeriesByUnit(state.series); },
    selectPoint,
    setChartWidth,
    setPreset,
    setCustomRange,
    refresh,
    loadRows,
    load,
    exportCsv,
    clear,
    activeScope,
    subscribe,
    dispose,
  };
}

export function groupModbusPointSeriesByUnit(values) {
  const groups = new Map();
  for (const value of values ?? []) {
    const unit = typeof value.unit === 'string' ? value.unit : '';
    const group = groups.get(unit) ?? { unit, series: [] };
    group.series.push(value);
    groups.set(unit, group);
  }
  return [...groups.values()];
}

function buildPointCatalog(config) {
  const result = [];
  for (const group of [...(config?.requestGroups ?? [])]
    .sort((left, right) => left.order - right.order)) {
    for (const request of [...(group.requests ?? [])]
      .sort((left, right) => left.order - right.order)) {
      for (const point of request.dataPoints ?? []) {
        result.push(Object.freeze({
          groupId: group.id,
          groupName: group.name,
          requestId: request.id,
          requestName: request.name,
          pointId: point.id,
          pointKey: point.key,
          pointName: point.name,
          dataType: point.dataType,
          unit: point.unit ?? '',
          saveHistory: point.saveHistory === true,
          identity: Object.freeze({
            requestGroupId: group.id,
            requestId: request.id,
            pointId: point.id,
          }),
        }));
      }
    }
  }
  return result;
}

function requireCatalogIdentity(points, identity) {
  const match = points.find((point) => sameIdentity(point.identity, identity));
  if (!match) throw new RangeError('unknown Modbus point identity');
  return match.identity;
}

function sameIdentity(left, right) {
  return left?.requestGroupId === right?.requestGroupId
    && left?.requestId === right?.requestId
    && left?.pointId === right?.pointId;
}

function bucketCountForWidth(width) {
  return Math.min(2_000, Math.max(50, Math.round(width * 1.5)));
}

function requireRange(from, to) {
  if (!Number.isSafeInteger(from) || from < 0 || !Number.isSafeInteger(to) || to < from) {
    throw new TypeError('trend range must use safe timestamps with from <= to');
  }
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}
