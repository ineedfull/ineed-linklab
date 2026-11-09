import { defineConfig } from '@playwright/test';
import base from './playwright.config.js';

const use = { ...base.use };
delete use.channel;

export default defineConfig({
  ...base,
  use,
  testMatch: ['about.spec.js', 'modalKeyboard.spec.js'],
  projects: [
    { name: 'chromium-keyboard', use: { browserName: 'chromium', channel: 'chromium' } },
    { name: 'webkit-keyboard', use: { browserName: 'webkit' } },
  ],
});
