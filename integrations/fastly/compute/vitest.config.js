import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./vitest.setup.js'],
    coverage: {
      provider: 'istanbul',
      thresholds: {
        // Per-file, not just the project average, so one weak file cannot hide behind the rest.
        perFile: true,
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
