import { mount, flushPromises } from '@vue/test-utils';
import { reactive } from 'vue';
import { beforeEach, test, expect, vi } from 'vitest';
import StompPanel from '../../src/components/StompPanel.vue';
import { createStompWorkbench } from '../../src/model/stompWorkbench.js';
import { StompDecoder, encodeStompFrame } from '../../src/model/stompCodec.js';

vi.mock('../../src/model/stompWorkbench.js', () => ({ createStompWorkbench: vi.fn() }));
let api;
beforeEach(() => {
  const state = reactive({
    mode: 'client', config: { url: 'ws://127.0.0.1:61614/stomp', listenHost: '127.0.0.1', listenPort: 61614, path: '/stomp', host: 'localhost', autoReconnect: true, heartbeatOutgoing: 10000, heartbeatIncoming: 10000 },
    credentials: { login: '', passcode: '', headers: [], requireAuthentication: false },
    name: '', profileId: '', profiles: [], status: 'disconnected', error: '', feedback: '', busy: '', subscriptions: [], messages: [], pendingMessages: [], peers: [],
  });
  api = { state };
  for (const action of ['initialize', 'dispose', 'connect', 'disconnect', 'saveProfile', 'selectProfile', 'deleteProfile', 'subscribe', 'unsubscribe', 'send', 'ack', 'nack', 'clearMessages']) api[action] = vi.fn(async () => {});
  api.connect.mockImplementation(async () => { state.status = state.mode === 'client' ? 'connected' : 'listening'; });
  api.disconnect.mockImplementation(async () => { state.status = 'disconnected'; });
  createStompWorkbench.mockReturnValue(api);
});
function panel() { return mount(StompPanel, { props: { runtime: {} } }); }
test('bound endpoint uses its externally owned controller without global profile or role controls', async () => {
  const w = mount(StompPanel, { props: { runtime: {}, controller: api, endpoint: { id: 'protocol:stomp:a', name: '消息 A', transport: 'stomp-client' } } });
  await flushPromises();
  expect(api.initialize).not.toHaveBeenCalled();
  expect(w.find('[name="stomp-profile"]').exists()).toBe(false);
  expect(w.find('[name="stomp-mode"]').exists()).toBe(false);
  expect(w.findAll('button').some(button => button.text() === '删除配置')).toBe(false);
  expect(w.text()).toContain('消息 A');
  await click(w, '保存配置');
  expect(api.saveProfile).toHaveBeenCalledOnce();
  w.unmount(); expect(api.dispose).not.toHaveBeenCalled();
});
async function click(w, text) {
  const button = w.findAll('button').find(b => b.text() === text);
  expect(button, `button ${text}`).toBeTruthy(); await button.trigger('click'); await flushPromises();
}

test('opens without connecting and supports both role configurations', async () => {
  const w = panel(); await flushPromises();
  expect(api.initialize).toHaveBeenCalledOnce(); expect(api.connect).not.toHaveBeenCalled();
  expect(w.find('[name="stomp-url"]').element.value).toContain('/stomp');
  await w.find('[name="stomp-mode"]').setValue('server');
  expect(w.find('[name="stomp-listen-port"]').exists()).toBe(true);
  expect(w.text()).toContain('不支持事务、通配订阅、SockJS、持久队列或集群');
  await click(w, '启动服务'); expect(api.state.status).toBe('listening');
  expect(w.find('[name="stomp-mode"]').element.disabled).toBe(true);
  expect(w.find('[name="stomp-login"]').element.disabled).toBe(true);
  await click(w, '停止服务');
  w.unmount(); expect(api.dispose).toHaveBeenCalledOnce();
});

