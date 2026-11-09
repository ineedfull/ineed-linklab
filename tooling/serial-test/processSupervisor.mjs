import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';

const DEFAULT_TERM_TIMEOUT_MS = 2_000;
const DEFAULT_KILL_TIMEOUT_MS = 2_000;

export class ProcessSupervisor {
  constructor({
    platform = process.platform,
    spawnProcess = spawn,
    termTimeoutMs = DEFAULT_TERM_TIMEOUT_MS,
    killTimeoutMs = DEFAULT_KILL_TIMEOUT_MS,
  } = {}) {
    this.platform = platform;
    this.spawnProcess = spawnProcess;
    this.termTimeoutMs = termTimeoutMs;
    this.killTimeoutMs = killTimeoutMs;
    this.records = new Set();
  }

  get size() {
    return this.records.size;
  }

  spawn(command, args, options = {}) {
    const child = this.spawnProcess(command, args, {
      ...options,
      detached: this.platform !== 'win32',
    });
    const record = {
      command,
      child,
      pid: child.pid ?? null,
      exitResult: null,
      cleanupPromise: null,
    };
    record.exitPromise = new Promise((resolve) => {
      let settled = false;
      const settle = (result) => {
        if (settled) return;
        settled = true;
        record.exitResult = result;
        resolve(result);
      };
      child.once('error', (error) => settle({ code: null, signal: null, error }));
      child.once('exit', (code, signal) => settle({ code, signal, error: null }));
    });
    this.records.add(record);
    return record;
  }

  async finish(record) {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      const result = await record.exitPromise;
      this.#signal(record, 'SIGKILL');
      const gone = await this.#waitUntilGone(record, this.killTimeoutMs);
      if (!gone) throw new Error(`${record.command} process group ${record.pid} survived exit cleanup`);
      this.records.delete(record);
      return { ...result, pid: record.pid, escalated: false };
    })();
    return record.cleanupPromise;
  }

  async terminate(record) {
    if (record.cleanupPromise) return record.cleanupPromise;
    record.cleanupPromise = (async () => {
      this.#signal(record, 'SIGTERM');
      if (await this.#waitUntilGone(record, this.termTimeoutMs)) {
        this.records.delete(record);
        return { ...record.exitResult, pid: record.pid, escalated: false };
      }

      this.#signal(record, 'SIGKILL');
      if (!await this.#waitUntilGone(record, this.killTimeoutMs)) {
        throw new Error(`${record.command} process group ${record.pid} survived SIGKILL`);
      }
      this.records.delete(record);
      return { ...record.exitResult, pid: record.pid, escalated: true };
    })();
    return record.cleanupPromise;
  }

  async cleanupAll() {
    const results = await Promise.allSettled([...this.records].map((record) => this.terminate(record)));
    const failure = results.find((result) => result.status === 'rejected');
    if (failure) throw failure.reason;
  }

  #signal(record, signal) {
    if (record.pid === null) {
      if (record.child.exitCode === null && record.child.signalCode === null) {
        record.child.kill(signal);
      }
      return;
    }
    try {
      if (this.platform === 'win32') record.child.kill(signal);
      else process.kill(-record.pid, signal);
    } catch (error) {
      if (error.code !== 'ESRCH') throw error;
    }
  }

  async #waitUntilGone(record, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (record.exitResult && !this.#groupExists(record)) return true;
      await delay(10);
    }
    return Boolean(record.exitResult) && !this.#groupExists(record);
  }

  #groupExists(record) {
    if (record.pid === null) return !record.exitResult;
    try {
      if (this.platform === 'win32') process.kill(record.pid, 0);
      else process.kill(-record.pid, 0);
      return true;
    } catch (error) {
      if (error.code === 'ESRCH') return false;
      if (error.code === 'EPERM') return true;
      throw error;
    }
  }
}

export function readFirstLine(stream, timeoutMs, timers = globalThis) {
  let output = '';
  let timeout;
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      if (timeout !== undefined) timers.clearTimeout(timeout);
      stream.off('data', onData);
      stream.off('error', onError);
    };
    const settle = (callback, value) => {
      cleanup();
      callback(value);
    };
    const onData = (chunk) => {
      output += chunk;
      const newline = output.indexOf('\n');
      if (newline !== -1) settle(resolve, output.slice(0, newline));
    };
    const onError = (error) => settle(reject, error);

    stream.setEncoding('utf8');
    stream.on('data', onData);
    stream.once('error', onError);
    timeout = timers.setTimeout(() => settle(reject, new Error('Timed out waiting for child PID')), timeoutMs);
  });
}

export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
}
