/* global window, document */
import assert from 'node:assert/strict';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { extractDeviceTemplate } from '../../packages/workbench/src/model/deviceTemplates.js';
import { normalizeAcceptanceDocument } from '../../packages/workbench/src/model/acceptanceWorkspace.js';
import { createAcceptanceModbusServer } from './modbusFixture.mjs';
import { runNativeAcceptance } from './nativeHost.mjs';

// Runs in the real native desktop renderer. No preview bridge is installed.
async function workload(config) {
  const pause = ms => config.runtime === 'tauri'
    ? window.fetch(`/pause?ms=${Math.min(ms, 1000)}`).then(r => r.text())
    : new Promise(resolve => window.setTimeout(resolve, ms));
  const ensure = (value, message) => { if (!value) throw Error(message); };
  const errors = [];
  window.addEventListener('error', event => errors.push(event.message));
  window.addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
  async function openWorkspaceTool(name) {
    document.querySelector('[aria-label="打开工具箱"]').click();
    const entry = await wait(() => document.querySelector(`[aria-label="打开${name}"]`), 'workspace tool');
    entry.click();
  }
  async function wait(check, label) {
    const deadline = performance.now() + 30000;
    do { const value = await check(); if (value) return value; await pause(50); }
    while (performance.now() < deadline);
    throw Error(`${label}: ${document.body.innerText}`);
  }
  async function click(text, scope = document) {
    const button = await wait(() => [...scope.querySelectorAll('button')].find(b => b.textContent.trim() === text && !b.disabled && b.getClientRects().length), text);
    button.click(); await pause(30);
  }
  async function field(name, value) {
    const input = await wait(() => document.querySelector(`[name="${name}"]`), name);
    input.value = String(value);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    await pause(30);
  }
  async function call(method, args = []) {
    const names = { 'settings.getAll': 'settings_get_all', 'transport.close': 'transport_close', 'transport.open': 'transport_open' };
    const [group, name] = method.split('.');
    const result = config.runtime === 'electron' ? await window.ineedLinkLab[group][name](...args)
      : await window.__TAURI_INTERNALS__.invoke(names[method], { args });
    ensure(result.ok, `${method}: ${JSON.stringify(result)}`); return result.value;
  }
  async function control(action, index) {
    return config.runtime === 'electron' ? window.__linklabAcceptanceControl({ action, index })
      : fetch('/control', { method: 'POST', body: JSON.stringify({ action, index }) }).then(r => r.json());
  }
  async function persisted() { return JSON.parse((await call('settings.getAll')).acceptanceWorkspace); }
  async function publish(progress) {
    const snapshot = { ...progress, ...(progress.counters ? { counters: { ...progress.counters } } : {}),
      currentTimeOrigin: performance.timeOrigin, documentNonce: window.__linklabTemplateDocumentNonce };
    window.__linklabTemplateProgress = snapshot;
    if (config.runtime === 'tauri') await fetch('/progress', { method: 'POST', body: JSON.stringify(snapshot) });
  }
  await wait(() => document.querySelector('[aria-label="打开工具箱"]'), 'application ready');
  if (config.reloadOnly) {
    const doc = await persisted();
    const saved = JSON.parse(sessionStorage.getItem('template-soak-final'));
    ensure(JSON.stringify(doc) === saved.documentJson, 'Reload altered persisted evidence');
    await openWorkspaceTool('设备模板'); await pause(80);
    ensure(document.querySelector('[name="model-version"]').options.length === 5, 'Template revisions absent after reload');
    return { passed: true, ...saved, document: doc, reloadMatched: true, rendererErrors: errors };
  }
  await openWorkspaceTool('设备模板'); await pause(60);
  let panel = document.querySelector('.device-templates-panel');
  for (let index = 0; index < 2; index++) {
    panel.querySelector('[name="model-import"]').closest('details').open = true;
    await field('model-import', config.templates[index]);
    await click('预览导入', panel); await click('确认导入为新模板', panel);
    await wait(async () => (await persisted()).templates.length === index + 1, 'model persisted');
    await field('model-site-name', `Soak ${index}`);
    await field('model-site-port', config.ports[index]); await field('model-site-unit', index + 1);
    await click('新建端点和验收方案', panel);
    await wait(() => panel.querySelector('[role="status"]')?.textContent.includes(`已新建端点 Soak ${index}`), 'instance created');
  }
  const initial = await persisted();
  // Save distinct v2 models while plans still reference immutable v1 snapshots.
  for (const template of initial.templates) {
    await field('model-version', `${template.id}:1`);
    const revision = JSON.parse(panel.querySelector('[name="model-json"]').value);
    revision.groups[0].requests[0].dataPoints[0].scale = 0.2;
    await field('model-json', JSON.stringify(revision)); await click('保存新版本', panel);
  }
  ensure((await persisted()).templates.length === 4, 'Revision append failed');
  if (config.runtime === 'electron') await click('导出模板', panel);
  panel.querySelector('[aria-label="关闭设备模板"]').click(); await pause(50);
  const endpointIds = [];
  for (let index = 0; index < 2; index++) {
    const row = await wait(() => document.querySelector(`[aria-label="选择 Soak ${index}"]`)?.closest('.endpoint-row'), 'endpoint row');
    row.querySelector('[aria-label="打开端点"]').click();
    await wait(() => row.querySelector('[aria-label="关闭端点"]'), 'connected');
  }
  await openWorkspaceTool('验收检查'); await pause(50);
  const acceptance = document.querySelector('[aria-labelledby="acceptance-title"]');
  const plans = (await persisted()).plans;
  for (let index = 0; index < 2; index++) endpointIds.push([...document.querySelector('[name="acceptance-target"]').options].find(o => o.textContent.includes(`Soak ${index}`)).value);
  const counters = { reports: 0, passed: 0, rangeFailure: 0, badQuality: 0, decodeBad: 0, stopped: 0, invalidated: 0, reconnects: 0, retentionChecks: 0 };
  const reportIds = [], sessions = [new Set(), new Set()];
  const started = performance.now(), pageIdentity = performance.timeOrigin;
  const documentNonce = crypto.randomUUID(), documentRoot = document.documentElement, performanceObject = window.performance;
  window.__linklabTemplateDocumentNonce = documentNonce;
  let iteration = 0, lastPublish = -1e9;
  async function execute(mode, index) {
    await field('acceptance-saved-plan', plans[index].id); await field('acceptance-target', endpointIds[index]);
    if (mode === 'range') await field('acceptance-maximum', '30');
    if (mode === 'bad') await field('acceptance-address', 999);
    if (mode === 'decode-bad') await field('acceptance-address', 1);
    if (mode === 'stop' || mode === 'disconnect') {
      await field('acceptance-address', 100); await field('acceptance-timeout', 3000);
    }
    const previous = new Set((await persisted()).reports.map(r => r.id));
    await click('执行检查', acceptance);
    if (mode === 'stop' || mode === 'disconnect') {
      await wait(async () => (await control('pending', index)) > 0, 'peer has held native read');
      if (mode === 'stop') await click('停止检查', acceptance);
      else await call('transport.close', [endpointIds[index]]);
      await control('release', index);
    }
    const report = await wait(async () => (await persisted()).reports.find(r => !previous.has(r.id)), 'new report');
    if (mode === 'stop') {
      ensure(report.status === 'stopped' && report.results[0].status !== 'passed', 'Stopped read passed'); counters.stopped++;
    } else if (mode === 'disconnect') {
      ensure(report.status === 'invalidated', `Old session not invalidated: ${JSON.stringify(report)}`); counters.invalidated++;
    } else if (mode === 'decode-bad') {
      ensure(report.status === 'failed' && report.results[0].quality !== 'Good' && report.results[0].evidence.engineering.raw[0] === 654, 'Out-of-bound engineering quality falsely passed'); counters.decodeBad++;
    } else if (mode === 'bad') {
      ensure(report.status === 'failed' && report.results[0].actual === null, 'Native bad quality falsely passed'); counters.badQuality++;
    } else {
      const expected = mode === 'range' ? 'failed' : 'passed';
      ensure(report.status === expected, `Unexpected ${mode} report: ${JSON.stringify(report)}`);
      ensure(report.results[0].actual === 32.1 && report.results[0].evidence.engineering.raw[0] === 321, 'Raw engineering interpretation changed');
      ensure(report.plan.checks[0].engineering.template.id === initial.templates[index].id && report.plan.checks[0].engineering.template.version === 1, 'Template evidence crossed models/revisions');
      ensure(report.results[0].evidence.transport.unitId === index + 1, 'Unit ID crossed instances');
      if (mode === 'range') counters.rangeFailure++; else counters.passed++;
    }
    sessions[index].add(report.target.sessionId);
    reportIds.push(report.id); counters.reports++;
    const current = await persisted();
    ensure(JSON.stringify(current.reports.map(r => r.id)) === JSON.stringify(reportIds.slice(-20)), 'Report retention order/limit broken');
    counters.retentionChecks++;
    if (mode === 'stop' || mode === 'disconnect') {
      await pause(650);
      ensure(JSON.stringify((await persisted()).reports.at(-1)) === JSON.stringify(report), 'Late native reply rewrote terminal evidence');
    }
    if (mode === 'disconnect' || iteration % 12 === 0) {
      const row = document.querySelector(`[aria-label="选择 Soak ${index}"]`).closest('.endpoint-row');
      if (mode !== 'disconnect') { row.querySelector('[aria-label="关闭端点"]').click(); }
      await wait(() => row.querySelector('[aria-label="打开端点"]'), 'closed before reconnect');
      row.querySelector('[aria-label="打开端点"]').click();
      await wait(() => row.querySelector('[aria-label="关闭端点"]'), 'reconnected'); counters.reconnects++;
    }
    await wait(() => !document.querySelector('[name="acceptance-saved-plan"]').disabled, 'runner released');
  }
  do {
    const index = iteration % 2;
    const mode = ['good', 'good', 'range', 'bad', 'decode-bad', 'stop', 'disconnect'][Math.floor(iteration / 2) % 7];
    await execute(mode, index); iteration++;
    if (performance.now() - lastPublish > 10000) {
      lastPublish = performance.now();
      await publish({ stage: 'load', monotonicElapsedMs: performance.now() - started, counters, iteration, visibility: document.visibilityState, pageIdentity, sessions: sessions.map(s => [...s]) });
    }
  } while (performance.now() - started < config.durationMs);
  const loadElapsedMs = performance.now() - started;
  // Keep the same desktop process and renderer alive throughout idle recovery.
  for (const id of endpointIds) await call('transport.close', [id]);
  const idleStarted = performance.now();
  while (performance.now() - idleStarted < config.idleMs) {
    await publish({ stage: 'idle', monotonicElapsedMs: performance.now() - started, idleElapsedMs: performance.now() - idleStarted, counters, pageIdentity, visibility: document.visibilityState });
    await pause(1000);
  }
  const idleElapsedMs = performance.now() - idleStarted;
  const timeOriginAtEnd = performance.timeOrigin;
  ensure(window.__linklabTemplateDocumentNonce === documentNonce && document.documentElement === documentRoot
    && window.performance === performanceObject, 'Document nonce, root or performance object changed during load/idle');
  ensure(errors.length === 0, `Renderer errors: ${errors}`);
  if (config.runtime === 'electron') {
    await click('导出 JSON', acceptance); await click('导出 Markdown', acceptance);
  }
  const doc = await persisted();
  const final = { loadElapsedMs, idleElapsedMs, counters, pageIdentity, timeOriginAtEnd,
    timeOriginDeltaMs: timeOriginAtEnd - pageIdentity, documentNonce, sameDocument: true, samePerformanceObject: true,
    sessions: sessions.map(s => [...s]), documentJson: JSON.stringify(doc), totalElapsedMs: performance.now() - started };
  sessionStorage.setItem('template-soak-final', JSON.stringify(final));
  await publish({ stage: 'pre-reload', ...final });
  return { stage: 'reload' };
}