test('temporary authentication and headers stay in credentials while profiles use model commands', async () => {
  const w = panel(); await flushPromises();
  await w.find('[name="stomp-login"]').setValue('tester');
  await w.find('[name="stomp-passcode"]').setValue('secret');
  await click(w, '添加请求头');
  await w.find('[aria-label="请求头名称 1"]').setValue('Authorization');
  await w.find('[aria-label="请求头值 1"]').setValue('Bearer temp');
  await w.find('[name="stomp-name"]').setValue('本地测试');
  await click(w, '保存配置');
  expect(api.saveProfile).toHaveBeenCalledOnce();
  expect(api.state.credentials).toMatchObject({ login: 'tester', passcode: 'secret', headers: [{ name: 'Authorization', value: 'Bearer temp' }] });
  expect(api.state.config).not.toHaveProperty('passcode');
  expect(w.find('[name="stomp-passcode"]').attributes('type')).toBe('password');
  expect(w.text()).toContain('仅用于本次会话');
  api.state.profiles = [{ id: 'saved', name: '已有连接' }]; await flushPromises();
  await w.find('[name="stomp-profile"]').setValue('saved'); expect(api.selectProfile).toHaveBeenCalledWith('saved');
  api.state.profileId = 'saved'; await flushPromises(); await click(w, '删除配置'); expect(api.deleteProfile).toHaveBeenCalledOnce();
  w.unmount();
});

test('client subscription and send forms submit explicit protocol options', async () => {
  const w = panel(); await click(w, '连接');
  await w.find('[name="stomp-sub-destination"]').setValue('/queue/jobs');
  await w.find('[name="stomp-sub-ack"]').setValue('client-individual');
  await w.find('[data-testid="stomp-subscribe"]').trigger('submit'); await flushPromises();
  expect(api.subscribe).toHaveBeenCalledWith({ destination: '/queue/jobs', ack: 'client-individual' });
  api.state.subscriptions = [{ id: 'sub1', destination: '/queue/jobs', ack: 'client-individual' }]; await flushPromises();
  await click(w, '退订'); expect(api.unsubscribe).toHaveBeenCalledWith('sub1');
  await w.find('[name="stomp-send-destination"]').setValue('/topic/events');
  await w.find('[name="stomp-body"]').setValue('你好\n消息');
  await w.find('[name="stomp-content-type"]').setValue('application/json');
  await w.find('[name="stomp-receipt"]').setValue(false);
  await w.find('[data-testid="stomp-send"]').trigger('submit'); await flushPromises();
  expect(api.send).toHaveBeenCalledWith({ destination: '/topic/events', body: '你好\n消息', contentType: 'application/json', receipt: false });
  w.unmount();
});

test('received messages escape markup and expose manual confirmation only while pending', async () => {
  api.state.status = 'connected';
  api.state.messages = [{ id: 'row1', direction: 'in', body: '<img src=x onerror=alert(1)>', destination: '/queue/jobs', subscription: 'sub1', messageId: 'msg1', ackId: 'ack1', ack: 'client-individual', status: 'received', createdAt: '2026-10-21T15:00:00Z' }];
  const w = panel(); await flushPromises();
  expect(w.find('.stomp-message-body').text()).toBe('<img src=x onerror=alert(1)>'); expect(w.find('.stomp-messages img').exists()).toBe(false);
  await click(w, 'ACK'); expect(api.ack).toHaveBeenCalledWith('row1');
  await click(w, 'NACK'); expect(api.nack).toHaveBeenCalledWith('row1');
  api.state.messages[0].status = 'acknowledged'; await flushPromises();
  expect(w.findAll('button').some(b => b.text() === 'ACK')).toBe(false);
  await click(w, '清空消息'); expect(api.clearMessages).toHaveBeenCalledOnce();
  w.unmount();
});

test('server shows connected peers and publishes through the shared send API', async () => {
  api.state.mode = 'server'; api.state.status = 'listening'; api.state.peers = [{ id: 'peer1', remoteAddress: '127.0.0.1', remotePort: 12345 }];
  const w = panel(); await flushPromises();
  expect(w.text()).toContain('peer1'); expect(w.text()).toContain('127.0.0.1');
  expect(w.find('[data-testid="stomp-subscribe"]').exists()).toBe(false);
  await w.find('[name="stomp-body"]').setValue('server event'); await w.find('[data-testid="stomp-send"]').trigger('submit'); await flushPromises();
  expect(api.send).toHaveBeenCalledOnce(); w.unmount();
});

