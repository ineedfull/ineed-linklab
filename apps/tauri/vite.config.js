import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  plugins: [vue()],
  server: {
    host: '127.0.0.1',
    port: 5174,
    strictPort: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rolldownOptions: {
      output: {
        codeSplitting: {
          groups: [
            { name: 'vue-runtime', test: /node_modules[\\/](?:@vue|vue)[\\/]/ },
            { name: 'code-editor', test: /node_modules[\\/](?:@codemirror|@lezer|codemirror)[\\/]/ },
            { name: 'chart-renderer', test: /node_modules[\\/]zrender[\\/]/ },
          ],
        },
      },
    },
  },
});
