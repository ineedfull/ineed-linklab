import { DEFAULT_SETTINGS, normalizeSettings } from './secondaryViews.js';
import { mutateSettings } from './settingsMutation.js';

export function createUiPreferences(runtime, {
  root = document.documentElement,
  matchMedia = (query) => window.matchMedia(query),
} = {}) {
  const media = safeMatchMedia(matchMedia);
  const listeners = new Set();
  const state = {
    ready: false,
    values: { ...DEFAULT_SETTINGS },
    resolvedTheme: media.matches ? 'dark' : 'light',
    settingsRevision: 0,
    error: '',
  };
  let preferenceSequence = 0;
  let disposed = false;

  root.classList.add('ui-preferences-loading');
  applyRoot();

  function notify() {
    for (const listener of [...listeners]) listener(state);
  }

  function apply(values) {
    state.values = normalizeSettings(values);
    state.settingsRevision += 1;
    state.resolvedTheme = state.values.theme === 'system'
      ? (media.matches ? 'dark' : 'light')
      : state.values.theme;
    applyRoot();
    notify();
  }

  function applyRoot() {
    root.dataset.theme = state.resolvedTheme;
    root.dataset.themeMode = state.values.theme;
    root.classList.toggle('large-font', state.values.largeFont);
  }

  function onSystemThemeChange(event) {
    if (disposed || state.values.theme !== 'system') return;
    state.resolvedTheme = event.matches ? 'dark' : 'light';
    applyRoot();
    notify();
  }
  media.addEventListener('change', onSystemThemeChange);

  async function reload() {
    const sequence = ++preferenceSequence;
    if (sequence === preferenceSequence) state.error = '';
    try {
      const values = normalizeSettings(await runtime.settings.getAll());
      if (!disposed && sequence === preferenceSequence) {
        apply(values);
        state.ready = true;
        root.classList.remove('ui-preferences-loading');
        notify();
      }
      return values;
    } catch (error) {
      if (!disposed && sequence === preferenceSequence) {
        state.error = error instanceof Error ? error.message : String(error);
        state.ready = true;
        root.classList.remove('ui-preferences-loading');
        notify();
      }
      throw error;
    }
  }

  return {
    state,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    load: reload,
    reload,
    async save(nextValues) {
      const sequence = ++preferenceSequence;
      // STOMP saves its own profiles independently of appearance preferences.
      // Read them at save time so an older settings dialog cannot erase them.
      const next = await mutateSettings(runtime, async () => {
        const current = await runtime.settings.getAll();
        const values = normalizeSettings({ ...current, ...nextValues, stompProfiles: current.stompProfiles ?? [], acceptanceWorkspace: current.acceptanceWorkspace ?? DEFAULT_SETTINGS.acceptanceWorkspace });
        await runtime.settings.saveAll(values);
        return values;
      });
      if (!disposed && sequence === preferenceSequence) apply(next);
      return next;
    },
    dispose() {
      disposed = true;
      listeners.clear();
      media.removeEventListener('change', onSystemThemeChange);
    },
  };
}

function safeMatchMedia(matchMedia) {
  try {
    const media = matchMedia?.('(prefers-color-scheme: dark)');
    if (media && typeof media.matches === 'boolean'
      && typeof media.addEventListener === 'function'
      && typeof media.removeEventListener === 'function') return media;
  } catch {
    // The renderer may not expose matchMedia in tests or early startup.
  }
  return {
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  };
}
