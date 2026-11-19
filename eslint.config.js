// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  { ignores: ['dist/*', '.expo/*'] },
  // Privacy: the app must never log (passphrases, keys and financial text could end up in logs).
  { files: ['src/**/*.{ts,tsx}'], rules: { 'no-console': 'error' } },
]);
