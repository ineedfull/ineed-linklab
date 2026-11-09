import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));

export async function prepareTauriExecutable(binary) {
  if (process.platform !== 'darwin') return binary;
  const source = path.join(root, 'apps/tauri/src-tauri');
  const config = JSON.parse(await readFile(path.join(source, 'tauri.conf.json'), 'utf8'));
  const override = JSON.parse(process.env.TAURI_CONFIG || '{}');
  const identifier = override.identifier ?? config.identifier;
  const name = config.productName;
  const version = override.version ?? config.version;
  const executableName = path.basename(binary);
  const bundle = path.join(root, 'artifacts/tauri-dev', identifier, `${name}.app`);
  const contents = path.join(bundle, 'Contents');
  await mkdir(path.join(contents, 'MacOS'), { recursive: true });
  await mkdir(path.join(contents, 'Resources'), { recursive: true });
  const executable = path.join(contents, 'MacOS', executableName);
  await copyFile(binary, executable);
  await copyFile(path.join(source, 'icons/icon.icns'), path.join(contents, 'Resources/icon.icns'));
  const entries = {
    CFBundleExecutable: executableName,
    CFBundleName: name,
    CFBundleDisplayName: name,
    CFBundleIdentifier: identifier,
    CFBundlePackageType: 'APPL',
    CFBundleVersion: version,
    CFBundleShortVersionString: version,
    CFBundleIconFile: 'icon.icns',
    NSHighResolutionCapable: true,
  };
  const xml = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  const values = Object.entries(entries).map(([key, value]) => `<key>${key}</key>${typeof value === 'boolean' ? '<true/>' : `<string>${xml(value)}</string>`}`).join('\n');
  await writeFile(path.join(contents, 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>\n<plist version="1.0"><dict>${values}</dict></plist>\n`);
  execFileSync('codesign', ['--force', '--sign', '-', bundle], { stdio: 'pipe' });
  execFileSync('codesign', ['--verify', '--strict', bundle], { stdio: 'pipe' });
  return executable;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (typeof process.execve !== 'function') throw new Error('The macOS Tauri development runner requires Node.js 22.15+');
  const [binary, ...args] = process.argv.slice(2);
  if (!binary) throw new Error('Cargo did not provide the application executable');
  const executable = await prepareTauriExecutable(binary);
  // Replace the runner process so Cargo/Tauri can stop the real window during
  // hot reload. A detached child here would survive and leave duplicate apps.
  process.execve(executable, [executable, ...args], process.env);
}
