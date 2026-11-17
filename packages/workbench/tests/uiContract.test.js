import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { compileScript, compileTemplate, parse } from '@vue/compiler-sfc';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourceRoot = path.join(packageRoot, 'src');
const componentFiles = [
  'App.vue',
  'layouts/LinkLabShell.vue',
  'layouts/HistoryWindow.vue',
  'components/EndpointTree.vue',
  'components/EndpointRow.vue',
  'components/SessionStatusBar.vue',
  'components/FrameToolbar.vue',
  'components/FrameList.vue',
  'components/LogList.vue',
  'components/SendPanel.vue',
  'components/EndpointDialog.vue',
  'components/endpoint-fields/ProtocolEndpointFields.vue',
  'components/endpoint-fields/WebSocketEndpointFields.vue',
  'components/endpoint-fields/SerialEndpointFields.vue',
  'components/endpoint-fields/NetworkEndpointFields.vue',
  'components/endpoint-fields/ModbusEndpointFields.vue',
  'components/endpoint-fields/TcpResilienceFields.vue',
  'components/modbus-master/MasterConnectionSummary.vue',
  'components/modbus-master/MasterLiveReadings.vue',
  'components/modbus-master/MasterTransactionDiagnostics.vue',
  'components/SettingsPanel.vue',
  'components/StoragePanel.vue',
  'components/WorkspaceActions.vue',
  'components/AboutPanel.vue',
  'components/PayloadEditor.vue',
];

test('all shared workbench SFCs parse and compile', async () => {
  for (const relativePath of componentFiles) {
    const filename = path.join(sourceRoot, relativePath);
    const source = await readFile(filename, 'utf8');
    const { descriptor, errors } = parse(source, { filename });
    assert.deepEqual(errors, [], relativePath);
    assert.ok(descriptor.template, `${relativePath} must have a template`);

    const script = descriptor.scriptSetup
      ? compileScript(descriptor, { id: relativePath })
      : null;
    const template = compileTemplate({
      id: relativePath,
      filename,
      source: descriptor.template.content,
      compilerOptions: { bindingMetadata: script?.bindings ?? {} },
    });
    assert.deepEqual(template.errors, [], relativePath);
  }
});