test('errors stay visible and connection cancellation remains available while busy', async () => {
  api.state.status = 'connecting'; api.state.busy = 'connect'; api.state.error = '连接被拒绝';
  const w = panel(); await flushPromises();
  expect(w.find('[role="alert"]').text()).toContain('连接被拒绝');
  expect(w.find('[name="stomp-url"]').element.disabled).toBe(true);
  await click(w, '取消连接'); expect(api.disconnect).toHaveBeenCalledOnce();
  await click(w, '返回通信'); expect(w.emitted('back')).toHaveLength(1);
  w.unmount();
});

test('receipt progress and failure states use readable Chinese labels', async () => {
  api.state.messages = ['sending', 'confirmed', 'failed', 'receipt-timeout', 'stale', 'unsubscribed'].map(status => ({ id: status, body: status, status, direction: 'out', destination: '/topic/events' }));
  const w = panel(); await flushPromises();
  const statuses = w.findAll('.stomp-message-heading .stomp-muted').map(row => row.text());
  expect(statuses).toEqual(['发送中', '回执已确认', '发送失败', '回执超时', '会话已结束', '已退订']); w.unmount();
});

function pendingRow(id = 'pending1') {
  return { id, destination: '/queue/jobs', subscription: 'sub1', messageId: `message-${id}`, ackId: `ack-${id}`, ack: 'client-individual', createdAt: '2026-10-21T15:00:00Z' };
}
test('clearing history preserves bodyless pending ACK controls without duplicating visible messages', async () => {
  const pending = pendingRow(); api.state.status = 'connected'; api.state.pendingMessages = [pending];
  api.state.messages = [{ ...pending, direction: 'in', status: 'received', body: 'large private message body' }];
  api.clearMessages.mockImplementation(() => { api.state.messages = []; });
  api.ack.mockImplementation(async id => { api.state.pendingMessages = api.state.pendingMessages.filter(row => row.id !== id); });
  const w = panel(); await flushPromises();
  const expectedTime = new Date(2026, 9, 21, 15, 0, 0, 7);
  const expectedText = '2026-10-21 15:00:00.007';
  api.state.messages[0].createdAt = expectedTime.toISOString(); await flushPromises();
  expect(w.get('.stomp-message time').text()).toBe(expectedText);
  api.state.pendingMessages[0].createdAt = expectedTime.toISOString();
  expect(w.find('[aria-label="待确认消息"]').exists()).toBe(false);
  await click(w, '清空消息');
  const list = w.find('[aria-label="待确认消息"]');
  expect(list.exists()).toBe(true); expect(list.text()).toContain('message-pending1'); expect(list.text()).toContain('ack-pending1');
  expect(list.text()).toContain(expectedText);
  expect(w.text()).not.toContain('large private message body'); expect(list.find('.stomp-message-body').exists()).toBe(false);
  await list.findAll('button').find(button => button.text() === 'ACK').trigger('click'); await flushPromises();
  expect(api.ack).toHaveBeenCalledWith('pending1'); expect(w.find('[aria-label="待确认消息"]').exists()).toBe(false); w.unmount();
});

test('evicted messages retain NACK by message id and lose controls when resolved', async () => {
  api.state.status = 'connected'; api.state.pendingMessages = [pendingRow('evicted')];
  api.state.messages = [{ id: 'newer-message', body: 'new content', direction: 'out', status: 'sent' }];
  api.nack.mockImplementation(async id => { api.state.pendingMessages = api.state.pendingMessages.filter(row => row.id !== id); });
  const w = panel(); await flushPromises();
  const list = w.find('[aria-label="待确认消息"]'); expect(list.text()).toContain('/queue/jobs');
  await list.findAll('button').find(button => button.text() === 'NACK').trigger('click'); await flushPromises();
  expect(api.nack).toHaveBeenCalledWith('evicted'); expect(w.find('[aria-label="待确认消息"]').exists()).toBe(false); w.unmount();
});

