/* global window, document */
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractDeviceTemplate } from '../../packages/workbench/src/model/deviceTemplates.js';
import { createAcceptanceModbusServer } from './modbusFixture.mjs';
import { runNativeAcceptance } from './nativeHost.mjs';

// Serialized into the real Electron renderer / Tauri WKWebView by nativeHost.
async function workload(config) {
  const pause = (ms) =>
    config.runtime === 'tauri'
      ? window.fetch(`/pause?ms=${ms}`).then((r) => r.text())
      : new Promise((resolve) => window.setTimeout(resolve, ms));
  const ensure = (value, message) => {
    if (!value) throw Error(message);
  };
  async function openWorkspaceTool(name) {
    document.querySelector('[aria-label="打开工具箱"]').click();
    const entry = await wait(() => document.querySelector(`[aria-label="打开${name}"]`), 'workspace tool');
    entry.click();
  }
  async function wait(check, label) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await pause(80);
    }
    throw Error(`${label}: ${document.body.innerText}`);
  }
  async function click(text, scope = document) {
    const button = await wait(
      () =>
        [...scope.querySelectorAll('button')].find(
          (b) =>
            b.textContent.trim() === text &&
            !b.disabled &&
            b.getClientRects().length,
        ),
      text,
    );
    button.click();
    await pause(40);
  }
  async function field(name, value) {
    const el = await wait(
      () => document.querySelector(`[name="${name}"]`),
      name,
    );
    el.value = String(value);
    el.dispatchEvent(
      new Event(el.tagName === 'SELECT' ? 'change' : 'input', {
        bubbles: true,
      }),
    );
    await pause(40);
  }
  async function persisted() {
    const result =
      config.runtime === 'electron'
        ? await window.ineedLinkLab.settings.getAll()
        : await window.__TAURI_INTERNALS__.invoke('settings_get_all', {
            args: [],
          });
    ensure(result.ok, 'Native settings failed');
    return JSON.parse(result.value.acceptanceWorkspace);
  }
  await wait(
    () => document.querySelector('[aria-label="打开工具箱"]'),
    'ready',
  );
  if (config.reloadOnly) {
    const doc = await persisted();
    ensure(
      doc.templates.length === 2 &&
        doc.reports.length === 3 &&
        doc.plans.length === 2,
      'Reload lost models/reports',
    );
    ensure(
      doc.reports[0].results[0].actual === 32.1 &&
        doc.reports[0].plan.checks[0].engineering.point.scale === 0.1,
      'Old report changed after revision',
    );
    await openWorkspaceTool('设备模板');
    await pause(40);
    const latest = doc.templates.at(-1);
    await field('model-version', `${latest.id}:${latest.version}`);
    return {
      passed: true,
      document: doc,
      checks: [
        'two new loopback instances',
        'fresh raw engineering decode',
        'readonly native reads',
        'failed range assertion',
        'immutable template revision/report',
        'SQLite and renderer reload',
      ],
    };
  }
  await openWorkspaceTool('设备模板');
  await pause(40);
  let panel = await wait(
    () => document.querySelector('.device-templates-panel'),
    'model panel',
  );
  panel.querySelector('[name="model-import"]').closest('details').open = true;
  await field('model-import', config.template);
  await click('预览导入', panel);
  await click('确认导入为新模板', panel);
  await wait(
    async () => (await persisted()).templates?.length === 1,
    'model saved',
  );
  for (const [index, name] of ['Native A', 'Native B'].entries()) {
    await field('model-site-name', name);
    await field('model-site-port', config.ports[index]);
    await field('model-site-unit', index + 1);
    await click('新建端点和验收方案', panel);
    await wait(
      () =>
        panel
          .querySelector('[role="status"]')
          ?.textContent.includes(`已新建端点 ${name}`),
      'new native endpoint',
    );
  }
  panel.querySelector('[aria-label="关闭设备模板"]').click();
  await pause(40);
  for (const name of ['Native A', 'Native B']) {
    const row = await wait(
      () =>
        document
          .querySelector(`[aria-label="选择 ${name}"]`)
          ?.closest('.endpoint-row'),
      'endpoint row',
    );
    row.querySelector('[aria-label="打开端点"]').click();
    await wait(
      () => row.querySelector('[aria-label="关闭端点"]'),
      'native connected',
    );
  }
  await openWorkspaceTool('验收检查');
  await pause(40);
  const acceptance = await wait(
    () => document.querySelector('[aria-labelledby="acceptance-title"]'),
    'acceptance panel',
  );
  const plans = await persisted();
  await field('acceptance-saved-plan', plans.plans[0].id);
  const target = acceptance.querySelector('[name="acceptance-target"]');
  const option = [...target.options].find((o) =>
    o.textContent.includes('Native A'),
  );
  ensure(option, 'Target absent');
  await field('acceptance-target', option.value);
  await click('执行检查', acceptance);
  let doc = await wait(async () => {
    const d = await persisted();
    return d.reports.length === 1 && d;
  }, 'passing report');
  ensure(
    doc.reports[0].status === 'passed' &&
      doc.reports[0].results[0].actual === 32.1 &&
      doc.reports[0].results[0].evidence.engineering.raw[0] === 321,
    'Engineering reading not native/fresh',
  );
  await field('acceptance-saved-plan', plans.plans[1].id);
  const secondOption = [...target.options].find((o) =>
    o.textContent.includes('Native B'),
  );
  await field('acceptance-target', secondOption.value);
  await click('执行检查', acceptance);
  doc = await wait(async () => {
    const d = await persisted();
    return d.reports.length === 2 && d;
  }, 'second site report');
  ensure(
    doc.reports[1].status === 'passed' &&
      doc.reports[1].results[0].actual === 32.1 &&
      doc.reports[1].results[0].evidence.transport.unitId === 2,
    'Second native device did not share interpretation',
  );
  await field('acceptance-maximum', 30);
  await click('执行检查', acceptance);
  doc = await wait(async () => {
    const d = await persisted();
    return d.reports.length === 3 && d;
  }, 'failed report');
  ensure(doc.reports[2].status === 'failed', 'Range mismatch passed');
  acceptance.querySelector('[aria-label="关闭验收检查"]').click();
  await pause(40);
  await openWorkspaceTool('设备模板');
  await pause(40);
  panel = await wait(
    () => document.querySelector('.device-templates-panel'),
    'reopened model panel',
  );
  const revised = JSON.parse(panel.querySelector('[name="model-json"]').value);
  revised.groups[0].requests[0].dataPoints[0].scale = 0.2;
  await field('model-json', JSON.stringify(revised));
  await click('保存新版本', panel);
  await wait(
    async () => (await persisted()).templates.length === 2,
    'revision saved',
  );
  return { stage: 'reload' };
}

