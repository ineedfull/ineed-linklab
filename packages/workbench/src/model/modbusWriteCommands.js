const WRITE_FUNCTIONS = new Set([5, 6, 15, 16]);

export function normalizeModbusWriteCommands(commands) {
  if (!Array.isArray(commands)) return [];
  return commands
    .map(normalizeModbusWriteCommand)
    .sort((left, right) => left.order - right.order || left.id.localeCompare(right.id))
    .map((command, order) => ({ ...command, order }));
}

export function normalizeModbusWriteCommand(source, index = 0) {
  const command = plainRecord(source);
  const functionCode = configured(command, 'functionCode', 6);
  return {
    id: nonblank(command.id, `write-command-${index + 1}`),
    name: text(command.name),
    description: text(command.description),
    enabled: configured(command, 'enabled', true),
    order: integer(command.order, index),
    unitId: configured(command, 'unitId', 1),
    functionCode,
    address: configured(command, 'address', 0),
    values: Object.hasOwn(command, 'values')
      ? cloneConfiguredValues(command.values)
      : [],
  };
}

export function validateModbusWriteCommands(commands) {
  if (commands === undefined) return {};
  if (!Array.isArray(commands)) return { writeCommands: '写入指令配置格式无效。' };
  const errors = {};
  const ids = new Set();
  commands.forEach((source, index) => {
    const prefix = `writeCommand-${index}`;
    if (!isPlainObject(source)) {
      errors[`${prefix}-row`] = '写入指令配置格式无效。';
      return;
    }
    const command = normalizeModbusWriteCommand(source, index);
    if (!command.name) errors[`${prefix}-name`] = '请输入写入指令名称。';
    if (ids.has(command.id)) errors[`${prefix}-id`] = '写入指令标识必须唯一。';
    ids.add(command.id);
    if (Object.hasOwn(source, 'enabled') && typeof source.enabled !== 'boolean') {
      errors[`${prefix}-enabled`] = '写入指令启用状态必须为布尔值。';
    }
    if (!boundedInteger(source.unitId, 1, 247)) {
      errors[`${prefix}-unitId`] = '从站 ID 必须为 1 到 247 的整数。';
    }
    if (!WRITE_FUNCTIONS.has(source.functionCode)) {
      errors[`${prefix}-functionCode`] = '写入仅支持 FC05、FC06、FC15 或 FC16。';
    }
    if (!boundedInteger(source.address, 0, 65_535)) {
      errors[`${prefix}-address`] = '写入地址必须为 0 到 65535 的整数。';
    }
    validateValues(source.values, source.functionCode, source.address, prefix, errors);
  });
  return errors;
}

export function cloneModbusWriteCommand(command, createId = defaultId) {
  const source = normalizeModbusWriteCommand(command);
  return {
    ...source,
    id: createId('write-command', source.order),
    name: `${source.name}副本`,
    values: cloneConfiguredValues(source.values),
  };
}

export function buildModbusWriteRequest(command, endpointId) {
  return {
    endpointId,
    functionCode: command.functionCode,
    unitId: command.unitId,
    address: command.address,
    quantity: command.values.length,
    values: Array.from(command.values),
  };
}

function validateValues(values, functionCode, address, prefix, errors) {
  if (!Array.isArray(values)) {
    errors[`${prefix}-values`] = '写入值配置格式无效。';
    return;
  }
  if (functionCode === 5) {
    if (values.length !== 1 || typeof values[0] !== 'boolean') {
      errors[`${prefix}-values`] = 'FC05 必须写入一个布尔值。';
    }
  } else if (functionCode === 6) {
    if (values.length !== 1 || !boundedInteger(values[0], 0, 65_535)) {
      errors[`${prefix}-values`] = 'FC06 必须写入一个 0 到 65535 的整数。';
    }
  } else if (functionCode === 15) {
    if (values.length < 1 || values.length > 1968 || values.some((value) => typeof value !== 'boolean')) {
      errors[`${prefix}-values`] = 'FC15 必须写入 1 到 1968 个布尔值。';
    }
  } else if (functionCode === 16) {
    if (values.length < 1 || values.length > 123
      || values.some((value) => !boundedInteger(value, 0, 65_535))) {
      errors[`${prefix}-values`] = 'FC16 必须写入 1 到 123 个 0 到 65535 的整数。';
    }
  }
  if (boundedInteger(address, 0, 65_535) && values.length > 0
    && address + values.length > 65_536) {
    errors[`${prefix}-values`] = '写入范围不能超过地址 65535。';
  }
}

function plainRecord(value) {
  return isPlainObject(value) ? value : {};
}

function configured(source, key, fallback) {
  return Object.hasOwn(source, key) ? source[key] : fallback;
}

function cloneConfiguredValues(values) {
  return Array.isArray(values) ? [...values] : values;
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function nonblank(value, fallback) {
  return text(value) || fallback;
}

function integer(value, fallback) {
  const number = Number(value);
  return Number.isInteger(number) ? number : fallback;
}

function boundedInteger(value, minimum, maximum) {
  return Number.isInteger(value) && value >= minimum && value <= maximum;
}

function defaultId(kind, index) {
  return `${kind}-${Date.now()}-${index + 1}`;
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object') return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