test('pending controls disappear after unsubscribe or session closure', async () => {
  api.state.status = 'connected'; api.state.pendingMessages = [pendingRow()];
  const w = panel(); await flushPromises(); expect(w.find('[aria-label="待确认消息"]').exists()).toBe(true);
  api.state.pendingMessages = []; await flushPromises(); expect(w.find('[aria-label="待确认消息"]').exists()).toBe(false);
  api.state.pendingMessages = [pendingRow()]; api.state.status = 'disconnected'; await flushPromises();
  expect(w.find('[aria-label="待确认消息"]').exists()).toBe(false); w.unmount();
});

test('native broker delivery continues between animation frames without repainting every message', async () => {
  const { createStompWorkbench: actualWorkbench } = await vi.importActual('../../src/model/stompWorkbench.js');
  const frames = new Map(); let frameId = 0, listener;
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  const delivered = [];
  const identity = { sessionId: 'native-session', operationId: 'native-operation' };
  const controller = actualWorkbench({ stomp: {
    onEvent(callback) { listener = callback; return () => {}; },
    async execute(request) {
      if (request.action === 'open') return identity;
      if (request.action === 'send') delivered.push(...new StompDecoder().push(request.bytes));
      return {};
    },
  } }, { reactive });
  controller.state.mode = 'server';
  controller.state.config.heartbeatOutgoing = controller.state.config.heartbeatIncoming = 0;
  const emit = (command, headers, body = '') => listener({ type: 'frames', payload: {
    endpointId: controller.state.connectionId, ...identity,
    frames: [{ peerId: 'peer', bytes: [...encodeStompFrame(command, headers, body)] }],
  } });
  const w = mount(StompPanel, { props: { runtime: {}, controller } });
  try {
    await controller.connect();
    emit('CONNECT', { 'accept-version': '1.2', host: 'localhost', 'heart-beat': '0,0' });
    emit('SUBSCRIBE', { id: 's', destination: '/topic/load' });
    await click(w, '消息与订阅');
    for (let i = 0; i < 600; i++) {
      emit('SEND', { destination: '/topic/load' }, `body-${i}`);
      await flushPromises();
    }
    expect(delivered.filter(row => row.command === 'MESSAGE').map(row => row.body)).toEqual(Array.from({ length: 600 }, (_, i) => `body-${i}`));
    expect(controller.state.messages).toHaveLength(500);
    expect(w.findAll('.stomp-message')).toHaveLength(0);
    expect(frames.size).toBe(1);
    const callback = [...frames.values()][0]; frames.clear(); callback(16); await flushPromises();
    expect(w.findAll('.stomp-message-body').map(row => row.text())).toEqual(Array.from({ length: 500 }, (_, i) => `body-${i + 100}`));
    emit('SEND', { destination: '/topic/load' }, 'hide-before-paint'); await flushPromises();
    expect(frames.size).toBe(1);
    await w.setProps({ visible: false }); await flushPromises();
    expect(frames.size).toBe(0); expect(w.findAll('.stomp-message')).toHaveLength(0);
    for (let i = 0; i < 600; i++) {
      emit('SEND', { destination: '/topic/load' }, `hidden-${i}`); await flushPromises();
    }
    expect(delivered.filter(row => row.command === 'MESSAGE')).toHaveLength(1201);
    expect(controller.state.messages).toHaveLength(500); expect(controller.state.status).toBe('listening');
    expect(frames.size).toBe(0); expect(w.findAll('.stomp-message')).toHaveLength(0);
    await w.setProps({ visible: true }); await flushPromises();
    const restored = [...frames.values()][0]; frames.clear(); restored(32); await flushPromises();
    expect(w.findAll('.stomp-message-body').map(row => row.text())).toEqual(Array.from({ length: 500 }, (_, i) => `hidden-${i + 100}`));
    emit('SEND', { destination: '/topic/load' }, 'clear-before-paint'); await flushPromises();
    await click(w, '清空消息');
    expect(frames.size).toBe(0); expect(w.findAll('.stomp-message')).toHaveLength(0);
    emit('SEND', { destination: '/topic/load' }, 'cancel-on-unmount'); await flushPromises();
    expect(frames.size).toBe(1);
    w.unmount(); expect(frames.size).toBe(0);
  } finally {
    if (w.exists()) w.unmount();
    await controller.dispose(); requestFrame.mockRestore(); cancelFrame.mockRestore();
  }
});

