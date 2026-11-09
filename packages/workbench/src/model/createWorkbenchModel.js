import { isWebSocketTransport, snapshotWebSocketHeaders } from './websocketConfig.js';
import { assertRuntimeAdapter } from '@ineed-linklab/runtime-contract';

import { appendRealtimeItemsByEndpoint } from '../lib/realtimeItems.js';
import { normalizeTcpResilienceConfig } from './endpointDraft.js';
import { createDlt645SimulatorManager } from './dlt645SimulatorController.js';
import { createEndpointLifecycleCoordinator } from './endpointLifecycleCoordinator.js';
import { filterFrames } from './messageFilters.js';
import { createModbusSlaveSimulation } from './modbusSlaveSimulation.js';
import { createModbusMasterScheduler } from './modbusMasterScheduler.js';
import { createModbusPointHistoryCollector } from './modbusPointHistoryCollector.js';
import { createScheduledSender } from './scheduledSender.js';
import { createSendWireRequest } from './sendWireRequest.js';
import { DEFAULT_SETTINGS, normalizeSettings } from './secondaryViews.js';
import { createTcpReconnectController } from './tcpReconnectController.js';
import {
  isNonblankString, isPlainObject, requireNonblankString,
  snapshotCloneOverrides, snapshotEndpoint, snapshotEndpointList,
  snapshotFrameEvent, snapshotOperation, snapshotPeerEvent,
  snapshotPlainJson, snapshotStatusEvent,
} from './workbenchSnapshots.js';

const endpointFilters = new Set(['all', 'serial', 'tcp', 'udp', 'modbus', 'dlt645', 'websocket']);
const RETENTION_INTERVAL_MS = 86_400_000;

export class WorkbenchDisposedError extends Error {
  constructor() {
    super('Workbench model is disposed');
    this.name = 'WorkbenchDisposedError';
    this.code = 'WORKBENCH_DISPOSED';
  }
}

export class EndpointNotFoundError extends Error {
  constructor(endpointId) {
    super(`Endpoint "${endpointId}" is not tracked by the workbench`);
    this.name = 'EndpointNotFoundError';
    this.code = 'ENDPOINT_NOT_FOUND';
    this.endpointId = endpointId;
  }
}

export class EndpointIdentityMismatchError extends Error {
  constructor(message) {
    super(message);
    this.name = 'EndpointIdentityMismatchError';
    this.code = 'ENDPOINT_ID_MISMATCH';
  }
}

export class DuplicateOperationIdError extends Error {
  constructor(endpointId, operationId) {
    super(`Operation "${operationId}" is already active or pending for ${endpointId}`);
    this.name = 'DuplicateOperationIdError';
    this.code = 'DUPLICATE_OPERATION_ID';
    this.endpointId = endpointId;
    this.operationId = operationId;
  }
}

