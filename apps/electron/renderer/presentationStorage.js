// Renderer-owned visual preferences; protocol data stays in the runtime store.
export const presentationStorage = {
  getItem: key => window.localStorage.getItem(key),
  setItem: (key, value) => window.localStorage.setItem(key, value),
};
