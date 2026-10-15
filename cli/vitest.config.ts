import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/unit/**/*.test.ts'],
    // The fixtures sit inside vdx's own clone, and its origin is on GitHub: no test asks the hosting.
    env: { VDX_OFFLINE: '1' },
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/mcp-server.ts', 'src/index.ts', 'src/init.ts'],
    },
  },
});