export function createWorkbenchModel(runtimeAdapter, {
  frameLimit,
  logLimit,
  clock,
  timers,
  createReconnectOperationId,
} = {}) {
  assertRuntimeAdapter(runtimeAdapter);

  let currentFrameLimit = frameLimit ?? DEFAULT_SETTINGS.realtimeFrameLimit;
  let currentLogLimit = logLimit ?? DEFAULT_SETTINGS.realtimeLogLimit;
  const state = {
    endpoints: [],
    endpointFilter: 'all',
    activeEndpointId: null,
    activePeerId: null,
    frameFilters: { direction: 'all', peerId: 'all', keyword: '' },
    operations: new Map(),
    reconnects: new Map(),
    statuses: new Map(),
    peers: new Map(),
    frames: [],
    logs: [],
    counters: emptyCounters(),
    endpointCounters: new Map(),
    historyPersistenceWarning: null,
    commandError: null,
    commandErrorMeta: null,
    commandErrors: new Map(),
    disposed: false,
    preferences: { ...DEFAULT_SETTINGS },
  };
  const websocketHeaders = new Map();
  let disposed = false;
  let dlt645Simulators = null;
  let scheduledSender = null;
  let modbusMasterScheduler = null;
  let modbusSlaveSimulation = null;
  let retentionTimerId = null;
  let retentionGeneration = 0;
  let retentionLoaded = false;
  let retentionCleanupRunning = false;
  let retentionLastCleanupAt = null;
  let retentionCleanupError = null;
  const reconcileSchedulers = (options = {}) => {
    const context = {
      endpoints: state.endpoints,
      operations: state.operations,
      statuses: state.statuses,
      ...options,
    };
    scheduledSender?.reconcile(context);
    modbusMasterScheduler?.reconcile(context);
    dlt645Simulators?.reconcile(context);
    modbusSlaveSimulation?.reconcile(context);
  };
  const notifier = createStateNotifier(state, reconcileSchedulers);
  const modbusPointHistoryCollector = createModbusPointHistoryCollector({
    recordBatch: runtimeAdapter.modbusHistory.recordBatch,
    ...(typeof clock === 'function' ? { clock } : {}),
    ...(timers ? { timers } : {}),
  });
  const unsubscribePointHistory = modbusPointHistoryCollector.subscribe(() => {
    if (!disposed) notifier.notify();
  });
  const retentionTimers = timers ?? globalThis;
  // endpointId owns saved configuration; operationId identifies one open intent.
  // The runtime creates sessionId for the actual connection. The coordinator
  // invalidates superseded intents and binds the first accepted session so old
  // operations/sessions cannot mutate this model (see docs/code-reading.md).
  const coordinator = createEndpointLifecycleCoordinator({
    cancelOpen: runtimeAdapter.transport.cancelOpen,
    createDisposedError: () => new WorkbenchDisposedError(),
  });
  let openReconnectAttempt;
  const reconnectController = createTcpReconnectController({
    states: state.reconnects,
    openAttempt: (request) => openReconnectAttempt(request),
    onChange: () => { if (!disposed) notifier.notify(); },
    ...(typeof clock === 'function' ? { clock } : {}),
    ...(timers ? { timers } : {}),
    ...(createReconnectOperationId ? { createOperationId: createReconnectOperationId } : {}),
  });
  const disarmReconnect = (endpointId) => {
    const cancelled = reconnectController.cancel(endpointId);
    const operation = state.operations.get(endpointId);
    const invalidation = cancelled?.phase === 'connecting'
      && operation?.operationId === cancelled.operationId
      ? beginStateInvalidation(state, coordinator, endpointId, {
        operationId: cancelled.operationId,
        forceRuntime: true,
      })
      : null;
    return { cancelled, invalidation };
  };

  // Each handler snapshots input, checks identity, mutates state, then notifies.
  const applyFrames = applyValidatedEvent(snapshotFrameEvent, (event) => {
    if (!matchesActiveOperation(state, coordinator, event)) return;
    adoptSession(state, event);
    coordinator.bindEventSession(event.endpointId, event.operationId, event.sessionId);
    if (event.frames.length === 0) {
      notifier.notify();
      return;
    }
    dlt645Simulators?.reconcile({ endpoints: state.endpoints, operations: state.operations, statuses: state.statuses });
    dlt645Simulators?.consume(event);
    state.frames = appendRealtimeItemsByEndpoint(state.frames, event.frames, currentFrameLimit);
    const counts = countsForFrames(event.frames);
    incrementEndpointCounters(state, event.endpointId, counts);
    notifier.notify();
  }, () => disposed);
  const applyStatus = applyValidatedEvent(snapshotStatusEvent, (event) => {
    if (!matchesActiveOperation(state, coordinator, event)) return;
    if (!statusLogSourceMatchesEndpoint(state, event)) return;
    if (event.sessionId !== null) {
      adoptSession(state, event);
      coordinator.bindEventSession(event.endpointId, event.operationId, event.sessionId);
    }
    state.statuses.set(event.endpointId, event);
    if (event.log !== null) {
      const log = Object.freeze({
        ...event.log,
        endpointId: event.endpointId,
        sessionId: event.sessionId,
      });
      state.logs = appendRealtimeItemsByEndpoint(state.logs, [log], currentLogLimit);
      incrementEndpointCounters(state, event.endpointId, { logs: 1 });
    }
    if (event.status === 'open') {
      reconnectController.connected(event);
    } else if (event.status === 'error' || event.status === 'closed') {
      reconnectController.failed({
        ...event,
        sessionId: event.sessionId ?? state.operations.get(event.endpointId)?.sessionId ?? null,
      });
    }
    notifier.notify();
  }, () => disposed);
  const applyPeers = applyValidatedEvent(snapshotPeerEvent, (event) => {
    if (!matchesActiveOperation(state, coordinator, event)) return;
    adoptSession(state, event);
    coordinator.bindEventSession(event.endpointId, event.operationId, event.sessionId);
    state.peers.set(event.endpointId, event.peers);
    if (
      state.activeEndpointId === event.endpointId
      && state.activePeerId !== null
      && !event.peers.some(({ id }) => id === state.activePeerId)
    ) {
      state.activePeerId = null;
    }
    notifier.notify();
  }, () => disposed);

  const unsubscribes = subscribeTransaction([
    [runtimeAdapter.transport.onFrames, applyFrames, 'transport.onFrames'],
    [runtimeAdapter.transport.onStatus, applyStatus, 'transport.onStatus'],
    [runtimeAdapter.transport.onPeers, applyPeers, 'transport.onPeers'],
    ...(typeof runtimeAdapter.transport.onPersistenceWarning === 'function' ? [[
      runtimeAdapter.transport.onPersistenceWarning,
      (warning) => {
        if (disposed) return;
        state.historyPersistenceWarning = {
          message: String(warning?.message ?? 'History persistence failed').slice(0, 256),
          rowCount: Number.isSafeInteger(warning?.rowCount) ? warning.rowCount : null,
        };
        notifier.notify();
      },
      'transport.onPersistenceWarning',
    ]] : []),
  ]);
  const commands = createCommandRunner(state, () => disposed, notifier.notify);

  const model = {
    state,
    get filteredEndpoints() {
      return state.endpoints.filter(endpointPredicate(state.endpointFilter));
    },
    get activeEndpoint() {
      return state.endpoints.find(({ id }) => id === state.activeEndpointId) ?? null;
    },
    get activePeer() {
      return model.peersForEndpoint(state.activeEndpointId)
        .find(({ id }) => id === state.activePeerId) ?? null;
    },
    get visibleFrames() {
      return filterFrames(
        state.frames.filter(({ endpointId }) => endpointId === state.activeEndpointId),
        state.frameFilters,
        { peers: model.peersForEndpoint(state.activeEndpointId) },
      );
    },
    get visibleLogs() {
      const minimum = logRank(state.preferences.logLevel);
      return state.logs.filter((log) => (
        log.endpointId === state.activeEndpointId && logRank(log.level) >= minimum
      ));
    },
    subscribe: notifier.subscribe,
    commandErrorForEndpoint(endpointId) {
      let latest = null;
      for (const metadata of state.commandErrors.values()) {
        if (metadata.endpointId === endpointId && (latest === null || metadata.sequence > latest.sequence)) {
          latest = metadata;
        }
      }
      return latest?.error ?? null;
    },
    reconnectStateFor(endpointId) {
      return reconnectController.stateFor(endpointId);
    },
    setEndpointFilter(filter) {
      if (disposed) return;
      if (!endpointFilters.has(filter)) throw new TypeError('Unsupported endpoint filter');
      state.endpointFilter = filter;
      notifier.notify();
    },
    selectEndpoint(endpointId) {
      if (disposed) return;
      if (state.activeEndpointId !== endpointId) state.activePeerId = null;
      state.activeEndpointId = endpointId;
      notifier.notify();
    },
    selectPeer(peerId) {
      if (disposed) return;
      const endpoint = model.activeEndpoint;
      if (!['tcp-server', 'websocket-server'].includes(endpoint?.transport)) {
        state.activePeerId = null;
        notifier.notify();
        return;
      }
      state.activePeerId = model.peersForEndpoint(endpoint.id).some(({ id }) => id === peerId)
        ? peerId
        : null;
      notifier.notify();
    },
    setFrameFilters(filters) {
      if (disposed) return;
      state.frameFilters = { ...state.frameFilters, ...filters };
      notifier.notify();
    },
    updatePreferences(values) {
      if (disposed) return;
      const previousRetention = state.preferences.modbusPointHistoryRetention;
      state.preferences = normalizeSettings({ ...state.preferences, ...values });
      currentFrameLimit = state.preferences.realtimeFrameLimit;
      currentLogLimit = state.preferences.realtimeLogLimit;
      state.frames = appendRealtimeItemsByEndpoint([], state.frames, currentFrameLimit);
      state.logs = appendRealtimeItemsByEndpoint([], state.logs, currentLogLimit);
      notifier.notify();
      if (!retentionLoaded
        || previousRetention !== state.preferences.modbusPointHistoryRetention) {
        retentionLoaded = true;
        void applyRetentionPolicy(state.preferences.modbusPointHistoryRetention);
      }
    },
    peersForEndpoint(endpointId) {
      return state.peers.get(endpointId) ?? [];
    },
    activateOperation(operation) {
      if (disposed) return;
      const snapshot = snapshotOperation(operation);
      const previous = state.operations.get(snapshot.endpointId);
      if (isReplacementOperation(previous, snapshot)) {
        modbusPointHistoryCollector.reset(snapshot.endpointId);
        clearEndpointOperationState(state, snapshot.endpointId);
      }
      state.operations.set(snapshot.endpointId, snapshot);
      notifier.notify();
    },
    clearRealtime() {
      if (disposed) return;
      state.frames = [];
      state.logs = [];
      state.endpointCounters.clear();
      state.counters = emptyCounters();
      notifier.notify();
    },
    websocketHeadersForEndpoint(endpointId) {
      return (websocketHeaders.get(endpointId) ?? []).map(header => ({ ...header }));
    },
    resetWorkspaceState() {
      if (disposed) return;
      cancelRetentionCleanup();
      retentionLoaded = false;
      modbusPointHistoryCollector.reset();
      reconcileSchedulers({ reset: true });
      for (const endpointId of reconnectEndpointIds(state)) {
        consumeInvalidationFailure(disarmReconnect(endpointId).invalidation);
      }
      coordinator.reset();
      websocketHeaders.clear();
      state.endpoints = [];
      state.activeEndpointId = null;
      state.activePeerId = null;
      state.operations.clear();
      state.statuses.clear();
      state.peers.clear();
      state.frames = [];
      state.logs = [];
      state.endpointCounters.clear();
      state.counters = emptyCounters();
      state.commandError = null;
      state.commandErrorMeta = null;
      state.commandErrors.clear();
      notifier.notify();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      websocketHeaders.clear();
      state.disposed = true;
      cancelRetentionCleanup();
      scheduledSender?.dispose();
      modbusMasterScheduler?.dispose();
      modbusSlaveSimulation?.dispose();
      dlt645Simulators?.dispose();
      unsubscribePointHistory();
      void modbusPointHistoryCollector.dispose();
      for (const endpointId of reconnectEndpointIds(state)) {
        consumeInvalidationFailure(disarmReconnect(endpointId).invalidation);
      }
      reconnectController.dispose();
      coordinator.dispose();
      clearOpeningIntents(state);
      for (const unsubscribe of unsubscribes) safeUnsubscribe(unsubscribe);
      notifier.finish();
    },
    commands: {},
    scheduledSender: null,
    modbusMasterScheduler: null,
    modbusSlaveSimulation: null,
    dlt645Simulators: null,
    modbusPointHistoryCollector,
    get modbusPointHistoryStatus() {
      return {
        ...modbusPointHistoryCollector.getStatus(),
        cleanupRunning: retentionCleanupRunning,
        lastCleanupAt: retentionLastCleanupAt,
        cleanupError: retentionCleanupError,
      };
    },
    async flushModbusPointHistory() {
      await modbusPointHistoryCollector.flush();
      return runtimeAdapter.modbusHistory.flush();
    },
    async importWorkspace() {
      await model.flushModbusPointHistory();
      const result = await runtimeAdapter.workspace.import();
      if (result?.canceled !== true) websocketHeaders.clear();
      return result;
    },
    async clearModbusPointHistory(query) {
      await model.flushModbusPointHistory();
      return runtimeAdapter.modbusHistory.clear(query);
    },
    async exportModbusPointHistory(query) {
      await model.flushModbusPointHistory();
      return runtimeAdapter.modbusHistory.exportCsv(query);
    },
    cleanupModbusPointHistory(retention = state.preferences.modbusPointHistoryRetention) {
      return runRetentionCleanup(retention);
    },
  };

  const commandBundle = createCommands(
    model,
    state,
    runtimeAdapter,
    commands.run,
    coordinator,
    reconnectController,
    disarmReconnect,
    notifier.notify,
    modbusPointHistoryCollector,
    websocketHeaders,
  );
  model.commands = commandBundle.commands;
  openReconnectAttempt = commandBundle.openReconnectAttempt;
  const scheduledClock = timers ?? (typeof clock === 'object' ? clock : null);
  scheduledSender = createScheduledSender({
    send: model.commands.send,
    ...(scheduledClock ? { clock: scheduledClock } : {}),
  });
  modbusMasterScheduler = createModbusMasterScheduler({
    execute: runtimeAdapter.modbus.execute,
    onPointOutcomes: modbusPointHistoryCollector.capture,
    ...(typeof clock === 'function' ? { clock } : {}),
    ...(timers ? { timers } : {}),
  });
  dlt645Simulators = createDlt645SimulatorManager({ send: model.commands.send, timers });
  model.dlt645Simulators = dlt645Simulators;
  model.scheduledSender = scheduledSender;
  model.modbusMasterScheduler = modbusMasterScheduler;
  modbusSlaveSimulation = createModbusSlaveSimulation({ writeMap: runtimeAdapter.modbus.writeMap, timers });
  model.modbusSlaveSimulation = modbusSlaveSimulation;
  reconcileSchedulers();
  return model;

  function cancelRetentionCleanup() {
    retentionGeneration += 1;
    retentionCleanupRunning = false;
    if (retentionTimerId !== null) {
      retentionTimers.clearTimeout(retentionTimerId);
      retentionTimerId = null;
    }
  }

  async function applyRetentionPolicy(retention) {
    try {
      return await runRetentionCleanup(retention);
    } catch {
      return null;
    }
  }

  function runRetentionCleanup(retention) {
    cancelRetentionCleanup();
    const currentGeneration = retentionGeneration;
    if (retention === 'forever') {
      retentionCleanupError = null;
      notifier.notify();
      return Promise.resolve({ deletedCount: 0, completedAt: null, skipped: true });
    }
    retentionCleanupRunning = true;
    retentionCleanupError = null;
    notifier.notify();
    return Promise.resolve(runtimeAdapter.modbusHistory.cleanup(retention))
      .then((result) => {
        if (!disposed && currentGeneration === retentionGeneration) {
          retentionLastCleanupAt = Number.isSafeInteger(result?.completedAt)
            ? result.completedAt
            : (typeof clock === 'function' ? clock() : Date.now());
          retentionCleanupError = null;
        }
        return result;
      })
      .catch((error) => {
        if (!disposed && currentGeneration === retentionGeneration) {
          retentionCleanupError = error instanceof Error ? error.message : String(error);
        }
        throw error;
      })
      .finally(() => {
        if (disposed || currentGeneration !== retentionGeneration) return;
        retentionCleanupRunning = false;
        retentionTimerId = retentionTimers.setTimeout(() => {
          retentionTimerId = null;
          void applyRetentionPolicy(state.preferences.modbusPointHistoryRetention);
        }, RETENTION_INTERVAL_MS);
        retentionTimerId?.unref?.();
        notifier.notify();
      });
  }
}

