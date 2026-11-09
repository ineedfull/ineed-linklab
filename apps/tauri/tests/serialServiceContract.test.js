import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  normalizeFrameWireBatch,
  normalizeStatusWireEvent,
} from '@ineed-linklab/runtime-contract';
import { createTauriRuntimeAdapter } from '../renderer/runtimeAdapter.js';

const identity = {
  endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
};
const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('native serial wiring has one service, main-only events, snapshots, and shutdown barrier', async () => {
  const [lib, serial, transport, database, persistence] = await Promise.all([
    readFile(path.join(packageRoot, 'src-tauri/src/lib.rs'), 'utf8'),
    readFile(path.join(packageRoot, 'src-tauri/src/serial.rs'), 'utf8'),
    readFile(path.join(packageRoot, 'src-tauri/src/transport.rs'), 'utf8'),
    readFile(path.join(packageRoot, 'src-tauri/src/database.rs'), 'utf8'),
    readFile(path.join(packageRoot, 'src-tauri/src/persistence.rs'), 'utf8'),
  ]);
  assert.equal((lib.match(/SerialService::new\(/g) ?? []).length, 1);
  assert.match(lib, /serial_service:\s*serial_service\.clone\(\)/);
  assert.match(lib, /TauriTransportWiring::new\(database\.clone\(\)\)[\s\S]*transport_wiring\.event_sink[\s\S]*transport_wiring\s*\.coordinator/);
  assert.match(lib, /persistence:\s*Arc<persistence::TransportPersistence>/);
  assert.match(lib, /ExitRequested[\s\S]*prevent_exit\(\)[\s\S]*start_shutdown\(app_handle/);
  assert.match(lib, /SHUTDOWN_ATTEMPTS:\s*usize\s*=\s*2/);
  assert.match(lib, /SHUTDOWN_TIMEOUT:\s*Duration\s*=\s*Duration::from_secs\(2\)/);
  assert.match(lib, /run_bounded_shutdown[\s\S]*recv_timeout\(timeout\)/);
  assert.match(lib, /ForcedAfterError[\s\S]*target\.force_shutdown\(\)/);
  assert.match(lib, /ForcedAfterTimeout[\s\S]*target\.force_shutdown\(\)/);
  assert.match(lib, /eprintln!\([\s\S]*forced cleanup/);
  const transportShutdown = lib.slice(
    lib.indexOf('fn run_transport_shutdown'),
    lib.indexOf('pub struct AppState'),
  );
  assert.match(transportShutdown, /persistence\.flush\(\)/);
  assert.match(transportShutdown, /persistence\.shutdown\(\)/);
  assert.match(transportShutdown, /serial\.disconnect_event_sink\(\)/);
  assert.ok(transportShutdown.indexOf('run_bounded_shutdown')
    < transportShutdown.indexOf('persistence.flush()'));
  assert.ok(transportShutdown.indexOf('persistence.flush()')
    < transportShutdown.indexOf('persistence.shutdown()'));
  assert.ok(transportShutdown.indexOf('persistence.shutdown()')
    < transportShutdown.indexOf('serial.disconnect_event_sink()'));
  const shutdownStart = lib.slice(lib.indexOf('fn start_shutdown'));
  assert.match(shutdownStart, /run_transport_shutdown/);
  assert.match(shutdownStart, /record_shutdown_outcome\("serial",\s*&result\.serial\)/);
  assert.match(shutdownStart, /record_shutdown_outcome\("tcp",\s*&result\.tcp\)/);
  assert.ok(
    shutdownStart.indexOf('record_shutdown_outcome("serial", &result.serial)')
      < shutdownStart.indexOf('shutdown_finished'),
  );
  assert.match(serial, /trait SerialBackend/);
  assert.match(serial, /struct RealSerialBackend/);
  assert.match(serial, /lifecycle:\s*Mutex<ServiceState>/);
  assert.match(serial, /sink:\s*Mutex<Option<Arc<dyn SerialEventSink>>>/);
  assert.match(serial, /struct ServiceState[\s\S]*stopped:\s*bool[\s\S]*active_opens:\s*usize[\s\S]*sessions:\s*HashMap/);
  assert.match(serial, /struct StatusLog[\s\S]*level:\s*&'static str[\s\S]*source:\s*&'static str[\s\S]*code:\s*Option<String>[\s\S]*message:\s*String[\s\S]*details:\s*Option<Value>[\s\S]*created_at:\s*u64/);
  assert.match(serial, /struct StatusEvent[\s\S]*log:\s*Option<StatusLog>/);
  assert.match(serial, /fn emit_status[\s\S]*let created_at = now_millis\(\)[\s\S]*status_log\([\s\S]*created_at/);
  assert.match(serial, /fn status_log[\s\S]*正在打开串口[\s\S]*串口已打开[\s\S]*正在关闭串口[\s\S]*串口已关闭[\s\S]*串口意外断开[\s\S]*读取串口失败[\s\S]*写入串口失败/);
  assert.match(serial, /SerialStatus::Closed && session\.failure_reported\.load/);
  assert.match(serial, /fn force_shutdown\(&self\)\s*->\s*Vec<String>/);
  assert.match(serial, /process_exit_fallback/);
  assert.match(serial, /fn force_close\(&self\)\s*->\s*bool[\s\S]*try_lock\(\)/);
  assert.doesNotMatch(serial, /unsafe\s*\{/);
  assert.match(transport, /emit_to\("main",\s*"transport:status"/);
  assert.match(transport, /emit_to\("main",\s*"transport:frames"/);
  assert.match(transport, /handle_then_forward/);
  assert.doesNotMatch(transport, /emit_all|emit\("transport:/);
  assert.match(transport, /endpoint_snapshot\(&endpoint_id\)[\s\S]*service\.open\(/);
  assert.match(transport, /transport_disconnect_peer[\s\S]*coordinator\.disconnect_peer\(snapshot,\s*&peer_id\)/);
  assert.match(transport, /"tcp-client"\s*\|\s*"tcp-server"\s*=>\s*self\.tcp_service\.disconnect_peer/);
  assert.match(transport, /"serial peer disconnect is unavailable"/);
  assert.match(database, /coordinator\.close_endpoint\(&value\)\?;\s*database\.delete_endpoint/);
  assert.match(database, /struct FrameHistoryInsert[\s\S]*payload:\s*Vec<u8>[\s\S]*created_at:\s*i64/);
  assert.match(database, /struct LogHistoryInsert[\s\S]*details:\s*Option<Value>[\s\S]*created_at:\s*i64/);
  assert.match(database, /fn insert_frame_batch[\s\S]*validate_frame_history_batch[\s\S]*connection\.transaction/);
  assert.match(database, /fn insert_log_batch[\s\S]*validate_log_history_batch[\s\S]*connection\.transaction/);
  assert.match(persistence, /mpsc::sync_channel\(config\.command_capacity\.max\(1\)\)/);
  assert.match(persistence, /try_send\(Command::Event\(Box::new\(event\)\)\)/);
  assert.match(persistence, /const MAX_BATCH_SIZE:\s*usize\s*=\s*200/);
  assert.match(persistence, /DEFAULT_FLUSH_INTERVAL:\s*Duration\s*=\s*Duration::from_secs\(1\)/);
  assert.match(persistence, /frames:\s*VecDeque<FrameHistoryInsert>/);
  assert.match(persistence, /logs:\s*VecDeque<LogHistoryInsert>/);
  assert.match(persistence, /self\.handle\(event\.clone\(\)\);\s*forward\(event\)/);
  assert.match(database, /fn after_persistence_flush[\s\S]*coordinator\.flush_persistence\(\)\?;[\s\S]*mutation\(\)/);
  // Import validation/close/flush ordering is exercised against SQLite by Rust's
  // invalid_workspace_does_not_close_active_transports and transport barrier tests.
  const clearCommand = database.slice(database.indexOf('pub(crate) async fn storage_clear_history'));
  assert.match(clearCommand, /after_persistence_flush\(coordinator\.as_ref\(\), \|\|\s*\{?\s*database\.clear_history\(\)/);
  assert.doesNotMatch(`${lib}\n${serial}\n${transport}\n${database}\n${persistence}`, /localStorage|sessionStorage/);
});

test('shared browser-safe normalizer converts strict wire batches to workbench frames', () => {
  const result = normalizeFrameWireBatch({
    ...identity,
    frames: [{ direction: 'in', bytes: [0, 127, 255], createdAt: 10 }],
  });
  assert.deepEqual(result, {
    ...identity,
    frames: [{ ...identity, direction: 'in', bytes: Uint8Array.of(0, 127, 255), createdAt: 10 }],
  });
  assert.deepEqual(normalizeStatusWireEvent({
    ...identity,
    status: 'open',
    error: null,
    createdAt: 11,
    log: {
      level: 'info', source: 'serial', code: null, message: '串口已打开: /dev/ttyUSB0',
      details: { path: '/dev/ttyUSB0', settings: [115200, true] }, createdAt: 11,
    },
  }), {
    ...identity,
    status: 'open',
    error: null,
    createdAt: 11,
    log: {
      level: 'info', source: 'serial', code: null, message: '串口已打开: /dev/ttyUSB0',
      details: { path: '/dev/ttyUSB0', settings: [115200, true] }, createdAt: 11,
    },
  });
});

test('Tauri adapter converts send Uint8Array to a dense number array', async () => {
  const invokes = [];
  const adapter = createTauriRuntimeAdapter({
    invoke: async (command, payload) => {
      invokes.push([command, payload]);
      return { ok: true, value: { sent: 3 } };
    },
    listen: async () => () => {},
  });

  await adapter.transport.send({ endpointId: 'serial-1', bytes: Uint8Array.of(0, 127, 255) });
  assert.deepEqual(invokes, [[
    'transport_send',
    { args: [{ endpointId: 'serial-1', bytes: [0, 127, 255] }] },
  ]]);
});

test('runtime adapter isolates invalid frame and status events and reports contract errors', async () => {
  const listeners = new Map();
  const reports = [];
  const adapter = createTauriRuntimeAdapter({
    invoke: async () => ({ ok: true, value: null }),
    listen: async (name, listener) => {
      listeners.set(name, listener);
      return () => listeners.delete(name);
    },
  }, (error) => {
    reports.push(error);
    throw new Error('reporter failed');
  });
  const frames = [];
  const statuses = [];
  const stopFrames = adapter.transport.onFrames((value) => frames.push(value));
  const stopStatus = adapter.transport.onStatus((value) => statuses.push(value));
  await Promise.resolve();
  const identity = {
    endpointId: 'serial-1', operationId: 'open-1', sessionId: 'session-1',
  };

  assert.doesNotThrow(() => listeners.get('transport:frames')({ payload: {
    ...identity, frames: [{ direction: 'in', bytes: [256], createdAt: 1 }],
  } }));
  assert.doesNotThrow(() => listeners.get('transport:status')({ payload: {
    ...identity, status: 'invalid', error: null, createdAt: 2, log: null,
  } }));
  assert.doesNotThrow(() => listeners.get('transport:status')({ payload: {
    ...identity,
    status: 'open',
    error: null,
    createdAt: 2,
    log: {
      level: 'notice', source: 'serial', code: null, message: 'invalid level',
      details: null, createdAt: 2,
    },
  } }));
  assert.deepEqual(frames, []);
  assert.deepEqual(statuses, []);
  assert.equal(reports.length, 3);
  for (const [index, [method, eventName]] of [
    ['transport.onFrames', 'transport:frames'],
    ['transport.onStatus', 'transport:status'],
    ['transport.onStatus', 'transport:status'],
  ].entries()) {
    assert.equal(reports[index] instanceof Error, true);
    assert.equal(reports[index].code, 'INVALID_EVENT_PAYLOAD');
    assert.equal(reports[index].method, method);
    assert.equal(reports[index].eventName, eventName);
    assert.equal(reports[index].runtimeName, 'tauri');
    assert.equal(reports[index].cause instanceof TypeError, true);
  }

  listeners.get('transport:frames')({ payload: {
    ...identity, frames: [{ direction: 'out', bytes: [1, 2], createdAt: 3 }],
  } });
  listeners.get('transport:status')({ payload: {
    ...identity,
    status: 'open',
    error: null,
    createdAt: 4,
    log: {
      level: 'info', source: 'serial', code: null, message: '串口已打开: /dev/ttyUSB0',
      details: { path: '/dev/ttyUSB0' }, createdAt: 4,
    },
  } });
  assert.deepEqual(frames[0].frames[0].bytes, Uint8Array.of(1, 2));
  assert.deepEqual(statuses[0].log, {
    level: 'info', source: 'serial', code: null, message: '串口已打开: /dev/ttyUSB0',
    details: { path: '/dev/ttyUSB0' }, createdAt: 4,
  });

  await stopFrames();
  await stopStatus();
  assert.equal(listeners.size, 0);
});

test('unsubscribe before asynchronous registration prevents delivery and unregisters once', async () => {
  let resolveRegistration;
  let deliveries = 0;
  let unlistenCalls = 0;
  const adapter = createTauriRuntimeAdapter({
    invoke: async () => ({ ok: true, value: null }),
    listen: (_name, registeredListener) => new Promise((resolve) => {
      resolveRegistration = () => resolve(() => {
        unlistenCalls += 1;
        registeredListener({ payload: null });
      });
    }),
  });
  const unsubscribe = adapter.transport.onFrames(() => { deliveries += 1; });
  const stopped = unsubscribe();
  await Promise.resolve();
  resolveRegistration();
  await stopped;
  await unsubscribe();
  assert.equal(unlistenCalls, 1);
  assert.equal(deliveries, 0);
});
