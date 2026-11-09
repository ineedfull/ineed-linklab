import { defineConfig } from '@playwright/test';

const viewports = [
  { name: 'desktop-1440x900', width: 1440, height: 900 },
  { name: 'compact-1120x720', width: 1120, height: 720 },
  { name: 'portrait-820x1180', width: 820, height: 1180 },
];

export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: false,
  workers: 1,
  reporter: 'line',
  timeout: 60_000,
  expect: { timeout: 5_000 },
  use: {
    channel: 'chromium',
    colorScheme: 'light',
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    reducedMotion: 'reduce',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: viewports.map(({ name, width, height }) => ({
    name,
    use: { viewport: { width, height } },
  })),
  webServer: [
    {
      command: 'npx vite apps/electron --config apps/electron/vite.config.js --host 127.0.0.1 --port 4173 --strictPort',
      cwd: '../..',
      url: 'http://127.0.0.1:4173',
      reuseExistingServer: false,
    },
    {
      command: 'npx vite apps/tauri --config apps/tauri/vite.config.js --host 127.0.0.1 --port 4174 --strictPort',
      cwd: '../..',
      url: 'http://127.0.0.1:4174',
      reuseExistingServer: false,
    },
  ],
});
