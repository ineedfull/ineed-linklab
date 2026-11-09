# Endpoint Serial Inputs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users create endpoints without typing a name, enter non-preset serial baud rates, and see precise parity and flow-control labels in both desktop shells.

**Architecture:** Keep validation and generated-name policy in `endpointDraft.js` as shared pure functions. Keep transient select/input state inside `EndpointDialog.vue`, pass existing names from `DevToolShell.vue`, and preserve the persisted endpoint shape so Electron and Tauri require no storage migration.

**Tech Stack:** Vue 3, Vitest, Node test runner, Electron, Tauri, Playwright

---

### Task 1: Shared baud-rate and endpoint-name rules

**Files:**
- Modify: `packages/workbench/src/model/endpointDraft.js`
- Test: `packages/workbench/tests/endpointDraft.test.js`

- [ ] **Step 1: Write failing custom baud-rate tests**

Import `MAX_SERIAL_BAUD_RATE`, replace the old `12345` rejection, and test the common Electron/Tauri boundary:

```js
test('serial accepts preset and custom positive integer baud rates', () => {
  assert.deepEqual(validateEndpointDraft({
    transport: 'serial', config: { path: 'COM3', baudRate: 12345 },
  }), {});
  for (const baudRate of [0, 1.5, MAX_SERIAL_BAUD_RATE + 1]) {
    assert.deepEqual(
      validateEndpointDraft({ transport: 'serial', config: { path: 'COM3', baudRate } }),
      { baudRate: `波特率必须为 1 到 ${MAX_SERIAL_BAUD_RATE} 的整数。` },
    );
  }
});
```

- [ ] **Step 2: Run the model test and verify it fails**

```bash
npm run test:components -w @ineed-dev-tool/workbench -- tests/endpointDraft.test.js
```

Expected: FAIL because `MAX_SERIAL_BAUD_RATE` is not exported and `12345` is rejected.

- [ ] **Step 3: Implement bounded custom baud-rate validation**

```js
export const MAX_SERIAL_BAUD_RATE = 0xffff_ffff;

function validateSerial(config, source) {
  const errors = {};
  if (!isNonblankString(config.path)) errors.path = '请选择或输入串口。';
  if (!isBoundedPositiveInteger(config.baudRate, MAX_SERIAL_BAUD_RATE)) {
    errors.baudRate = `波特率必须为 1 到 ${MAX_SERIAL_BAUD_RATE} 的整数。`;
  }
  if (!supportedDataBits.has(config.dataBits)) {
    errors.dataBits = '数据位必须为 5、6、7 或 8。';
  }
  if (!supportedParity.has(config.parity)) errors.parity = '请选择有效的校验位。';
  if (!supportedStopBits.has(config.stopBits)) {
    errors.stopBits = '停止位必须为 1、1.5 或 2。';
  }
  if (!supportedFlowControl.has(config.flowControl)) {
    errors.flowControl = '请选择有效的流控方式。';
  }
  Object.assign(errors, validateReceiveFraming(source));
  return errors;
}
```

Delete only the now-unused `supportedBaudRates` set. Keep `SUPPORTED_BAUD_RATES` as the UI preset list.

- [ ] **Step 4: Run the model test and verify the baud-rate case passes**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 5: Write failing generated-name tests**