function logRank(level) {
  return { debug: 0, info: 1, warn: 2, warning: 2, error: 3 }[level] ?? 1;
}

function createCommands(
  model,
  state,
  runtimeAdapter,
  runCommand,
  coordinator,
  reconnectController,
  disarmReconnect,
  notify,
  modbusPointHistoryCollector,
  websocketHeaders,
) {
  async function executeOpenLifecycle({
    endpointId,
    operationId,
    intent,
    command,
    prepareReconnect,
  }) {
    const priorGate = captureEndpointGate(state, endpointId);
    const transition = coordinator.beginOpenIntent(endpointId, operationId, {
      blockedSessionIds: priorGate.operation?.sessionId
        ? [priorGate.operation.sessionId]
        : [],
    });
    invalidateEndpointOperation(state, endpointId);
    state.operations.set(endpointId, intent);
    notify();
    const readiness = transition.cancellation.catch((error) => {
      if (transition.wasRolledBack()) {
        restoreEndpointGate(state, endpointId, priorGate);
        notify();
      }
      throw error;
    });
    try {
      const value = await coordinator.enqueueOpen(
        transition.intent,
        async () => {
          await readiness;
          requireTrackedEndpoint(state, endpointId);
          if (!coordinator.isCurrent(transition.intent)) {
            throw createSupersededOpenError(endpointId, operationId);
          }
          prepareReconnect?.();
          return runtimeAdapter.transport.open(endpointId, { operationId,
            ...(state.endpoints.find(endpoint => endpoint.id === endpointId)?.transport === 'websocket-client'
              ? { websocketHeaders: model.websocketHeadersForEndpoint(endpointId) } : {}),
          });
        },
        { readiness },
      );
      const sessionId = requireOpenSessionId(value);
      if (
        command.isActive()
        && coordinator.isCurrent(transition.intent)
        && endpointExists(state, endpointId)
      ) {
        coordinator.bindSession(transition.intent, sessionId);
        model.activateOperation({ endpointId, sessionId, operationId });
        reconnectController.connected({ endpointId, operationId, sessionId });
      } else if (coordinator.isCurrent(transition.intent)) {
        coordinator.clearIntent(transition.intent);
        invalidateEndpointOperation(state, endpointId);
        notify();
      }
      return value;
    } catch (error) {
      reconnectController.failed({
        endpointId, operationId, sessionId: null, error,
      });
      if (coordinator.isCurrent(transition.intent)) {
        coordinator.clearIntent(transition.intent);
        invalidateEndpointOperation(state, endpointId);
        notify();
      }
      throw error;
    }
  }

  function openEndpoint(endpointId, operationId, { origin = 'manual' } = {}) {
    return runCommand(`transport:${endpointId}`, async (command) => {
      requireTrackedEndpoint(state, endpointId);
      const intent = snapshotOperation({ endpointId, sessionId: null, operationId });
      if (
        state.operations.get(endpointId)?.operationId === operationId
        || coordinator.hasOperation(endpointId, operationId)
      ) {
        throw new DuplicateOperationIdError(endpointId, operationId);
      }
      let prepareReconnect = null;
      if (origin === 'manual') {
        prepareReconnect = () => {
          const endpoint = state.endpoints.find(({ id }) => id === endpointId);
          const resilience = normalizeTcpResilienceConfig(endpoint.config, endpoint.transport);
          if (isTcpReconnectTransport(endpoint.transport) && resilience.autoReconnect === true) {
            reconnectController.arm(endpointId, operationId);
          } else {
            reconnectController.cancel(endpointId);
          }
        };
      }
      return executeOpenLifecycle({
        endpointId, operationId, intent, command, prepareReconnect,
      });
    }, { endpointId });
  }

  const commands = {
    loadEndpoints: () => runCommand('endpoint:collection', async (command) => {
      const load = coordinator.beginLoad();
      const endpoints = snapshotEndpointList(await runtimeAdapter.endpoint.list());
      if (command.isActive() && coordinator.canApplyLoad(load)) {
        const activeIds = new Set(endpoints.map(({ id }) => id));
        const eligibleIds = new Set(endpoints.filter(isAutoReconnectEndpoint).map(({ id }) => id));
        const invalidations = [];
        for (const { id } of state.endpoints) {
          if (!activeIds.has(id) || !eligibleIds.has(id)) {
            const { invalidation } = disarmReconnect(id);
            if (invalidation) invalidations.push(invalidation);
            else if (!activeIds.has(id)) {
              invalidations.push(beginStateInvalidation(state, coordinator, id));
            }
          }
        }
        await acknowledgeInvalidations(state, invalidations);
        if (command.isActive() && coordinator.canApplyLoad(load)) {
          resetChangedHistoryConfigurations(
            state.endpoints, endpoints, modbusPointHistoryCollector,
          );
          applyEndpointRefresh(state, endpoints);
          reconnectController.reconcile(endpoints);
          coordinator.recordCollectionMutation();
          notify();
        }
      }
      return endpoints;
    }),
    save: (draft, options = {}) => runCommand('endpoint:collection', async (command) => {
      const requested = snapshotEndpoint(draft);
      const headers = options.websocketHeaders === undefined ? undefined
        : snapshotWebSocketHeaders(options.websocketHeaders);
      const { invalidation } = disarmReconnect(requested.id);
      if (invalidation) {
        notify();
        await acknowledgeInvalidations(state, [invalidation]);
      }
      const endpoint = snapshotEndpoint(await runtimeAdapter.endpoint.save(requested));
      requireResultIdentity(endpoint.id, requested.id, 'save');
      if (command.isActive()) {
        if (headers !== undefined && isWebSocketTransport(endpoint.transport)) websocketHeaders.set(endpoint.id, headers);
        modbusPointHistoryCollector.reset(endpoint.id);
        applyEndpointCollectionMutation(state, coordinator, { upsert: endpoint });
        reconnectController.reconcile(state.endpoints);
        notify();
      }
      return endpoint;
    }),
    clone: (sourceEndpointId, overrides) => runCommand(
      'endpoint:collection',
      async (command) => {
        requireNonblankString(sourceEndpointId, 'sourceEndpointId');
        const cloneOverrides = snapshotCloneOverrides(overrides);
        if (cloneOverrides.id === sourceEndpointId) {
          throw new EndpointIdentityMismatchError('Clone id must differ from its source id');
        }
        const endpoint = snapshotEndpoint(
          await runtimeAdapter.endpoint.clone(sourceEndpointId, cloneOverrides),
        );
        requireResultIdentity(endpoint.id, cloneOverrides.id, 'clone');
        if (command.isActive()) {
          applyEndpointCollectionMutation(state, coordinator, { upsert: endpoint });
          notify();
        }
        return endpoint;
      },
    ),
    delete: (endpointId) => runCommand('endpoint:collection', async (command) => {
      const disarmed = disarmReconnect(endpointId);
      const invalidation = disarmed.invalidation
        ?? beginStateInvalidation(state, coordinator, endpointId);
      notify();
      await acknowledgeInvalidations(state, [invalidation]);
      const value = await runtimeAdapter.endpoint.delete(endpointId);
      if (command.isActive()) {
        websocketHeaders.delete(endpointId);
        modbusPointHistoryCollector.reset(endpointId);
        applyEndpointCollectionMutation(state, coordinator, { remove: endpointId });
        reconnectController.reconcile(state.endpoints);
        notify();
      }
      return value;
    }),
    scanSerialPorts: () => runCommand(
      'transport:serial-ports',
      () => runtimeAdapter.transport.scanSerialPorts(),
    ),
    open: (endpointId, operationId) => openEndpoint(endpointId, operationId),
    cancelOpen: (endpointId, operationId) => runCommand(
      `transport:${endpointId}`,
      async () => {
        const disarmed = disarmReconnect(endpointId);
        const invalidation = disarmed.invalidation ?? beginStateInvalidation(
          state, coordinator, endpointId, { operationId, forceRuntime: true },
        );
        notify();
        await acknowledgeInvalidations(state, [invalidation]);
        return null;
      },
      { endpointId },
    ),
    cancelReconnect: (endpointId) => runCommand(
      `transport:${endpointId}`,
      async () => {
        const { invalidation } = disarmReconnect(endpointId);
        if (invalidation) {
          notify();
          await acknowledgeInvalidations(state, [invalidation]);
        }
        return null;
      },
      { endpointId },
    ),
    close: (endpointId) => runCommand(`transport:${endpointId}`, async () => {
      const disarmed = disarmReconnect(endpointId);
      const invalidation = disarmed.invalidation
        ?? beginStateInvalidation(state, coordinator, endpointId);
      notify();
      const readiness = acknowledgeInvalidations(state, [invalidation]);
      return coordinator.enqueue(
        endpointId,
        async () => {
          await readiness;
          return runtimeAdapter.transport.close(endpointId);
        },
        { readiness },
      );
    }, { endpointId }),
    send: (request) => runCommand(
      `transport:send:${request?.endpointId ?? ''}`,
      async () => {
        const endpoint = state.endpoints.find(endpoint => endpoint.id === request?.endpointId);
        const websocket = isWebSocketTransport(endpoint?.transport);
        const messageType = request?.messageType ?? endpoint?.config?.messageType ?? 'text';
        const effectiveRequest = websocket ? { ...request, framing: 'websocket',
          format: messageType === 'binary' ? 'hex' : 'text' } : request;
        const historyRecord = canSnapshotSendHistory(effectiveRequest)
          ? snapshotSendHistoryRequest(effectiveRequest)
          : null;
        const wireRequest = historyRecord ? createSendWireRequest(effectiveRequest) : effectiveRequest;
        const acknowledgement = await runtimeAdapter.transport.send(wireRequest);
        try {
          await runtimeAdapter.sendHistory.record({
            ...(historyRecord ?? snapshotSendHistoryRequest(request)),
            sessionId: nonblankStringOrNull(acknowledgement?.sessionId),
            createdAt: Date.now(),
          });
          return acknowledgement;
        } catch (error) {
          return {
            ...(isPlainObject(acknowledgement) ? acknowledgement : { value: acknowledgement }),
            historyPersisted: false,
            historyError: error instanceof Error ? error.message : String(error),
          };
        }
      },
      { endpointId: request?.endpointId ?? null },
    ),
    disconnectPeer: (request) => runCommand(
      `transport:peer:${request?.endpointId ?? ''}:${request?.peerId ?? ''}`,
      () => runtimeAdapter.transport.disconnectPeer(request),
      { endpointId: request?.endpointId ?? null },
    ),
  };
  return {
    commands,
    openReconnectAttempt: ({ endpointId, operationId }) => (
      openEndpoint(endpointId, operationId, { origin: 'reconnect' })
    ),
  };
}

