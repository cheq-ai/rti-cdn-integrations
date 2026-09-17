import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    coverage: {
      provider: 'istanbul',
      thresholds: {
        // Per-file, not just the project average. A global-only threshold lets a single
        // badly-covered file hide behind well-covered ones - which is how an untested
        // exported function shipped at 66% function coverage while the suite stayed green.
        perFile: true,
        statements: 95,
        branches: 90,
        functions: 95,
        lines: 95,
      },
    },
  },
});