```js
test.each([
  [{ transport: 'serial', config: { path: '/dev/ttyUSB0' } }, 'SERIAL_ttyUSB0'],
  [{ transport: 'serial', config: { path: 'COM3' } }, 'SERIAL_COM3'],
  [{ transport: 'tcp-client', config: { host: '192.168.1.10', port: 9000 } },
    'TCP_CLIENT_192.168.1.10_9000'],
  [{ transport: 'tcp-server', config: { listenPort: 9000 } }, 'TCP_SERVER_9000'],
  [{ transport: 'udp-client', config: { targetHost: '192.168.1.10', targetPort: 9000 } },
    'UDP_CLIENT_192.168.1.10_9000'],
  [{ transport: 'udp-server', config: { bindPort: 9000 } }, 'UDP_SERVER_9000'],
])('generates a stable endpoint name', (draft, expected) => {
  assert.equal(generateEndpointName(draft), expected);
});

test('generated names avoid case-insensitive collisions and stay within 80 characters', () => {
  assert.equal(generateEndpointName(
    { transport: 'tcp-server', config: { listenPort: 9000 } },
    ['tcp_server_9000', 'TCP_SERVER_9000_2'],
  ), 'TCP_SERVER_9000_3');
  assert.equal(generateEndpointName({
    transport: 'tcp-client',
    config: { host: `${'host'.repeat(30)}.example`, port: 65535 },
  }).length, 80);
});
```

- [ ] **Step 6: Run the model test and verify generated-name tests fail**

Run the Step 2 command. Expected: FAIL because `generateEndpointName` does not exist.

- [ ] **Step 7: Implement generated-name helpers**

```js
const MAX_ENDPOINT_NAME_LENGTH = 80;

export function generateEndpointName(draft, existingNames = []) {
  const config = isPlainObject(draft?.config) ? draft.config : {};
  const rawName = generatedNameParts(draft?.transport, config).join('_');
  const baseName = fitGeneratedName(normalizeGeneratedName(rawName) || 'ENDPOINT');
  const occupied = new Set(existingNames
    .filter(isNonblankString)
    .map((name) => name.trim().toLowerCase()));
  if (!occupied.has(baseName.toLowerCase())) return baseName;
  for (let index = 2; ; index += 1) {
    const suffix = `_${index}`;
    const candidate = fitGeneratedName(baseName, suffix);
    if (!occupied.has(candidate.toLowerCase())) return candidate;
  }
}

function generatedNameParts(transport, config) {
  switch (transport) {
    case 'serial': return ['SERIAL', serialPortBasename(config.path)];
    case 'tcp-client': return ['TCP', 'CLIENT', config.host, config.port];
    case 'tcp-server': return ['TCP', 'SERVER', config.listenPort];
    case 'udp-client': return ['UDP', 'CLIENT', config.targetHost, config.targetPort];
    case 'udp-server': return ['UDP', 'SERVER', config.bindPort];
    default: return ['ENDPOINT'];
  }
}

function serialPortBasename(path) {
  return String(path ?? '').split(/[\\/]/).filter(Boolean).at(-1) ?? '';
}

function normalizeGeneratedName(value) {
  return String(value).trim()
    .replace(/[^A-Za-z0-9._-]+/g, '_')
    .replace(/_+/g, '_')
    .replace(/^[_-]+|[_-]+$/g, '');
}

function fitGeneratedName(baseName, suffix = '') {
  return `${baseName.slice(0, MAX_ENDPOINT_NAME_LENGTH - suffix.length)}${suffix}`;
}
```

- [ ] **Step 8: Run the model test and verify all cases pass**

Run the Step 2 command. Expected: PASS.

- [ ] **Step 9: Commit shared rules**

```bash
git add packages/workbench/src/model/endpointDraft.js packages/workbench/tests/endpointDraft.test.js
git commit -m "feat: add endpoint naming and custom baud rules"
```

### Task 2: Endpoint dialog behavior and precise labels

**Files:**
- Modify: `packages/workbench/src/components/EndpointDialog.vue`
- Modify: `packages/workbench/src/layouts/DevToolShell.vue`
- Test: `packages/workbench/tests/components/EndpointDialog.test.js`
- Test: `packages/workbench/tests/components/LocalizationAbout.test.js`

- [ ] **Step 1: Write failing auto-name dialog tests**

