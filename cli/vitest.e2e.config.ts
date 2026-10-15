import { defineConfig } from 'vitest/config';

// The packed package, installed into a temporary prefix — `npm run test:e2e`.
export default defineConfig({
  test: {
    include: ['tests/e2e/**/*.test.ts'],
    testTimeout: 30_000,
    // The fixtures sit inside vdx's own clone, and its origin is on GitHub: no test asks the hosting.
    env: { VDX_OFFLINE: '1' },
  },
});
