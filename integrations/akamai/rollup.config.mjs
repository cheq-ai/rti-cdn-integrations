// Bundler configuration for the Akamai EdgeWorker integration.
//
// Akamai EdgeWorkers require a single main.js file — they can't install npm packages at runtime.
// Rollup takes all TypeScript source files + the shared core/ code and combines them into one
// self-contained JS file ready for upload to Akamai.
//
// src/main.ts ──┐
// src/config.ts ─┤  Rollup  →  dist/main.js  (one file, ready for Akamai)
// core/helpers/ ─┘
//
// The 'external' list contains Akamai's own built-in runtime modules — Rollup leaves those
// import statements as-is instead of trying to bundle them.
import typescript from '@rollup/plugin-typescript';

export default {
    input: 'src/main.ts',
    output: {
        file: 'dist/main.js',
        format: 'es',
    },
    // Akamai built-in modules — available at runtime, must NOT be bundled
    external: ['http-request', 'cookies', 'log'],
    plugins: [
        typescript({
            tsconfig: './tsconfig.json',
            include: ['src/**/*.ts', '../core/**/*.ts'],
            compilerOptions: { noEmit: false, declaration: false },
        }),
    ],
};