```js
test('new endpoints hide the name field and save a collision-free generated name', async () => {
  const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
  mountDialog({ endpoint: null, existingNames: ['TCP_SERVER_9000'], saveCommand });
  await nextTick();
  expect(document.querySelector('input[name="endpoint-name"]')).toBeNull();
  await setValue('select[name="endpoint-transport"]', 'tcp-server');
  await submitDialog();
  expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
    name: 'TCP_SERVER_9000_2', transport: 'tcp-server',
  }));
});

test('editing keeps the manually edited name', async () => {
  const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
  mountDialog({ endpoint: tcpEndpoint('endpoint-a'), saveCommand });
  await nextTick();
  await setValue('input[name="endpoint-name"]', '业务服务');
  await submitDialog();
  expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({ name: '业务服务' }));
});
```

- [ ] **Step 2: Run the dialog test and verify it fails**

```bash
npm run test:components -w @ineed-dev-tool/workbench -- tests/components/EndpointDialog.test.js
```

Expected: FAIL because new endpoints still require a name and `existingNames` is unused.

- [ ] **Step 3: Implement automatic naming and new-dialog focus**

Import `generateEndpointName`; add `existingNames: { type: Array, default: () => [] }` to the props. Replace the current `draft` construction and name error assignment with:

```js
const draft = {
  id,
  name: props.endpoint
    ? form.name.trim()
    : generateEndpointName({ transport: form.transport, config }, props.existingNames),
  transport: form.transport,
  config,
};
Object.assign(fieldErrors, validateEndpointDraft(draft));
if (props.endpoint && !draft.name) fieldErrors.name = '请输入端点名称。';

function focusFirstControl() {
  dialogRef.value?.querySelector(
    props.endpoint ? '[name="endpoint-name"]' : '[name="endpoint-transport"]',
  )?.focus();
}
```

Render the name field with `v-if="endpoint"`, and add `name="endpoint-transport"` to the transport select. In `DevToolShell.vue` pass the current names:

```js
const existingEndpointNames = computed(() => state.value.endpoints.map(({ name }) => name));
```

```vue
<EndpointDialog :existing-names="existingEndpointNames" />
```

Add `:existing-names="existingEndpointNames"` to the current `EndpointDialog` invocation without replacing its other attributes.

- [ ] **Step 4: Run the dialog test and verify auto-name tests pass**

Run the Step 2 command. Expected: PASS for the new auto-name and edit-name cases.

- [ ] **Step 5: Write failing custom-baud and label tests**

```js
test('saves and reopens a custom baud rate without changing persisted shape', async () => {
  const saveCommand = vi.fn(async () => ({ ok: true, value: null }));
  const wrapper = mountDialog({ endpoint: serialEndpoint('/dev/ttyUSB0'), saveCommand });
  await nextTick();
  await setValue('select[name="serial-baud-rate-choice"]', '__custom__');
  await setValue('input[name="serial-custom-baud-rate"]', '12345');
  await submitDialog();
  expect(saveCommand).toHaveBeenCalledWith(expect.objectContaining({
    config: expect.objectContaining({ baudRate: 12345 }),
  }));
  wrapper.unmount();
  mountDialog({ endpoint: serialEndpoint('/dev/ttyUSB0', undefined, 12345) });
  await nextTick();
  expect(document.querySelector('select[name="serial-baud-rate-choice"]').value)
    .toBe('__custom__');
  expect(document.querySelector('input[name="serial-custom-baud-rate"]').value)
    .toBe('12345');
});

test('uses precise parity and flow-control labels', async () => {
  mountDialog({ endpoint: serialEndpoint('/dev/ttyUSB0') });
  await nextTick();
  expect(document.querySelector('select[name="serial-parity"]').textContent)
    .toContain('固定 1（Mark）');
  expect(document.querySelector('select[name="serial-parity"]').textContent)
    .toContain('固定 0（Space）');
  expect(document.querySelector('select[name="serial-flow-control"]').textContent)
    .toContain('硬件（RTS/CTS）');
  expect(document.querySelector('select[name="serial-flow-control"]').textContent)
    .toContain('软件（XON/XOFF）');
});
```

