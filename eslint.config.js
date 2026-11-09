import js from '@eslint/js';
import vue from 'eslint-plugin-vue';
import globals from 'globals';

export default [
  {
    ignores: [
      '**/dist/**',
      '**/target/**',
      '**/gen/**',
      '**/node_modules/**',
      '**/release/**',
    ],
  },
  js.configs.recommended,
  ...vue.configs['flat/recommended'],
  {
    files: [
      'eslint.config.js',
      'apps/*/vite.config.js',
      'apps/*/tests/**/*.js',
      'apps/*/src-tauri/tests/**/*.mjs',
      'packages/persistence-contract/src/**/*.js',
      'packages/workbench/e2e/**/*.js',
      'packages/*/tests/**/*.js',
      'scripts/**/*.js',
      'scripts/**/*.mjs',
      'tooling/**/*.mjs',
    ],
    languageOptions: {
      globals: globals.node,
    },
  },
  {
    files: [
      'apps/electron/electron/**/*.cjs',
      'tooling/**/*.cjs',
    ],
    languageOptions: {
      sourceType: 'commonjs',
      globals: globals.node,
    },
  },
  {
    files: [
      'apps/*/renderer/**/*.js',
      'packages/workbench/tests/components/**/*.js',
      'packages/workbench/src/**/*.js',
      'packages/workbench/src/**/*.vue',
    ],
    languageOptions: {
      globals: globals.browser,
    },
  },
];
