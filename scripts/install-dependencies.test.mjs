import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  ELECTRON_BUILDER_BINARIES_MIRROR,
  ELECTRON_MIRROR,
  installDependencies,
} from './install-dependencies.mjs';

test('launches a Windows npm CLI through the injected Node executable without a shell', async () => {
  const calls = [];
  const spawn = (...args) => {
    calls.push(args);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0, null));
    return child;
  };

  await installDependencies({
    execPath: 'C:\\Program Files\\nodejs\\node.exe',
    env: {
      PATH: 'C:\\npm',
      CUSTOM_ENV: 'kept',
      npm_execpath: 'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    },
    spawn,
  });

  assert.equal(calls.length, 1);
  const [command, args, options] = calls[0];
  assert.equal(command, 'C:\\Program Files\\nodejs\\node.exe');
  assert.deepEqual(args, [
    'C:\\npm\\node_modules\\npm\\bin\\npm-cli.js',
    'install',
  ]);
  assert.notEqual(command, 'npm.cmd');
  assert.notEqual(command, 'cmd.exe');
  assert.equal(options.shell, false);
  assert.equal(options.stdio, 'inherit');
  assert.equal(options.env.PATH, 'C:\\npm');
  assert.equal(options.env.CUSTOM_ENV, 'kept');
  assert.equal(options.env.ELECTRON_MIRROR, ELECTRON_MIRROR);
  assert.equal(
    options.env.ELECTRON_BUILDER_BINARIES_MIRROR,
    ELECTRON_BUILDER_BINARIES_MIRROR,
  );
});

test('runs a fake npm CLI in a real Node child process with install mirrors', async () => {
  const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ineed-bootstrap-'));
  const npmExecPath = join(temporaryDirectory, 'fake-npm-cli.mjs');
  const resultPath = join(temporaryDirectory, 'result.json');

  try {
    await writeFile(npmExecPath, `
      import { writeFile } from 'node:fs/promises';

      await writeFile(process.env.FAKE_NPM_RESULT, JSON.stringify({
        argv: process.argv.slice(2),
        electronMirror: process.env.ELECTRON_MIRROR,
        electronBuilderBinariesMirror: process.env.ELECTRON_BUILDER_BINARIES_MIRROR,
      }));
    `, 'utf8');

    await installDependencies({
      execPath: process.execPath,
      env: {
        ...process.env,
        PATH: temporaryDirectory,
        FAKE_NPM_RESULT: resultPath,
        npm_execpath: npmExecPath,
      },
    });

    const result = JSON.parse(await readFile(resultPath, 'utf8'));
    assert.deepEqual(result.argv, ['install']);
    assert.equal(result.electronMirror, ELECTRON_MIRROR);
    assert.equal(
      result.electronBuilderBinariesMirror,
      ELECTRON_BUILDER_BINARIES_MIRROR,
    );
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
});

test('rejects when npm_execpath is missing and directs callers to bootstrap', async () => {
  let attempts = 0;

  await assert.rejects(
    installDependencies({
      execPath: '/custom/node',
      env: {},
      spawn: () => {
        attempts += 1;
      },
    }),
    /npm_execpath.*npm run bootstrap/,
  );
  assert.equal(attempts, 0);
});

test('rejects a failed npm install with its non-zero exit code', async () => {
  const spawn = (command, args) => {
    assert.equal(command, '/custom/node');
    assert.deepEqual(args, ['/custom/npm-cli.js', 'install']);
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 17, null));
    return child;
  };

  await assert.rejects(
    installDependencies({
      execPath: '/custom/node',
      env: { npm_execpath: '/custom/npm-cli.js' },
      spawn,
    }),
    /npm install exited with code 17/,
  );
});

test('rejects a terminated npm install with its signal', async () => {
  const spawn = () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', null, 'SIGTERM'));
    return child;
  };

  await assert.rejects(
    installDependencies({
      execPath: '/custom/node',
      env: { npm_execpath: '/custom/npm-cli.js' },
      spawn,
    }),
    /npm install terminated by signal SIGTERM/,
  );
});

test('propagates spawn errors without retrying', async () => {
  let attempts = 0;
  const spawn = () => {
    attempts += 1;
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('error', new Error('spawn unavailable')));
    return child;
  };

  await assert.rejects(
    installDependencies({
      execPath: '/custom/node',
      env: { npm_execpath: '/custom/npm-cli.js' },
      spawn,
    }),
    /spawn unavailable/,
  );
  assert.equal(attempts, 1);
});

test('repository scripts lock mirror installs and bundled Playwright Chromium', async () => {
  const rootPackage = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  const packageLock = JSON.parse(await readFile(new URL('../package-lock.json', import.meta.url), 'utf8'));
  const workbenchPackage = JSON.parse(await readFile(
    new URL('../packages/workbench/package.json', import.meta.url),
    'utf8',
  ));
  const npmrc = await readFile(new URL('../.npmrc', import.meta.url), 'utf8');
  const playwrightConfig = await readFile(
    new URL('../packages/workbench/playwright.config.js', import.meta.url),
    'utf8',
  );

  assert.equal(npmrc, 'registry=https://registry.npmmirror.com/\n');
  assert.equal(rootPackage.scripts.bootstrap, 'npm run install:deps');
  assert.equal(rootPackage.scripts['install:deps'], 'node scripts/install-dependencies.mjs');
  assert.equal(rootPackage.scripts['test:e2e'], 'npm run test:e2e -w @ineed-linklab/workbench');
  assert.match(rootPackage.scripts['verify:phase-02'], /npm test/);
  assert.match(rootPackage.scripts['verify:phase-02'], /cargo test/);
  assert.match(rootPackage.scripts['verify:phase-02'], /git diff --check/);
  assert.equal(workbenchPackage.devDependencies['@playwright/test'], '^1.55.0');
  assert.equal(packageLock.packages['node_modules/@playwright/test'].version, '1.61.1');
  assert.equal(packageLock.packages['node_modules/playwright-core'].version, '1.61.1');
  assert.equal(workbenchPackage.devDependencies.pixelmatch, '7.1.0');
  assert.equal(workbenchPackage.devDependencies.pngjs, '7.0.0');
  assert.match(workbenchPackage.scripts['install:chromium'], /playwright install chromium --no-shell$/);
  assert.match(playwrightConfig, /channel:\s*['"]chromium['"]/);
  assert.doesNotMatch(playwrightConfig, /channel:\s*['"]chrome['"]/);
});