Extend `serialEndpoint(path, receiveFraming, baudRate = 9600)` so the test can reopen a non-preset value.

- [ ] **Step 6: Run the dialog tests and verify the new cases fail**

Run the Step 2 command. Expected: FAIL because custom baud state and precise labels do not exist.

- [ ] **Step 7: Implement custom baud state and controls**

Add `baudRateChoice: 115200` and `customBaudRate: ''` to `emptyForm()`. Add this helper:

```js
function baudRateFormState(baudRate) {
  return SUPPORTED_BAUD_RATES.includes(baudRate)
    ? { baudRateChoice: baudRate, customBaudRate: '' }
    : { baudRateChoice: '__custom__', customBaudRate: baudRate };
}
```

Inside the existing endpoint object passed to `Object.assign`, remove `baudRate: serial.baudRate` and add `...baudRateFormState(serial.baudRate)` after `customPath: serial.path`.

Persist only the number:

```js
baudRate: Number(
  form.baudRateChoice === '__custom__' ? form.customBaudRate : form.baudRateChoice,
),
```

Replace the baud select with a named preset select plus conditional numeric input:

```vue
<select v-model="form.baudRateChoice" name="serial-baud-rate-choice" required>
  <option v-for="rate in SUPPORTED_BAUD_RATES" :key="rate" :value="rate">
    {{ rate }}
  </option>
  <option value="__custom__">自定义...</option>
</select>
<input
  v-if="form.baudRateChoice === '__custom__'"
  v-model.number="form.customBaudRate"
  name="serial-custom-baud-rate"
  type="number"
  min="1"
  :max="MAX_SERIAL_BAUD_RATE"
  step="1"
  required
  placeholder="输入自定义波特率"
  :aria-invalid="Boolean(fieldErrors.baudRate)"
>
```

Import `MAX_SERIAL_BAUD_RATE`. Change parity labels to `无（None）`, `偶校验（Even）`, `奇校验（Odd）`, `固定 1（Mark）`, `固定 0（Space）`; change flow labels to `无（None）`, `硬件（RTS/CTS）`, `软件（XON/XOFF）`. Do not change option values.

- [ ] **Step 8: Update localization expectations and run component tests**

Add the new visible terms to `LocalizationAbout.test.js`, then run:

```bash
npm run test:components -w @ineed-dev-tool/workbench
```

Expected: all workbench Vitest tests PASS.

- [ ] **Step 9: Commit dialog behavior**

```bash
git add packages/workbench/src/components/EndpointDialog.vue packages/workbench/src/layouts/DevToolShell.vue packages/workbench/tests/components/EndpointDialog.test.js packages/workbench/tests/components/LocalizationAbout.test.js
git commit -m "feat: streamline endpoint serial inputs"
```

### Task 3: Cross-shell regression and visual verification

**Files:**
- Modify only if verification exposes a defect in files changed by Tasks 1 or 2.

- [ ] **Step 1: Run the complete JavaScript and component suite**

```bash
npm test
```

Expected: all Node and Vitest tests PASS.

- [ ] **Step 2: Run lint and both renderer builds**

```bash
npm run lint
npm run build
```

Expected: ESLint exits with code 0; Electron and Tauri renderer builds complete.

- [ ] **Step 3: Run shared Electron/Tauri browser tests**

```bash
npm run test:e2e
```

Expected: all Electron and Tauri Playwright projects PASS.

- [ ] **Step 4: Verify desktop and narrow dialog layouts**

Start `npm run dev:electron`, open a new serial endpoint, select `自定义...`, and inspect at `1440x900` and `820x1180`. Confirm the custom input stays inside the form, no labels overlap, new endpoints omit the name field, edited endpoints retain it, and all parity/flow-control labels fit.

- [ ] **Step 5: Check repository state**

```bash
git status --short
git diff --check
```

Expected: no uncommitted implementation changes and no whitespace errors.
