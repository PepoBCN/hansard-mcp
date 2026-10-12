import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // Contract tests hit the live APIs; they run nightly via test:contract.
    exclude: ['test/contract/**'],
    environment: 'node',
    testTimeout: 20_000,
  },
});
