/* global window, document */

// Kept self-contained because nativeHost serializes this function into WKWebView.
export async function acceptanceDesktopWorkload(config) {
  // WKWebView can suspend renderer timers in an occluded desktop session.
  // Keep native timing controlled by the isolated harness, without changing reads.
  const pause = ms => config.runtime === 'tauri'
    ? window.fetch(`/pause?ms=${ms}`).then(response => response.text())
    : new Promise(resolve => window.setTimeout(resolve, ms));
  const ensure = (condition, message) => { if (!condition) throw new Error(message); };
  async function openWorkspaceTool(name) {
    document.querySelector('[aria-label="打开工具箱"]').click();
    const entry = await wait(() => document.querySelector(`[aria-label="打开${name}"]`), 'workspace tool');
    entry.click();
  }
  async function wait(check, label) {
    if (config.runtime === 'tauri') await window.fetch('/progress', {
      method: 'POST', body: JSON.stringify({ label, at: Date.now(), visibility: document.visibilityState,
        plan: document.querySelector('[name="acceptance-plan-name"]')?.value,
        check: document.querySelector('[name="acceptance-check-name"]')?.value }),
    }).then(response => response.text());
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const result = await check();
      if (result) return result;
      await pause(100);
    }
    throw new Error(`${label}: ${document.body.innerText}`);
  }
  async function click(text, scope = document) {
    const button = await wait(() => [...scope.querySelectorAll('button')].find(item =>
      item.textContent.trim() === text && !item.disabled && item.getClientRects().length), text);
    button.click(); await pause(30);
  }
  async function field(name, value, scope = document) {
    const input = await wait(() => scope.querySelector(`[name="${name}"]`), name);
    input.value = String(value);
    input.dispatchEvent(new Event(input.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
    await pause(30);
  }
  async function persisted() {
    const result = config.runtime === 'electron'
      ? await window.ineedLinkLab.settings.getAll()
      : await window.__TAURI_INTERNALS__.invoke('settings_get_all', { args: [] });
    ensure(result.ok, JSON.stringify(result.error));
    return JSON.parse(result.value.acceptanceWorkspace);
  }
  async function latestAfter(action) {
    const previous = new Set((await persisted()).reports.map(report => report.id));
    await action();
    return wait(async () => (await persisted()).reports.find(report => !previous.has(report.id)), 'new persisted report');
  }
  await wait(() => document.querySelector('[aria-label="打开工具箱"]'), 'application ready');
  if (config.runtime === 'tauri' && !config.reloadOnly) {
    let fired = false;
    const startedAt = Date.now();
    window.setTimeout(() => { fired = true; }, 100);
    await pause(250);
    const sample = { rendererTimerFired: fired, hostPauseElapsedMs: Date.now() - startedAt };
    window.sessionStorage.setItem('acceptance-timer-sample', JSON.stringify(sample));
    await window.fetch('/progress', { method: 'POST', body: JSON.stringify({ label: 'timer sentinel', ...sample }) })
      .then(response => response.text());
  }

  if (config.reloadOnly) {
    await openWorkspaceTool('验收检查');
    await wait(() => [...(document.querySelector('[name="acceptance-saved-plan"]')?.options ?? [])]
      .some(option => option.textContent.includes('Modbus 原生验收')), 'reloaded plans visible');
    const documentState = await persisted();
    ensure(documentState.plans.length === 3, 'Plan count changed across renderer reload');
    ensure(documentState.reports.length >= 5, 'Reports missing after renderer reload');
    ensure(documentState.reports.some(report => report.status === 'stopped'), 'Stopped report not retained');
    return { passed: true, runtime: config.runtime, document: documentState,
      timerDiagnostics: config.runtime === 'tauri'
        ? JSON.parse(window.sessionStorage.getItem('acceptance-timer-sample')) : null,
      checks: ['actual native Modbus/OPC UA', 'read success and mismatch', 'immutable report snapshot', 'OPC UA Int64/UInt64 precision', 'unknown node fails', 'stop suppresses late result', 'native SQLite persistence', 'renderer reload'],
    };
  }

  async function addEndpoint(name, transport, values) {
    document.querySelector('[aria-label="添加端点"]').click();
    const dialog = await wait(() => document.querySelector('.endpoint-dialog'), 'endpoint dialog');
    await field('endpoint-transport', transport, dialog);
    await field('endpoint-name', name, dialog);
    for (const [key, value] of Object.entries(values)) await field(key, value, dialog);
    await click('保存端点', dialog);
    await wait(() => !document.querySelector('.endpoint-dialog'), 'endpoint saved');
  }
  await addEndpoint('验收 Modbus 连接', 'modbus-tcp-master', { 'modbus-host': '127.0.0.1', 'modbus-port': config.modbusPort });
  const modbusRow = document.querySelector('[aria-label="选择 验收 Modbus 连接"]').closest('.endpoint-row');
  modbusRow.querySelector('[aria-label="打开端点"]').click();
  await wait(() => modbusRow.querySelector('[aria-label="关闭端点"]'), 'Modbus native connection');
  await addEndpoint('验收 OPC UA 连接', 'opcua-client', { 'opcua-endpoint-url': config.endpointUrl });
  const opcua = await wait(() => [...document.querySelectorAll('.opcua-panel')].find(panel => panel.getClientRects().length), 'OPC UA panel');
  await click('连接', opcua);
  await wait(() => opcua.querySelector('.opcua-status')?.textContent === '已连接', 'OPC UA native connection');

  await openWorkspaceTool('验收检查');
  const panel = await wait(() => document.querySelector('[role="dialog"][aria-labelledby="acceptance-title"]'), 'acceptance panel');
  async function chooseTarget(text) {
    const target = await wait(() => panel.querySelector('[name="acceptance-target"]'), 'target selector');
    // Labels may be shortened by a protocol's existing profile presentation.
    // The isolated workspace has one connection per protocol; resolve its ID.
    const option = await wait(() => [...target.options].find(item => item.textContent.includes(text)), 'connected target');
    await field('acceptance-target', option.value, panel);
  }
  async function newPlan(name, protocol, target) {
    await click('新建方案', panel);
    await field('acceptance-plan-name', name, panel);
    await field('acceptance-protocol', protocol, panel);
    await chooseTarget(target);
  }
  async function run() { return latestAfter(() => click('执行检查', panel)); }
  await newPlan('Modbus 原生验收', 'modbus', '验收 Modbus 连接');
  await field('acceptance-check-name', '保持寄存器一致', panel);
  await field('acceptance-expected', '[321]', panel);
  await click('保存方案', panel);
  let report = await run();
  ensure(report.status === 'passed' && report.results[0].actual[0] === 321, 'Modbus expected pass missing');
  const passingId = report.id;
  await field('acceptance-expected', '[999]', panel);
  report = await run();
  ensure(report.status === 'failed' && report.results[0].actual[0] === 321, 'Modbus mismatch falsely passed');
  const original = (await persisted()).reports.find(item => item.id === passingId);
  ensure(original.status === 'passed' && original.plan.checks[0].assertion.expected[0] === 321,
    'Draft edit changed the original report snapshot');

  await newPlan('OPC UA 原生验收', 'opcua', '验收 OPC UA');
  await field('acceptance-check-name', '温度一致', panel);
  await field('acceptance-node-id', config.nodes.Temperature, panel);
  await field('acceptance-expected', '23.5', panel);
  await click('添加检查', panel);
  await field('acceptance-check-name', 'UInt64 精度', panel);
  await field('acceptance-node-id', config.nodes.UnsignedWide, panel);
  await field('acceptance-expected', '"18446744073709551615"', panel);
  await click('添加检查', panel);
  await field('acceptance-check-name', 'Int64 精度', panel);
  await field('acceptance-node-id', config.nodes.Wide, panel);
  await field('acceptance-expected', '"9223372036854775807"', panel);
  await click('保存方案', panel);
  report = await run();
  ensure(report.status === 'passed', `OPC UA native values did not pass: ${JSON.stringify(report)}`);
  ensure(report.results[1].actual === '18446744073709551615', 'OPC UA integer precision lost');
  ensure(report.results[2].actual === '9223372036854775807', 'OPC UA signed integer precision lost');
  await field('acceptance-node-id', 'ns=2;s=MissingAcceptanceNode', panel);
  report = await run();
  ensure(report.status === 'failed' && report.results[2].status === 'failed', 'Unknown OPC UA node falsely passed');

  await newPlan('停止中的原生验收', 'modbus', '验收 Modbus 连接');
  await field('acceptance-address', '100', panel);
  await field('acceptance-expected', '[321]', panel);
  await click('添加检查', panel);
  await field('acceptance-address', '100', panel);
  await field('acceptance-expected', '[321]', panel);
  await click('保存方案', panel);
  report = await latestAfter(async () => {
    await click('执行检查', panel); await pause(100); await click('停止检查', panel);
  });
  ensure(report.status === 'stopped' && report.results[0].status === 'failed'
    && report.results[1].status === 'not-run', 'Canceled native read falsely passed');
  await pause(700);
  const stopped = (await persisted()).reports.find(item => item.id === report.id);
  ensure(stopped.status === 'stopped' && stopped.results[0].status === 'failed'
    && stopped.results[1].status === 'not-run', 'Late native response replaced cancellation');
  if (config.runtime === 'electron') {
    await click('导出 JSON', panel); await pause(100);
    await click('导出 Markdown', panel); await pause(100);
  }
  return { stage: 'reload' };
}