const runtime = process.argv[2] ?? 'electron';
assert(['electron', 'tauri'].includes(runtime));
const out = await mkdtemp(path.join(tmpdir(), `linklab-models-${runtime}-`));
const server = await createAcceptanceModbusServer();
const secondServer = await createAcceptanceModbusServer();
try {
  const template = extractDeviceTemplate(
    {
      transport: 'modbus-tcp-master',
      config: {
        requestGroups: [
          {
            id: 'g',
            name: 'Read',
            unitId: 1,
            requests: [
              {
                id: 'r',
                name: 'Read temperature',
                functionCode: 3,
                startAddress: 0,
                quantity: 1,
                dataPoints: [
                  {
                    id: 'p',
                    key: 't',
                    name: 'Temperature',
                    dataType: 'uint16',
                    scale: 0.1,
                    unit: '℃',
                    minimum: 20,
                    maximum: 40,
                  },
                ],
              },
            ],
          },
        ],
      },
    },
    'Native model',
  );
  const result = await runNativeAcceptance({
    runtime,
    out,
    config: {
      ports: [server.port, secondServer.port],
      template: JSON.stringify(template),
    },
    workload,
  });
  assert.equal(result.passed, true, result.error);
  assert(server.requests.length >= 1);
  assert(secondServer.requests.length >= 1);
  assert(
    [...server.requests, ...secondServer.requests].every((r) =>
      [1, 2, 3, 4].includes(r.code),
    ),
  );
  const isolation = JSON.parse(
    await readFile(path.join(out, 'isolation.json'), 'utf8'),
  );
  const db = new DatabaseSync(
    path.join(isolation.dataPath, 'ineed-dev-tool.db'),
    { readOnly: true },
  );
  try {
    assert.deepEqual(
      JSON.parse(
        JSON.parse(
          db
            .prepare(
              "SELECT value FROM settings WHERE key='acceptanceWorkspace'",
            )
            .get().value,
        ),
      ),
      result.document,
    );
  } finally {
    db.close();
  }
  await writeFile(
    path.join(out, 'result.json'),
    JSON.stringify(
      {
        ...result,
        runtime,
        requests: [...server.requests, ...secondServer.requests],
        sqliteMatches: true,
      },
      null,
      2,
    ),
  );
  console.log(
    JSON.stringify({
      passed: true,
      runtime,
      out,
      requests: server.requests.length + secondServer.requests.length,
      checks: result.checks,
    }),
  );
} catch (error) {
  console.error(`Evidence: ${out}`);
  await writeFile(
    path.join(out, 'failure.json'),
    JSON.stringify({ message: error.message, stack: error.stack }, null, 2),
  );
  throw error;
} finally {
  await server.close();
  await secondServer.close();
}
