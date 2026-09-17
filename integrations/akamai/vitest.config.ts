import { defineConfig } from 'vitest/config';
import path from 'node:path';

// Akamai's built-in modules (`crypto`, `encoding`, `url-search-params`) do not exist on Node,
// so the suite maps them onto Node's real implementations. Aliasing rather than vi.mock()ing
// keeps the behaviour genuine - real SHA-256, real query parsing - so these tests still catch
// a wrong digest or a mis-parsed token, and any new source file that imports them just works.
//
// The source MUST import them. Used as bare globals they type-check (tsconfig pulls in the
// "dom" lib) and pass every test here, because Node has all three as globals - then throw
// ReferenceError on the edge, where main.ts's CAPTCHA catch swallows it and every challenge
// silently falls through to ALLOW. src/challenge-signing.spec.ts pins the imports.
const shim = (name: string) => path.resolve(__dirname, 'test-shims', `${name}.ts`);

export default defineConfig({
  resolve: {
    alias: [
      { find: /^crypto$/, replacement: shim('crypto') },
      { find: /^encoding$/, replacement: shim('encoding') },
      { find: /^url-search-params$/, replacement: shim('url-search-params') },
    ],
  },
  test: {
    coverage: {
      provider: 'istanbul',
      exclude: ['test-shims/**'],
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