function canSnapshotSendHistory(request) {
  return isPlainObject(request)
    && typeof request.endpointId === 'string'
    && request.endpointId.trim() !== ''
    && request.bytes instanceof Uint8Array;
}

function snapshotSendHistoryRequest(request) {
  if (!isPlainObject(request)) throw new TypeError('send request must be a plain object');
  requireNonblankString(request.endpointId, 'send request.endpointId');
  if (!(request.bytes instanceof Uint8Array)) {
    throw new TypeError('send request.bytes must be a Uint8Array');
  }
  const bytes = new Uint8Array(request.bytes);
  const target = request.target === undefined ? null : snapshotPlainJson(request.target, 'send target');
  const peerId = nonblankStringOrNull(target?.peerId);
  return Object.freeze({
    endpointId: request.endpointId,
    peerId,
    target,
    format: typeof request.format === 'string' && request.format.trim() ? request.format : 'text',
    framing: typeof request.framing === 'string' && request.framing.trim() ? request.framing : 'none',
    payloadBase64: encodeBase64(bytes),
  });
}

function nonblankStringOrNull(value) {
  return typeof value === 'string' && value.trim() ? value : null;
}

function encodeBase64(bytes) {
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function createCommandRunner(state, isDisposed, notify) {
  const resourceGenerations = new Map();
  let latestCommand = 0;
  let errorSequence = 0;

  return {
    async run(resource, operation, { endpointId = null } = {}) {
      if (isDisposed()) {
        return { ok: false, error: new WorkbenchDisposedError() };
      }
      const resourceGeneration = (resourceGenerations.get(resource) ?? 0) + 1;
      resourceGenerations.set(resource, resourceGeneration);
      latestCommand += 1;
      const commandGeneration = latestCommand;
      const command = {
        isActive: () => !isDisposed(),
        isCurrent: () => !isDisposed()
          && resourceGenerations.get(resource) === resourceGeneration,
        isLatest: () => !isDisposed()
          && resourceGenerations.get(resource) === resourceGeneration
          && latestCommand === commandGeneration,
      };

      try {
        const value = await operation(command);
        if (command.isCurrent() && clearCommandError(state, resource)) notify();
        return { ok: true, value };
      } catch (error) {
        const normalized = normalizeError(error);
        if (command.isCurrent()) {
          errorSequence += 1;
          const metadata = Object.freeze({
            endpointId,
            error: normalized,
            resource,
            sequence: errorSequence,
          });
          state.commandErrors.set(resource, metadata);
          state.commandError = normalized;
          state.commandErrorMeta = metadata;
          notify();
        }
        return { ok: false, error: normalized };
      }
    },
  };
}

function clearCommandError(state, resource) {
  if (!state.commandErrors.delete(resource)) return false;
  if (state.commandErrorMeta?.resource !== resource) return true;
  let latest = null;
  for (const metadata of state.commandErrors.values()) {
    if (latest === null || metadata.sequence > latest.sequence) latest = metadata;
  }
  state.commandErrorMeta = latest;
  state.commandError = latest?.error ?? null;
  return true;
}

function createStateNotifier(state, beforeNotify = () => {}) {
  const listeners = new Set();
  let dispatching = false;
  let pending = false;
  let finished = false;

  function subscribe(listener) {
    if (typeof listener !== 'function') throw new TypeError('listener must be a function');
    if (finished) return () => {};
    listeners.add(listener);
    return once(() => listeners.delete(listener));
  }

  function notify() {
    if (finished) return;
    beforeNotify();
    pending = true;
    if (dispatching) return;
    dispatching = true;
    try {
      while (pending && !finished) {
        pending = false;
        for (const listener of [...listeners]) {
          if (!listeners.has(listener)) continue;
          try {
            listener(state);
          } catch {
            // A listener cannot block model delivery to other subscribers.
          }
        }
      }
    } finally {
      dispatching = false;
    }
  }

  function finish() {
    if (finished) return;
    finished = true;
    pending = false;
    for (const listener of [...listeners]) {
      try {
        listener(state);
      } catch {
        // Dispose still completes when a listener fails.
      }
    }
    listeners.clear();
  }

  return { finish, notify, subscribe };
}

function subscribeTransaction(subscriptions) {
  const unsubscribes = [];
  try {
    for (const [subscribe, callback, label] of subscriptions) {
      const unsubscribe = subscribe(callback);
      if (typeof unsubscribe !== 'function') {
        throw new TypeError(`${label} must return an unsubscribe function`);
      }
      unsubscribes.push(once(unsubscribe));
    }
    return unsubscribes;
  } catch (error) {
    for (const unsubscribe of unsubscribes) safeUnsubscribe(unsubscribe);
    throw error;
  }
}

function applyValidatedEvent(snapshot, apply, isDisposed) {
  return (payload) => {
    if (isDisposed()) return;
    let event;
    try {
      event = snapshot(payload);
    } catch {
      return;
    }
    apply(event);
  };
}

function once(operation) {
  let called = false;
  return () => {
    if (called) return undefined;
    called = true;
    return operation();
  };
}

function safeUnsubscribe(unsubscribe) {
  try {
    Promise.resolve(unsubscribe()).catch(() => {});
  } catch {
    // Continue cleanup when one subscription cannot be removed cleanly.
  }
}

function statusLogSourceMatchesEndpoint(state, event) {
  if (event.log === null) return true;
  const endpoint = state.endpoints.find(({ id }) => id === event.endpointId);
  if (!endpoint) return true;
  const expectedSource = statusLogSourceForTransport(endpoint.transport);
  return expectedSource === null || event.log.source === expectedSource;
}

function statusLogSourceForTransport(transport) {
  if (transport === 'serial' || transport === 'dlt645-master' || transport === 'dlt645-slave') return 'serial';
  if (isWebSocketTransport(transport)) return 'websocket';
  if (transport === 'tcp-client' || transport === 'tcp-server') return 'tcp';
  if (transport === 'udp-client' || transport === 'udp-server') return 'udp';
  return null;
}

function applyEndpointRefresh(state, endpoints) {
  const activeIds = new Set(endpoints.map(({ id }) => id));
  state.endpoints = endpoints;
  pruneMap(state.operations, activeIds);
  pruneMap(state.statuses, activeIds);
  pruneMap(state.peers, activeIds);
  pruneMap(state.endpointCounters, activeIds);
  state.frames = state.frames.filter(({ endpointId }) => activeIds.has(endpointId));
  state.logs = state.logs.filter(({ endpointId }) => activeIds.has(endpointId));
  updateAggregateCounters(state);
  if (!activeIds.has(state.activeEndpointId)) {
    state.activeEndpointId = null;
    state.activePeerId = null;
  } else if (!state.peers.get(state.activeEndpointId)?.some(({ id }) => id === state.activePeerId)) {
    state.activePeerId = null;
  }
}

function resetChangedHistoryConfigurations(previous, next, collector) {
  const previousById = new Map(previous.map((endpoint) => [endpoint.id, endpoint]));
  const nextIds = new Set(next.map(({ id }) => id));
  for (const endpoint of next) {
    const prior = previousById.get(endpoint.id);
    if (prior && JSON.stringify(prior.config) !== JSON.stringify(endpoint.config)) {
      collector.reset(endpoint.id);
    }
  }
  for (const endpoint of previous) {
    if (!nextIds.has(endpoint.id)) collector.reset(endpoint.id);
  }
}

function removeEndpointState(state, endpointId) {
  state.endpoints = Object.freeze(state.endpoints.filter(({ id }) => id !== endpointId));
  state.operations.delete(endpointId);
  state.statuses.delete(endpointId);
  state.peers.delete(endpointId);
  state.endpointCounters.delete(endpointId);
  state.frames = state.frames.filter((frame) => frame.endpointId !== endpointId);
  state.logs = state.logs.filter((log) => log.endpointId !== endpointId);
  updateAggregateCounters(state);
  if (state.activeEndpointId === endpointId) {
    state.activeEndpointId = null;
    state.activePeerId = null;
  }
}

function applyEndpointCollectionMutation(state, coordinator, mutation) {
  if (mutation.upsert) {
    const index = state.endpoints.findIndex(({ id }) => id === mutation.upsert.id);
    state.endpoints = Object.freeze(index === -1
      ? [...state.endpoints, mutation.upsert]
      : state.endpoints.map((endpoint, endpointIndex) => (
        endpointIndex === index ? mutation.upsert : endpoint
      )));
  } else {
    removeEndpointState(state, mutation.remove);
  }
  coordinator.recordCollectionMutation();
}

function endpointExists(state, endpointId) {
  return state.endpoints.some(({ id }) => id === endpointId);
}

function isAutoReconnectEndpoint(endpoint) {
  return isTcpReconnectTransport(endpoint.transport)
    && normalizeTcpResilienceConfig(endpoint.config, endpoint.transport).autoReconnect === true;
}

function isTcpReconnectTransport(transport) {
  return ['tcp-client', 'modbus-tcp-master', 'websocket-client'].includes(transport);
}

function reconnectEndpointIds(state) {
  return new Set([
    ...state.endpoints.map(({ id }) => id),
    ...state.operations.keys(),
    ...state.reconnects.keys(),
  ]);
}

function requireTrackedEndpoint(state, endpointId) {
  if (!endpointExists(state, endpointId)) throw new EndpointNotFoundError(endpointId);
}

function captureEndpointGate(state, endpointId) {
  return {
    operation: state.operations.get(endpointId) ?? null,
    status: state.statuses.get(endpointId) ?? null,
    peers: state.peers.get(endpointId) ?? null,
    activePeerId: state.activeEndpointId === endpointId ? state.activePeerId : null,
  };
}

function restoreEndpointGate(state, endpointId, gate) {
  restoreMapEntry(state.operations, endpointId, gate.operation);
  restoreMapEntry(state.statuses, endpointId, gate.status);
  restoreMapEntry(state.peers, endpointId, gate.peers);
  if (state.activeEndpointId === endpointId) state.activePeerId = gate.activePeerId;
}

function restoreMapEntry(map, key, value) {
  if (value === null) map.delete(key);
  else map.set(key, value);
}

function beginStateInvalidation(state, coordinator, endpointId, options) {
  const gate = captureEndpointGate(state, endpointId);
  const transition = coordinator.beginInvalidation(endpointId, options);
  invalidateEndpointOperation(state, endpointId);
  return { endpointId, gate, transition };
}

function consumeInvalidationFailure(invalidation) {
  if (invalidation) void invalidation.transition.cancellation.catch(() => {});
}

async function acknowledgeInvalidations(state, invalidations) {
  const outcomes = await Promise.allSettled(
    invalidations.map(({ transition }) => transition.cancellation),
  );
  for (const invalidation of invalidations) {
    if (invalidation.transition.wasRolledBack()) {
      restoreEndpointGate(state, invalidation.endpointId, invalidation.gate);
    }
  }
  const failure = outcomes.find(({ status }) => status === 'rejected');
  if (failure) throw failure.reason;
}

function requireResultIdentity(actualId, expectedId, command) {
  if (actualId !== expectedId) {
    throw new EndpointIdentityMismatchError(
      `${command} returned endpoint id "${actualId}" instead of "${expectedId}"`,
    );
  }
}

function requireOpenSessionId(value) {
  if (!isPlainObject(value)) {
    throw new TypeError('transport.open must return an object with a session identity');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const field of ['sessionId', 'id']) {
    const descriptor = descriptors[field];
    if (descriptor && !('value' in descriptor)) {
      throw new TypeError(`transport.open ${field} must be a data property`);
    }
    if (isNonblankString(descriptor?.value)) return descriptor.value;
  }
  throw new TypeError('transport.open must return a nonblank sessionId or id');
}

function createSupersededOpenError(endpointId, operationId) {
  const error = new Error(`Open operation "${operationId}" was superseded for ${endpointId}`);
  error.name = 'OpenCancelledError';
  error.code = 'OPEN_CANCELLED';
  return error;
}

function invalidateEndpointOperation(state, endpointId) {
  state.operations.delete(endpointId);
  clearEndpointOperationState(state, endpointId);
}

function clearEndpointOperationState(state, endpointId) {
  state.statuses.delete(endpointId);
  state.peers.delete(endpointId);
  if (state.activeEndpointId === endpointId) state.activePeerId = null;
}

function clearOpeningIntents(state) {
  for (const [endpointId, operation] of state.operations) {
    if (operation.sessionId === null) invalidateEndpointOperation(state, endpointId);
  }
}

function pruneMap(map, allowedKeys) {
  for (const key of map.keys()) {
    if (!allowedKeys.has(key)) map.delete(key);
  }
}

function incrementEndpointCounters(state, endpointId, increment) {
  const counters = { ...(state.endpointCounters.get(endpointId) ?? emptyCounters()) };
  for (const key of Object.keys(counters)) counters[key] += increment[key] ?? 0;
  state.endpointCounters.set(endpointId, counters);
  updateAggregateCounters(state);
}

function updateAggregateCounters(state) {
  const total = emptyCounters();
  for (const counters of state.endpointCounters.values()) {
    for (const key of Object.keys(total)) total[key] += counters[key];
  }
  state.counters = total;
}

function countsForFrames(frames) {
  const counters = { received: 0, sent: 0, frames: frames.length };
  for (const frame of frames) counters[frame.direction === 'in' ? 'received' : 'sent'] += 1;
  return counters;
}

function endpointPredicate(filter) {
  if (filter === 'all') return () => true;
  if (filter === 'serial') return ({ transport }) => transport === 'serial';
  if (filter === 'modbus') {
    return ({ transport }) => [
      'modbus-tcp-master', 'modbus-tcp-slave', 'modbus-rtu-master', 'modbus-rtu-slave',
    ].includes(transport);
  }
  if (filter === 'dlt645') return ({ transport }) => transport.startsWith('dlt645-');
  return ({ transport }) => transport === `${filter}-client` || transport === `${filter}-server`;
}

function matchesActiveOperation(state, coordinator, event) {
  const active = state.operations.get(event.endpointId);
  if (active?.operationId !== event.operationId) return false;
  if (event.sessionId === null) {
    if (active.sessionId === null) {
      return coordinator.acceptsEvent(event.endpointId, event.operationId, null);
    }
    return event.status === 'closed';
  }
  return (active.sessionId === null || active.sessionId === event.sessionId)
    && coordinator.acceptsEvent(event.endpointId, event.operationId, event.sessionId);
}

function adoptSession(state, event) {
  const active = state.operations.get(event.endpointId);
  if (active.sessionId === null) {
    state.operations.set(event.endpointId, Object.freeze({
      ...active,
      sessionId: event.sessionId,
    }));
  }
}

function isReplacementOperation(previous, next) {
  if (!previous) return false;
  if (previous.operationId !== next.operationId) return true;
  return previous.sessionId !== null
    && next.sessionId !== null
    && previous.sessionId !== next.sessionId;
}

function normalizeError(error) {
  return error instanceof Error ? error : new Error(String(error));
}

function emptyCounters() {
  return { received: 0, sent: 0, frames: 0, logs: 0 };
}
