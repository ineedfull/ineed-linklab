class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver ??= ResizeObserverStub;
window.matchMedia ??= () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});

if (!Range.prototype.getClientRects) {
  Range.prototype.getClientRects = () => [];
}
if (!Range.prototype.getBoundingClientRect) {
  Range.prototype.getBoundingClientRect = () => ({
    bottom: 0, height: 0, left: 0, right: 0, top: 0, width: 0,
  });
}

// Node 26 exposes a disabled host localStorage; give renderer tests a window-local store.
const browserStorage = new Map();
Object.defineProperty(globalThis.window, 'localStorage', {
  configurable: true,
  value: {
    getItem: key => browserStorage.get(String(key)) ?? null,
    setItem: (key, value) => browserStorage.set(String(key), String(value)),
    removeItem: key => browserStorage.delete(String(key)),
    clear: () => browserStorage.clear(),
  },
});