test('rolling a full history does not rebuild the unchanged message bodies', async () => {
  const frames = new Map(); let frameId = 0, bodyReads = 0;
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  const row = id => ({ id: String(id), direction: 'in', status: 'received', destination: '/topic/load', get body() { bodyReads++; return `body-${id}`; } });
  api.state.messages = Array.from({ length: 500 }, (_, i) => row(i));
  const w = panel();
  try {
    await flushPromises(); expect(w.findAll('.stomp-message')).toHaveLength(500);
    bodyReads = 0;
    api.state.messages.push(row(500)); api.state.messages.shift(); await flushPromises();
    const callback = [...frames.values()][0]; frames.clear(); callback(16); await flushPromises();
    expect(w.findAll('.stomp-message-body').map(row => row.text())).toEqual(Array.from({ length: 500 }, (_, i) => `body-${i + 1}`));
    expect(bodyReads).toBeLessThanOrEqual(2);
  } finally { w.unmount(); requestFrame.mockRestore(); cancelFrame.mockRestore(); }
});


test('hiding a client retains its draft and applies pending ACK and receipt changes on return', async () => {
  const frames = new Map(); let frameId = 0;
  const requestFrame = vi.spyOn(window, 'requestAnimationFrame').mockImplementation(callback => { frames.set(++frameId, callback); return frameId; });
  const cancelFrame = vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(id => frames.delete(id));
  api.state.status = 'connected';
  const incoming = { ...pendingRow(), direction: 'in', status: 'received', body: 'pending body' };
  api.state.messages = [incoming, { id: 'receipt', direction: 'out', status: 'sending', body: 'sent body', destination: '/topic/events' }];
  api.state.pendingMessages = [pendingRow()];
  const w = mount(StompPanel, { props: { runtime: {}, controller: api, visible: true } });
  try {
    await click(w, '消息与订阅'); await w.find('[name="stomp-body"]').setValue('retained draft');
    await w.setProps({ visible: false }); await flushPromises();
    expect(w.findAll('.stomp-message')).toHaveLength(0);
    expect(w.find('[aria-label="待确认消息"]').exists()).toBe(false);
    api.state.messages[1].status = 'confirmed';
    api.state.messages.push({ id: 'new', direction: 'in', status: 'received', body: 'background message', destination: '/topic/events' });
    await flushPromises(); expect(frames.size).toBe(0);
    await w.setProps({ visible: true }); await flushPromises();
    const paint = [...frames.values()][0]; frames.clear(); paint(16); await flushPromises();
    expect(w.findAll('.stomp-message-body').map(row => row.text())).toEqual(['pending body', 'sent body', 'background message']);
    expect(w.text()).toContain('回执已确认'); expect(w.find('[name="stomp-body"]').element.value).toBe('retained draft');
    await click(w, 'ACK'); expect(api.ack).toHaveBeenCalledWith(incoming.id);
    expect(api.disconnect).not.toHaveBeenCalled(); expect(api.dispose).not.toHaveBeenCalled();
  } finally { w.unmount(); requestFrame.mockRestore(); cancelFrame.mockRestore(); }
});
