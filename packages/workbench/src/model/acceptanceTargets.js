import { normalizeAcceptancePlan } from './acceptancePlan.js';

// Captures contain only cloneable snapshots; live adapters stay in their owners.
export function createAcceptanceTargets({ model, getCatalog, runtime }) {
  function list() {
    const ordinary = model.state.endpoints.filter(
      (endpoint) =>
        ['modbus-tcp-master', 'modbus-rtu-master'].includes(
          endpoint.transport,
        ) &&
        model.state.operations.get(endpoint.id)?.sessionId &&
        ['open', 'connected'].includes(
          model.state.statuses.get(endpoint.id)?.status,
        ),
    );
    const catalog = getCatalog();
    const opcua = catalog.endpoints.filter((endpoint) => {
      const state = catalog.state.instances.get(endpoint.id)?.state;
      return (
        endpoint.transport === 'opcua-client' &&
        state?.status === 'connected' &&
        state.sessionId &&
        state.connectionId
      );
    });
    return [
      ...ordinary.map((endpoint) => metadata(endpoint, 'modbus')),
      ...opcua.map((endpoint) => metadata(endpoint, 'opcua')),
    ];
  }
  function metadata(endpoint, protocol) {
    return { endpointId: endpoint.id, name: endpoint.name, protocol };
  }
  function captureTarget(endpointId, protocol) {
    const entry = list().find(
      (row) => row.endpointId === endpointId && row.protocol === protocol,
    );
    if (!entry) throw new Error('请选择已连接的只读目标端点');
    if (protocol === 'modbus') {
      const endpoint = model.state.endpoints.find(
        (row) => row.id === endpointId,
      );
      const config = JSON.parse(JSON.stringify(endpoint.config));
      return {
        ...entry,
        identity:
          endpoint.transport === 'modbus-tcp-master'
            ? `${endpoint.transport} ${config.host}:${config.port}`
            : `${endpoint.transport} ${config.path}`,
        config,
        sessionId: model.state.operations.get(endpointId).sessionId,
      };
    }
    const state = getCatalog().state.instances.get(endpointId).state;
    const url = new URL(state.config.endpointUrl);
    url.username = '';
    url.password = '';
    return {
      ...entry,
      identity: `${url.protocol}//${url.host}`,
      sessionId: state.sessionId,
      connectionId: state.connectionId,
    };
  }
  function isCurrent(target) {
    if (
      !list().some(
        (row) =>
          row.endpointId === target.endpointId &&
          row.protocol === target.protocol,
      )
    )
      return false;
    if (target.protocol === 'modbus')
      return (
        model.state.operations.get(target.endpointId)?.sessionId ===
        target.sessionId
      );
    const state = getCatalog().state.instances.get(target.endpointId)?.state;
    return (
      state?.sessionId === target.sessionId &&
      state.connectionId === target.connectionId
    );
  }
  async function read(target, check) {
    // Validate at this boundary too: callers cannot smuggle write function codes.
    const validated = normalizeAcceptancePlan({
      id: 'read',
      name: 'Read',
      protocol: target.protocol,
      checks: [check],
    });
    const query = validated.checks[0].query;
    if (!isCurrent(target)) throw new Error('目标会话已变化，请重新执行检查');
    let response;
    try {
      response =
        target.protocol === 'modbus'
          ? await model.modbusMasterScheduler.executeImmediate({
              endpointId: target.endpointId,
              sessionId: target.sessionId,
              config: target.config,
              request: { ...query, values: [] },
            })
          : await runtime.opcua.execute({
              action: 'read',
              connectionId: target.connectionId,
              sessionId: target.sessionId,
              nodeIds: [query.nodeId],
            });
    } catch {
      // Native diagnostics can contain connection credentials. Reports use bounded safe messages.
      throw new Error('读取失败，请检查目标连接与查询参数');
    }
    if (!isCurrent(target)) throw new Error('目标会话已变化，请重新执行检查');
    if (target.protocol === 'modbus') {
      if (
        !response ||
        response.endpointId !== target.endpointId ||
        response.sessionId !== target.sessionId ||
        response.success !== true ||
        !Array.isArray(response.values) ||
        response.values.length !== query.quantity ||
        ['functionCode', 'unitId', 'address', 'quantity'].some(
          (key) => response[key] !== query[key],
        )
      ) {
        throw new Error('Modbus 读取结果与目标会话或查询不一致');
      }
      return {
        actual: response.values,
        quality: 'Good',
        evidence: {
          functionCode: response.functionCode,
          unitId: response.unitId,
          address: response.address,
          quantity: response.quantity,
        },
      };
    }
    const values = response?.values;
    const row = Array.isArray(values) && values.length === 1 ? values[0] : null;
    if (!row || row.nodeId !== query.nodeId || !Object.hasOwn(row, 'value')) {
      throw new Error('OPC UA 读取结果缺少目标节点或实际值');
    }
    const quality = /^Good(?: \(0x00000000\))?$/.test(row.statusCode)
      ? 'Good'
      : row.statusCode;
    return {
      actual: row.value,
      quality,
      evidence: {
        nodeId: row.nodeId,
        dataType: row.dataType ?? null,
        sourceTimestamp: row.sourceTimestamp ?? null,
        serverTimestamp: row.serverTimestamp ?? null,
      },
    };
  }
  return { list, captureTarget, isCurrent, read };
}
