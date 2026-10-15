import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Never read or write the real macOS Keychain from a test.
  test: { env: { MUSIC_WAREHOUSE_KEYCHAIN: 'off' } },
});
