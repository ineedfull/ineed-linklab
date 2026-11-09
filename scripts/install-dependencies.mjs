import { spawn as nodeSpawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
export const ELECTRON_BUILDER_BINARIES_MIRROR = 'https://npmmirror.com/mirrors/electron-builder-binaries/';

export function installDependencies({
  execPath = process.execPath,
  env = process.env,
  spawn = nodeSpawn,
} = {}) {
  const npmExecPath = env.npm_execpath;
  if (!npmExecPath) {
    return Promise.reject(new Error(
      'Missing npm_execpath; run this installer through `npm run bootstrap`.',
    ));
  }

  const options = {
    env: {
      ...env,
      ELECTRON_MIRROR,
      ELECTRON_BUILDER_BINARIES_MIRROR,
    },
    shell: false,
    stdio: 'inherit',
  };

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(execPath, [npmExecPath, 'install'], options);
    } catch (error) {
      reject(error);
      return;
    }
    child.once('error', reject);
    child.once('close', (code, signal) => {
      if (code === 0) resolve();
      else if (signal) reject(new Error(`npm install terminated by signal ${signal}`));
      else reject(new Error(`npm install exited with code ${code}`));
    });
  });
}

const isMain = process.argv[1]
  && pathToFileURL(process.argv[1]).href === import.meta.url;

if (isMain) {
  installDependencies().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
