import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';

const run = promisify(execFile);

/** Explicit diagnostic only: Inspector snapshots perform GC and change memory. */
export function createHeapDiagnostic({ page, directory, out, sample }) {
  let nextId = 0;
  let webcontentPid;
  async function probe(op, script) {
    const id = ++nextId;
    await writeFile(path.join(directory, 'request.json'), JSON.stringify({ id, op, script }));
    for (let n = 0; n < 300; n++) {
      let answer;
      try { answer = JSON.parse(await readFile(path.join(directory, 'response.json'), 'utf8')); } catch { /* Poll owned probe output. */ }
      if (answer?.id === id) {
        assert(!answer.error, answer.error); assert(!answer.value?.error, JSON.stringify(answer.value)); return answer.value;
      }
      await delay(100);
    }
    throw new Error(`Native heap probe timeout: ${op}`);
  }
  return async function capture(stage) {
    await sample(`heap-${stage}-before`);
    const snapshots = await readFile(path.join(out, 'samples.jsonl'), 'utf8');
    const last = JSON.parse(snapshots.trim().split('\n').at(-1));
    webcontentPid ??= last.owned.find(row => row.name.includes('WebContent'))?.pid;
    assert(webcontentPid && last.owned.some(row => row.pid === webcontentPid), 'Original inspected WebContent must remain alive');
    await writeFile(path.join(out, 'diagnostic-targets.json'), JSON.stringify({ tauriWebContentPid: webcontentPid }, null, 2));
    for (const process of last.owned.filter(row => row.pid === webcontentPid)) {
      for (const [tool, args] of [['vmmap', ['-summary']], ['heap', ['-s']]]) {
        try {
          const result = await run(tool, [...args, String(process.pid)], { timeout: 25000, maxBuffer: 16 * 1024 * 1024 });
          await writeFile(path.join(out, `${stage}-${tool}-${process.pid}.txt`), result.stdout + result.stderr);
        } catch (error) { await writeFile(path.join(out, `${stage}-${tool}-error.txt`), String(error)); }
      }
    }
    const cdp = await page.context().newCDPSession(page);
    try {
      const heapUsage = await cdp.send('Runtime.getHeapUsage');
      const dom = await cdp.send('Memory.getDOMCounters');
      await writeFile(path.join(out, `${stage}-electron-heap-usage.json`), JSON.stringify({ heapUsage, dom }, null, 2));
      const chunks = [];
      cdp.on('HeapProfiler.addHeapSnapshotChunk', event => chunks.push(event.chunk));
      await cdp.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      await writeFile(path.join(out, `${stage}-electron.heapsnapshot`), chunks.join(''));
    } finally { await cdp.detach(); }
    await probe('open'); await delay(1500);
    try {
      await probe('eval', "(()=>{window.linklabHeap=null; const target=WI.targets.find(t=>t.hasDomain('Heap')); target.HeapAgent.enable(); target.HeapAgent.snapshot((error,timestamp,snapshotStringData)=>{window.linklabHeap={error,timestamp,snapshotStringData};}); return 'requested';})()");
      let heap;
      for (let n = 0; n < 150; n++) { heap = await probe('eval', 'window.linklabHeap'); if (heap) break; await delay(100); }
      assert(heap && !heap.error, JSON.stringify(heap?.error));
      await writeFile(path.join(out, `${stage}-tauri-js-heap.json`), heap.snapshotStringData);
    } finally { await probe('close'); }
    await delay(500); await sample(`heap-${stage}-after-diagnostic-gc`);
  };
}
