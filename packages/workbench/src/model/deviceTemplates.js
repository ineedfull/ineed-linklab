import { sameJson } from './engineeringAcceptance.js';
import {
  acceptanceId,
  boundedText,
  jsonClone,
  normalizeAcceptancePlan,
  requireShape,
} from './acceptancePlan.js';
import {
  normalizeModbusMasterConfig,
  validateModbusRequestGroups,
} from './modbusMasterConfig.js';
import { validateEndpointDraft } from './endpointDraft.js';

export const DEVICE_TEMPLATE_LIMITS = Object.freeze({
  revisions: 50,
  bytes: 256 * 1024,
});
const pick = (source, keys) =>
  Object.fromEntries(keys.map((key) => [key, source[key]]));
const groupFields = ['id', 'name', 'description', 'enabled', 'order', 'unitId'];
const requestFields = [
  'id',
  'name',
  'enabled',
  'order',
  'functionCode',
  'startAddress',
  'quantity',
  'intervalMs',
  'timeoutMs',
  'retryCount',
  'retryIntervalMs',
];
function safeGroups(groups) {
  return groups.map((group) => ({
    ...pick(group, groupFields),
    unitId: 1,
    requests: group.requests.map((request) => ({
      ...pick(request, requestFields),
      dataPoints: request.dataPoints,
    })),
  }));
}
export function extractDeviceTemplate(endpoint, model) {
  if (!['modbus-tcp-master', 'modbus-rtu-master'].includes(endpoint?.transport))
    throw new TypeError('请选择 Modbus 主站');
  const groups = safeGroups(
    normalizeModbusMasterConfig(endpoint.config).requestGroups,
  );
  const conditions = [];
  for (const group of groups)
    for (const request of group.requests)
      for (const point of request.dataPoints) {
        if (
          group.enabled &&
          request.enabled &&
          point.enabled &&
          !['boolean', 'string'].includes(point.dataType) &&
          point.minimum !== null &&
          point.maximum !== null
        )
          conditions.push({
            groupId: group.id,
            requestId: request.id,
            pointId: point.id,
            assertion: {
              kind: 'range',
              minimum: point.minimum,
              maximum: point.maximum,
            },
          });
      }
  return normalizeDeviceTemplate({
    id: acceptanceId(),
    model,
    version: 1,
    groups,
    conditions,
  });
}
export function normalizeDeviceTemplate(input) {
  const template = jsonClone(input, DEVICE_TEMPLATE_LIMITS.bytes);
  requireShape(
    template,
    ['id', 'model', 'version', 'groups', 'conditions'],
    'device template',
  );
  boundedText(template.id, 'template id', 80);
  boundedText(template.model, 'model');
  if (!Number.isSafeInteger(template.version) || template.version < 1)
    throw new TypeError('Invalid template version');
  if (
    !Array.isArray(template.groups) ||
    !template.groups.length ||
    template.groups.length > 50
  )
    throw new TypeError('模板需要 1 到 50 个请求组');
  const normalized = safeGroups(
    normalizeModbusMasterConfig({ requestGroups: template.groups })
      .requestGroups,
  );
  if (
    !sameJson(normalized, template.groups) ||
    Object.keys(validateModbusRequestGroups(template.groups)).length
  )
    throw new TypeError('模板请求或点位配置无效，或含未知字段');
  if (!Array.isArray(template.conditions) || template.conditions.length > 25)
    throw new TypeError('模板最多 25 个验收条件');
  for (const condition of template.conditions) {
    requireShape(
      condition,
      ['groupId', 'requestId', 'pointId', 'assertion'],
      'template condition',
    );
    const { group, request, point } = resolve(template, condition);
    if (!group?.enabled || !request?.enabled || !point?.enabled)
      throw new TypeError('验收条件必须引用启用的点位');
  }
  template.groups = normalized;
  if (template.conditions.length)
    normalizeAcceptancePlan(buildPlan(template, 1));
  return template;
}
function resolve(template, condition) {
  const group = template.groups.find((g) => g.id === condition.groupId);
  const request = group?.requests.find((r) => r.id === condition.requestId);
  return {
    group,
    request,
    point: request?.dataPoints.find((p) => p.id === condition.pointId),
  };
}
function buildPlan(template, unitId) {
  return {
    id: acceptanceId(),
    name: `${template.model} v${template.version}`.slice(0, 100),
    protocol: 'modbus',
    checks: template.conditions.map((condition, index) => {
      const { request, point } = resolve(template, condition);
      return {
        id: `check-${index + 1}`,
        name: point.name,
        query: {
          unitId,
          functionCode: request.functionCode,
          address: request.startAddress,
          quantity: request.quantity,
          timeoutMs: Math.max(100, Math.min(30000, request.timeoutMs ?? 1000)),
        },
        assertion: condition.assertion,
        engineering: {
          point,
          template: pick(template, ['id', 'model', 'version']),
        },
      };
    }),
  };
}
export function deviceTemplatePlan(input, unitId) {
  const template = normalizeDeviceTemplate(input);
  if (!template.conditions.length)
    throw new TypeError('请先为模板添加验收条件');
  return normalizeAcceptancePlan(buildPlan(template, unitId));
}
export function instantiateDeviceTemplate(input, site) {
  const template = normalizeDeviceTemplate(input);
  boundedText(site.name, 'endpoint name', 80);
  if (
    !['modbus-tcp-master', 'modbus-rtu-master'].includes(site.transport) ||
    !Number.isInteger(site.unitId) ||
    site.unitId < 1 ||
    site.unitId > 247
  )
    throw new TypeError('现场传输类型或从站号无效');
  const connection =
    site.transport === 'modbus-tcp-master'
      ? { host: site.host, port: site.port }
      : {
          path: site.path,
          baudRate: site.baudRate,
          parity: site.parity ?? 'none',
          dataBits: 8,
          stopBits: 1,
          flowControl: 'none',
        };
  const config = normalizeModbusMasterConfig({
    ...connection,
    unitId: site.unitId,
    scheduler: { autoStart: false },
    requestGroups: template.groups.map((g) => ({ ...g, unitId: site.unitId })),
  });
  const result = {
    id: acceptanceId(),
    name: site.name,
    transport: site.transport,
    config,
  };
  const errors = validateEndpointDraft(result);
  if (Object.keys(errors).length)
    throw new TypeError(Object.values(errors).join(' '));
  return result;
}
