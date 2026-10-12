import { defineConfig } from 'vitest/config';

/** Live-network contract tests. Nightly, not on every push. */
export default defineConfig({
  test: {
    include: ['test/contract/**/*.contract.test.ts'],
    environment: 'node',
    testTimeout: 180_000,
    retry: 1,
  },
});
