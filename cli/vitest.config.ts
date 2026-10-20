import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // The fixtures sit inside vdx's own clone, and its origin is on GitHub: no test asks the hosting.
    env: { VDX_OFFLINE: '1' },
    // Many tests start real processes — git, the CLI, the plugin's hook, npm. On lft at a
    // load of ~10 (2026-10-19) doctor's and the plugin hook's took past vitest's 5 s.
    testTimeout: 20_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/mcp-server.ts', 'src/index.ts', 'src/init.ts'],
    },
  },
});
