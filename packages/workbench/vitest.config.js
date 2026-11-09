import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    environment: 'jsdom',
    include: ['tests/components/*.test.js'],
    restoreMocks: true,
    setupFiles: ['tests/components/setup.js'],
  },
});