const runtime = process.argv[2] ?? 'electron';
assert(['electron', 'tauri'].includes(runtime));
const durationMs = Number(process.env.LINKLAB_TEMPLATE_SOAK_MS ?? 1200000);
const idleMs = Number(process.env.LINKLAB_TEMPLATE_IDLE_MS ?? 180000);
const out = path.resolve(process.env.LINKLAB_TEMPLATE_OUT ?? `/tmp/linklab-template-soak-${runtime}-${Date.now()}`);
await mkdir(out, { recursive: true });
const servers = await Promise.all([createAcceptanceModbusServer({ holdSlowReads: true }), createAcceptanceModbusServer({ holdSlowReads: true })]);
let sampling = false;
const resources = setInterval(async () => {
  if (sampling) return; sampling = true;
  try {
    const host = JSON.parse(await readFile(path.join(out, 'host.json'), 'utf8'));
    const all = execFileSync('ps', ['-axo', 'pid=,ppid=,%cpu=,rss=,etime=,comm='], { encoding: 'utf8' }).trim().split('\n').map(line => {
      const match = line.trim().match(/^(\d+)\s+(\d+)\s+([\d.]+)\s+(\d+)\s+(\S+)\s+(.+)$/);
      return match && { pid: +match[1], ppid: +match[2], cpuPercent: +match[3], rssKiB: +match[4], elapsed: match[5], command: match[6] };
    }).filter(Boolean);
    const pids = new Set([host.pid]);
    for (let n = 0; n < all.length; n++) for (const p of all) if (pids.has(p.ppid)) pids.add(p.pid);
    const related = all.filter(p => pids.has(p.pid));
    const snapshot = { at: new Date().toISOString(), hostPid: host.pid, related, webkitSharedHostProcesses: all.filter(p => /WebKit/.test(p.command)), note: 'Concurrent multi-product host. XPC WebKit rows are shared-host observations, not attributed to this app.' };
    await appendFile(path.join(out, 'resources.jsonl'), JSON.stringify(snapshot) + '\n');
  } catch { /* Startup/teardown may not yet have a host. */ }
  finally { sampling = false; }
}, 10000);
try {
  const templates = [0, 1].map(index => extractDeviceTemplate({ transport: 'modbus-tcp-master', config: { requestGroups: [{ id: 'g', name: 'Read', unitId: 1, requests: [{ id: 'r', name: 'Temperature', functionCode: 3, startAddress: 0, quantity: 1, dataPoints: [{ id: 'p', key: 't', name: 'Temperature', dataType: 'uint16', scale: 0.1, unit: '℃', minimum: 20, maximum: 40 }] }] }] } }, `Soak Model ${index}`));
  const result = await runNativeAcceptance({ runtime, out, workload, control: ({ action, index }) => {
    assert(Number.isInteger(index) && index >= 0 && index < servers.length);
    if (action === 'pending') return servers[index].pendingSlowReads();
    assert.equal(action, 'release'); return servers[index].releaseSlowReads();
  }, timeoutMs: durationMs + idleMs + 300000, config: { durationMs, idleMs, ports: servers.map(s => s.port), templates: templates.map(t => JSON.stringify(t)) } });
  await writeFile(path.join(out, 'native-result.json'), JSON.stringify(result, null, 2));
  assert.equal(result.passed, true, result.error);
  assert(result.loadElapsedMs >= durationMs); assert(result.idleElapsedMs >= idleMs);
  const isolation = JSON.parse(await readFile(path.join(out, 'isolation.json'), 'utf8'));
  const db = new DatabaseSync(path.join(isolation.dataPath, 'ineed-dev-tool.db'), { readOnly: true });
  try {
    assert.equal(Object.values(db.prepare('PRAGMA quick_check').get())[0], 'ok');
    const doc = normalizeAcceptanceDocument(JSON.parse(db.prepare("SELECT value FROM settings WHERE key='acceptanceWorkspace'").get().value));
    assert.deepEqual(doc, result.document);
    assert.equal(doc.reports.length, Math.min(result.counters.reports, 20));
    assert(servers.every(s => s.requests.length > 0));
    assert(servers.every(s => s.requests.every(r => [1, 2, 3, 4].includes(r.code))));
    if (runtime === 'electron') {
      const exported = JSON.parse(await readFile(path.join(out, 'linklab-acceptance-report.json'), 'utf8'));
      assert.deepEqual(exported, doc.reports.at(-1));
      assert((await readFile(path.join(out, 'linklab-acceptance-report.md'), 'utf8')).includes(exported.id));
      assert.equal(JSON.parse(await readFile(path.join(out, 'linklab-device-template.json'), 'utf8')).version, 2);
    }
  } finally { db.close(); }
  await writeFile(path.join(out, 'result.json'), JSON.stringify({ ...result, sqliteMatches: true, sqliteQuickCheck: 'ok', requests: servers.map(s => s.requests.length), runtime, concurrentHost: true }, null, 2));
  console.log(JSON.stringify({ passed: true, runtime, out, counters: result.counters, loadElapsedMs: result.loadElapsedMs, idleElapsedMs: result.idleElapsedMs, requests: servers.map(s => s.requests.length) }));
} catch (error) {
  await writeFile(path.join(out, 'failure.json'), JSON.stringify({ message: error.message, stack: error.stack }, null, 2));
  console.error(`Evidence: ${out}`); throw error;
} finally { clearInterval(resources); await Promise.all(servers.map(s => s.close())); }