test('App consumes the injected runtime through the Task 3 workbench model', async () => {
  const app = await source('App.vue');

  assert.match(app, /import ['"]\.\/styles\/workbench\.css['"]/);
  assert.match(app, /useRuntimeAdapter\s*\(\s*\)/);
  assert.match(app, /createWorkbenchModel\s*\(\s*runtimeAdapter/);
  assert.match(app, /model\.subscribe\s*\(/);
  assert.match(app, /unsubscribeModel\s*\(\s*\)/);
  assert.doesNotMatch(app, /setInterval|clearInterval/);
  assert.match(app, /<LinkLabShell/);
  assert.match(app, /:save-command="saveEndpoint"/);
  assert.match(app, /:send-command="sendEndpoint"/);
  assert.doesNotMatch(app, /window\.__TAURI__|ipcRenderer|localStorage|sessionStorage/);
});

test('shared shell has a collapsible 255px endpoint tree with stable collapsed titles', async () => {
  const shell = await source('layouts/LinkLabShell.vue');
  const tree = await source('components/EndpointTree.vue');
  const css = await source('styles/workbench.css');

  assert.match(shell, /tree-collapsed/);
  assert.match(shell, /折叠端点列表/);
  assert.match(shell, /展开端点列表/);
  assert.match(tree, /endpoint-initials/);
  assert.match(tree, /:title="endpoint\.name"/);
  assert.match(css, /--endpoint-tree-width:\s*255px/);
  assert.match(css, /\.linklab-shell__tree\s*\{[\s\S]*width:\s*var\(--endpoint-tree-width\)/);
});

test('endpoint rows are two-line controls and TCP/UDP/WebSocket server peers are nested children', async () => {
  const row = await source('components/EndpointRow.vue');
  const tree = await source('components/EndpointTree.vue');

  assert.match(row, /endpoint-row__primary/);
  assert.match(row, /endpoint-row__secondary/);
  assert.match(row, /endpoint-row__actions/);
  assert.match(tree, /\['tcp-server', 'websocket-server', 'udp-server'\]\.includes\(endpoint\.transport\)/);
  assert.match(tree, /class="endpoint-tree__peers"/);
  assert.match(tree, /select-peer/);
});

test('session area follows fixed status, toolbar, scrolling, and frame alignment contracts', async () => {
  const css = await source('styles/workbench.css');

  assert.match(css, /--status-bar-height:\s*55px/);
  assert.match(css, /--frame-toolbar-height:\s*39px/);
  assert.match(css, /\.linklab-shell__stream\s*\{[\s\S]*overflow:\s*(?:hidden|auto)/);
  assert.match(css, /\.frame-list__item\s*\{[\s\S]*max-width:\s*92%/);
  assert.match(css, /\.frame-list__item--received\s*\{/);
  assert.match(css, /\.frame-list__item--sent\s*\{[\s\S]*margin-left:\s*auto/);
});

test('timestamp columns reserve millisecond precision without wrapping', async () => {
  const css = await source('styles/workbench.css');
  const noWrapRule = css.match(/((?:\.log-list__row time|\.frame-list__item header time|\.history-detail__identity time)[^{]+\{[^}]*white-space:\s*nowrap[^}]*\})/s)?.[1] ?? '';

  assert.match(css, /\.log-list__row\s*\{[^}]*grid-template-columns:\s*17px 168px 58px minmax\(0, 1fr\)/s);
  assert.match(noWrapRule, /\.log-list__row time/);
  assert.match(noWrapRule, /\.frame-list__item header time/);
  assert.match(noWrapRule, /\.history-detail__identity time/);
  assert.match(css, /\.history-table th:nth-child\(1\)\s*\{\s*width:\s*180px/s);
  assert.match(css, /\.history-table\s*\{[^}]*min-width:\s*760px/s);
  assert.match(css, /\.large-font \.log-list__row[^}]*grid-template-columns:\s*19px 204px 68px/s);
  assert.match(css, /\.large-font \.history-table th:nth-child\(1\)\s*\{\s*width:\s*210px/s);
});

test('message and log views expose direction, peer, search, and realtime clear controls', async () => {
  const toolbar = await source('components/FrameToolbar.vue');
  const shell = await source('layouts/LinkLabShell.vue');

  assert.match(toolbar, /消息/);
  assert.match(toolbar, /日志/);
  assert.match(toolbar, /direction/);
  assert.match(toolbar, /peer/i);
  assert.match(toolbar, /type="search"/);
  assert.match(toolbar, /清空实时视图/);
  assert.match(toolbar, /emit\('clear'\)/);
  assert.match(toolbar, /FileClock/);
  assert.match(toolbar, /emit\('history', activeView === 'messages' \? 'frames' : 'logs'\)/);
  assert.doesNotMatch(shell, /FileClock|ScrollText/);
});

test('log levels have one frozen bilingual model shared by all log surfaces', async () => {
  const levels = await import('../src/model/logLevels.js').catch(() => null);
  assert.ok(levels, 'shared log-level model must exist');
  assert.deepEqual(levels.LOG_LEVEL_OPTIONS, ['debug', 'info', 'warn', 'error']);
  assert.equal(Object.isFrozen(levels.LOG_LEVEL_OPTIONS), true);
  assert.equal(levels.formatLogLevel('debug'), 'DEBUG 调试');
  assert.equal(levels.formatLogLevel('info'), 'INFO 信息');
  assert.equal(levels.formatLogLevel('warn'), 'WARN 警告');
  assert.equal(levels.formatLogLevel('warning'), 'WARN 警告');
  assert.equal(levels.formatLogLevel('error'), 'ERROR 错误');
  assert.equal(levels.formatLogLevel(7), '7');

  for (const relativePath of [
    'components/LogList.vue',
    'layouts/HistoryWindow.vue',
    'components/SettingsPanel.vue',
  ]) {
    const component = await source(relativePath);
    assert.match(component, /model\/logLevels\.js/, relativePath);
    assert.doesNotMatch(component, /debug:\s*['"]调试['"]/, relativePath);
  }
});

test('send panel has an explicit target, three modes, and bounded resize behavior', async () => {
  const panel = await source('components/SendPanel.vue');
  const shell = await source('layouts/LinkLabShell.vue');
  const css = await source('styles/workbench.css');

  assert.match(panel, /发送目标/);
  assert.match(panel, /\['text', 'hex', 'json'\]/);
  assert.match(panel, /option\.toUpperCase\(\)/);
  assert.match(panel, /role="radiogroup"/);
  assert.match(panel, /aria-label="调整发送面板大小"/);
  assert.match(panel, /encodeSendPayload\s*\(\s*\{/);
  assert.match(panel, /normalizeSendTarget/);
  assert.match(panel, /getSendEligibility/);
  assert.doesNotMatch(panel, /normalizeTarget\(peerId \?\? target\.value\)/);
  assert.match(shell, /:status-event="activeStatus"/);
  assert.match(shell, /:active-endpoint-id="state\.activeEndpointId"/);
  assert.match(shell, /commandErrorForEndpoint\(state\.value\.activeEndpointId\)/);
  assert.match(css, /--send-panel-height:\s*190px/);
  assert.match(panel, /height: \{ type: Number, default: 220 \}/);
  assert.match(shell, /v-model:height="composerHeight"/);
  assert.match(panel, /dragState\.mainHeight\s*\*\s*0\.5/);
  const sendPanelRule = css.match(/\.send-panel\s*\{([^}]*)\}/)?.[1] ?? '';
  assert.doesNotMatch(sendPanelRule, /max-height:\s*50%/);
});

test('empty states are factual and endpoint search cannot leave a blank tree', async () => {
  const tree = await source('components/EndpointTree.vue');
  const shell = await source('layouts/LinkLabShell.vue');
  const frames = await source('components/FrameList.vue');
  const logs = await source('components/LogList.vue');
  const panel = await source('components/SendPanel.vue');
  const visibleCopy = [tree, shell, frames, logs, panel].join('\n');

  assert.match(tree, /groups\.length === 0/);
  assert.match(tree, /没有匹配的端点/);
  assert.match(shell, /未选择端点/);
  assert.match(frames, /暂无匹配消息/);
  assert.match(logs, /暂无日志/);
  assert.match(panel, /sendEligibility\.reason/);
  assert.doesNotMatch(visibleCopy, /Select an endpoint|create one to begin|appear here|Open the endpoint to send|Drag to resize/i);
});

test('payload editor is a persistent CodeMirror 6 editor with JSON tooling and line numbers', async () => {
  const editor = await source('components/PayloadEditor.vue');

  assert.match(editor, /new EditorView\s*\(/);
  assert.match(editor, /lineNumbers\s*\(/);
  assert.match(editor, /json\s*\(/);
  assert.match(editor, /jsonParseLinter\s*\(/);
  assert.match(editor, /foldGutter\s*\(/);
  assert.match(editor, /searchKeymap/);
  assert.match(editor, /Compartment/);
  assert.match(editor, /view\.destroy\s*\(\s*\)/);
  assert.equal((editor.match(/new EditorView\s*\(/g) ?? []).length, 1);
  assert.match(editor, /onMounted\s*\(\s*\(\)\s*=>\s*\{[\s\S]*new EditorView/);
});

test('opening sessions expose cancel and endpoint editor supports all required transports', async () => {
  const status = await source('components/SessionStatusBar.vue');
  const dialog = (await Promise.all(componentFiles
    .filter(file => file === 'components/EndpointDialog.vue' || file.startsWith('components/endpoint-fields/'))
    .map(source))).join('\n');

  assert.match(status, /status === 'opening'/);
  assert.match(status, /取消/);
  assert.match(status, /listening:\s*'监听中'/);
  for (const transport of ['serial', 'tcp-client', 'tcp-server', 'udp-client', 'udp-server']) {
    assert.match(dialog, new RegExp(`value="${transport}"`));
  }
  for (const configField of [
    'listenHost', 'listenPort', 'bindHost', 'bindPort', 'targetHost', 'targetPort',
  ]) {
    assert.match(dialog, new RegExp(configField));
  }
  for (const fieldName of [
    'tcp-receive-framing', 'tcp-receive-delimiter',
    'tcp-receive-length', 'tcp-receive-idle-ms',
  ]) {
    assert.match(dialog, new RegExp(`name="${fieldName}"`));
  }
  for (const fieldName of [
    'udp-receive-framing', 'udp-receive-delimiter',
    'udp-receive-length', 'udp-receive-idle-ms',
  ]) {
    assert.doesNotMatch(dialog, new RegExp(`name="${fieldName}"`));
  }
  assert.match(dialog, /validateEndpointDraft/);
  const shell = await source('layouts/LinkLabShell.vue');
  assert.match(shell, /:save-command="saveCommand"/);
  assert.doesNotMatch(shell, /requestResult|save-endpoint/);
});

test('dark theme and large font style every management surface with fixed variables', async () => {
  const app = await source('App.vue');
  const css = await source('styles/workbench.css');
  const editor = await source('components/PayloadEditor.vue');

  assert.match(app, /createUiPreferences\s*\(\s*runtimeAdapter\s*\)/);
  assert.match(css, /\[data-theme="dark"\]/);
  assert.match(css, /\.large-font/);
  assert.match(css, /\.about-panel/);
  assert.match(css, /\.app-preferences-loading/);
  assert.ok(
    css.indexOf(':root.ui-preferences-loading') < css.indexOf('@media'),
    'loading palette must apply before any media-query fallback',
  );
  assert.match(editor, /preferenceCompartment\.reconfigure/);
  assert.doesNotMatch([app, css, editor].join('\n'), /localStorage|sessionStorage/);
});

test('large font scales every scheduled-send control without unbounded widths', async () => {
  const css = await source('styles/workbench.css');

  const typography = await source('styles/typography.css');
  assert.match(typography, /:root\.large-font\s*\{[^}]*--font-size-control:\s*13px/);
  assert.match(
    css,
    /\.large-font \.send-panel__schedule-field input,\s*\.large-font \.send-panel__schedule-field select\s*\{[^}]*height:\s*32px/,
  );
  assert.match(
    css,
    /\.large-font \.send-panel__schedule-action\s*\{[^}]*width:\s*76px/,
  );
  assert.match(css, /\.send-panel__schedule-field input,\s*\.send-panel__schedule-field select\s*\{[^}]*width:\s*62px/);
  assert.match(css, /\.send-panel__footer\s*\{[^}]*overflow-x:\s*auto/);
});

test('workbench uses approved dependencies, accessible icon controls, and forbidden wording nowhere', async () => {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, 'package.json'), 'utf8'));
  const allSources = (await Promise.all([
    ...componentFiles.map(source),
    source('styles/workbench.css'),
  ])).join('\n');

  for (const [dependency, version] of Object.entries({
    'lucide-vue-next': '^0.468.0',
    '@codemirror/state': '^6.5.2',
    '@codemirror/view': '^6.36.0',
    '@codemirror/lang-json': '^6.0.2',
    '@codemirror/lint': '^6.8.5',
    '@codemirror/search': '^6.5.10',
    '@codemirror/commands': '^6.8.1',
  })) {
    assert.equal(manifest.dependencies[dependency], version);
  }
  assert.match(allSources, /lucide-vue-next/);
  assert.match(allSources, /aria-label=/);
  assert.match(allSources, /title=/);
  assert.doesNotMatch(allSources, /\b(?:MQTT|Topic|QoS|retain)\b/i);
  assert.doesNotMatch(allSources, /gradient|\bhero\b|\borb\b/i);
  assert.doesNotMatch(allSources, /<svg\b|[▶◀▲▼←→]/);
});

async function source(relativePath) {
  const content = await readFile(path.join(sourceRoot, relativePath), 'utf8');
  if (!relativePath.endsWith('.css')) return content;
  // Inspect the actual ordered stylesheet modules after extraction, preserving every assertion.
  let expanded = '';
  let offset = 0;
  for (const match of content.matchAll(/@import\s+["']([^"']+)["'];/g)) {
    expanded += content.slice(offset, match.index);
    expanded += await source(path.join(path.dirname(relativePath), match[1]));
    offset = match.index + match[0].length;
  }
  return expanded + content.slice(offset);
}
