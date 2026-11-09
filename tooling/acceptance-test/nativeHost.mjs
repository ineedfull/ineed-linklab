import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { prepareElectronExecutable } from '../../scripts/dev-electron.mjs';
import { tauriDevArguments } from '../../scripts/dev-tauri.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
const require = createRequire(import.meta.url);

async function stopProcessGroup(child) {
  try { process.kill(-child.pid, 'SIGTERM'); } catch { /* Already exited. */ }
  for (let attempt = 0; attempt < 100; attempt++) {
    try { process.kill(-child.pid, 0); }
    catch { return; }
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Native acceptance process group did not exit');
}

// The workload runs in the actual renderer with its real native bridge.
// Each invocation gets independent SQLite data and loopback-only test assets.
export async function runNativeAcceptance({ runtime, out, config, workload, timeoutMs = 240000, profilePath, identifier: reuseIdentifier, control }) {
  let app, child, server;
  const errors = [];
  try {
    if (runtime === 'electron') {
      const profile = profilePath ?? path.join(out, 'profile');
      await mkdir(profile, { recursive: true });
      await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ dataPath: profile }));
      const bootstrap = path.join(out, 'main.cjs');
      await writeFile(bootstrap, `const {app}=require('electron');app.setName('Ineed LinkLab');app.setPath('userData',${JSON.stringify(profile)});app.setPath('sessionData',${JSON.stringify(profile)});require(${JSON.stringify(path.join(root, 'apps/electron/electron/main.cjs'))});`);
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.VITE_DEV_SERVER_URL;
      app = await require('@playwright/test')._electron.launch({
        executablePath: await prepareElectronExecutable(), args: [bootstrap], env, timeout: 30000,
      });
      const page = await app.firstWindow();
      if (control) await page.exposeFunction('__linklabAcceptanceControl', control);
      await writeFile(path.join(out, 'host.json'), JSON.stringify({ runtime, pid: app.process().pid }));
      page.on('pageerror', error => errors.push(error.message));
      await app.evaluate(({ dialog }, directory) => {
        dialog.showSaveDialog = async (_window, options) => ({
          canceled: false, filePath: `${directory}/${options.defaultPath}`,
        });
      }, out);
      let timer;
      const deadline = new Promise((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('Electron acceptance deadline')), timeoutMs);
      });
      let result;
      const progressTimer = setInterval(async () => {
        try {
          const progress = await page.evaluate(() => globalThis.__linklabTemplateProgress);
          if (progress) {
            await writeFile(path.join(out, 'progress.json'), JSON.stringify(progress));
            await appendFile(path.join(out, 'progress.jsonl'), `${JSON.stringify(progress)}\n`);
          }
        } catch { /* Renderer may be reloading or closing. */ }
      }, 5000);
      try {
        result = await Promise.race([(async () => {
          const first = await page.evaluate(workload, { ...config, runtime });
          if (first.stage !== 'reload') return first;
          await page.reload();
          return page.evaluate(workload, { ...config, runtime, reloadOnly: true });
        })(), deadline]);
      } finally { clearTimeout(timer); clearInterval(progressTimer); }
      await page.screenshot({ path: path.join(out, 'desktop.png') });
      assert.deepEqual(errors, []);
      return result;
    }

    assert.equal(runtime, 'tauri');
    let finish;
    const completed = new Promise(resolve => { finish = resolve; });
    server = http.createServer(async (request, response) => {
      try {
        if (request.method === 'POST' && request.url === '/control' && control) {
          let body = '';
          for await (const bytes of request) {
            body += bytes;
            if (body.length > 1024) throw new Error('Oversized test control');
          }
          const value = await control(JSON.parse(body));
          response.setHeader('content-type', 'application/json');
          response.end(JSON.stringify(value)); return;
        }
        if (request.url.startsWith('/pause?')) {
          const ms = Number(new URL(request.url, 'http://127.0.0.1').searchParams.get('ms'));
          if (!Number.isFinite(ms) || ms < 0 || ms > 1000) throw new Error('Invalid test delay');
          setTimeout(() => response.end('ok'), ms); return;
        }
        if (request.method === 'POST' && request.url === '/progress') {
          let body = '';
          for await (const bytes of request) body += bytes;
          await writeFile(path.join(out, 'progress.json'), body);
          await appendFile(path.join(out, 'progress.jsonl'), `${body}\n`);
          response.end('ok'); return;
        }
        if (request.method === 'POST' && request.url === '/report') {
          let body = '';
          for await (const bytes of request) {
            body += bytes;
            if (body.length > 2 * 1024 * 1024) throw new Error('Oversized test report');
          }
          finish(JSON.parse(body)); response.end('ok'); return;
        }
        if (request.url === '/acceptance-test.js') {
          response.setHeader('content-type', 'application/javascript');
          response.end(`(${workload.toString()})({...${JSON.stringify({ ...config, runtime })},reloadOnly:sessionStorage.getItem('acceptance-reload')==='yes'}).then(result=>{if(result.stage==='reload'){sessionStorage.setItem('acceptance-reload','yes');location.reload();return;}return fetch('/report',{method:'POST',body:JSON.stringify(result)});}).catch(error=>fetch('/report',{method:'POST',body:JSON.stringify({passed:false,error:error.message,stack:error.stack})}));`);
          return;
        }
        const relative = new URL(request.url, 'http://127.0.0.1').pathname;
        if (relative.includes('..') || relative.includes('\\')) throw new Error('Invalid asset path');
        const filename = relative === '/' ? 'index.html' : relative.slice(1);
        let content = await readFile(path.join(root, 'apps/tauri/dist', filename));
        if (filename === 'index.html') content = Buffer.from(content.toString().replace('</body>', '<script type="module" src="/acceptance-test.js"></script></body>'));
        response.setHeader('content-type', filename.endsWith('.js') ? 'application/javascript' : filename.endsWith('.css') ? 'text/css' : filename.endsWith('.svg') ? 'image/svg+xml' : 'text/html');
        response.end(content);
      } catch (error) { response.statusCode = 404; response.end(error.message); }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const url = `http://127.0.0.1:${server.address().port}`;
    const identifier = reuseIdentifier ?? `com.ineedfull.linklab.acceptancetest${Date.now()}`;
    const override = path.join(out, 'tauri-config.json');
    await writeFile(override, JSON.stringify({ identifier, build: { beforeDevCommand: '', devUrl: url },
      app: { security: { devCsp: `default-src 'self'; connect-src 'self' ipc: http://ipc.localhost ${url}; img-src 'self' asset: http://asset.localhost data:; style-src 'self' 'unsafe-inline'; script-src 'self'` } } }));
    await writeFile(path.join(out, 'isolation.json'), JSON.stringify({ identifier, url,
      dataPath: path.join(process.env.HOME, 'Library/Application Support', identifier) }));
    child = spawn(path.join(root, 'node_modules/.bin/tauri'), tauriDevArguments(['--no-watch', '--config', override]), {
      cwd: path.join(root, 'apps/tauri'), stdio: ['ignore', 'pipe', 'pipe'], detached: true,
    });
    await writeFile(path.join(out, 'host.json'), JSON.stringify({ runtime, pid: child.pid }));
    const logs = [];
    for (const stream of [child.stdout, child.stderr]) stream.on('data', bytes => { logs.push(bytes); process.stdout.write(bytes); });
    child.on('error', error => finish({ passed: false, error: error.message }));
    child.on('exit', code => finish({ passed: false, error: `Tauri exited before acceptance: ${code}` }));
    const timer = setTimeout(() => finish({ passed: false, error: 'Tauri acceptance deadline' }), timeoutMs);
    try { return await completed; }
    finally { clearTimeout(timer); await writeFile(path.join(out, 'tauri.log'), Buffer.concat(logs)); }
  } finally {
    await app?.close();
    if (child) await stopProcessGroup(child);
    if (server) await new Promise(resolve => server.close(resolve));
  }
}
