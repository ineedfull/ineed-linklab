import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = fileURLToPath(new URL('..', import.meta.url));

// Cargo still owns building and Tauri still owns watching. Its target runner
// wraps only the executable after a successful build, including soak overrides.
export function tauriDevArguments(args = []) {
  if (process.platform !== 'darwin') return ['dev', ...args];
  const separator = args.indexOf('--');
  const options = separator < 0 ? args : args.slice(0, separator);
  const cargoArgs = separator < 0 ? [] : args.slice(separator + 1);
  const runner = JSON.stringify([process.execPath, path.join(root, 'scripts/tauri-app-runner.mjs')]);
  const configs = ['aarch64-apple-darwin', 'x86_64-apple-darwin']
    .map(target => `--config=target.${target}.runner=${runner}`);
  return ['dev', ...options, '--', ...configs, ...cargoArgs];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const child = spawn(process.execPath, [require.resolve('@tauri-apps/cli/tauri.js'), ...tauriDevArguments(process.argv.slice(2))], {
    cwd: path.join(root, 'apps/tauri'), stdio: 'inherit',
  });
  for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill(signal));
  child.on('error', error => { console.error(error); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}
