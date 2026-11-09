const path = require('node:path');
const { existsSync } = require('node:fs');

// Branding must not hide an existing DevTool workspace or its Chromium preferences.
function preserveLegacyUserData(app) {
  if (typeof app.getPath !== 'function' || typeof app.setPath !== 'function') return;
  const appData = app.getPath('appData');
  const current = app.getPath('userData');
  const defaults = [
    ['Ineed LinkLab', ['Ineed DevTool', '@ineed-linklab/electron', '@ineed-dev-tool/electron']],
    ['@ineed-linklab/electron', ['@ineed-dev-tool/electron']],
  ];
  const previous = defaults.find(([name]) => current === path.join(appData, name));
  if (!previous) return; // Respect explicit userData overrides, including acceptance profiles.
  const database = 'ineed-dev-tool.db';
  if (existsSync(path.join(current, database))) return;
  // The named .app must also retain a workspace first created with `electron .`.
  const legacy = previous[1].map(name => path.join(appData, name))
    .find(directory => existsSync(path.join(directory, database)));
  if (!legacy) return;
  const sessionData = app.getPath('sessionData');
  app.setPath('userData', legacy);
  if (sessionData === current) app.setPath('sessionData', legacy);
}

module.exports = { preserveLegacyUserData };
