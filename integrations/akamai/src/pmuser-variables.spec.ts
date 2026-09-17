import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Akamai Property Manager refuses a variable whose NAME breaks either rule:
 *
 *   "Illegal name in Variable, only letters, digits and _ are allowed.
 *    Maximum number of characters: 32"
 *
 * The limit counts the whole name including the `PMUSER_` prefix the UI adds for you, so the
 * usable budget for our own part is 25 characters.
 *
 * This matters far more than it looks. An over-long name cannot be declared at all, so
 * `getVariable()` returns `undefined` for it on every request, forever - and every one of our
 * reads treats undefined as "not configured" and falls back silently. Three reCAPTCHA variables
 * shipped this way and were dead on arrival: nothing logged, nothing thrown, the feature simply
 * never turned on. Only trying to create one in the Property Manager UI surfaces it.
 *
 * Scanning the source rather than a hand-maintained list means a new variable is covered the
 * moment it is written, which is the only way this stays true.
 */
const AKAMAI_MAX_VARIABLE_NAME_LENGTH = 32;
const AKAMAI_LEGAL_VARIABLE_NAME = /^[A-Za-z0-9_]+$/;

const srcDir = fileURLToPath(new URL('.', import.meta.url));

const names = [...new Set(
    readdirSync(srcDir)
        .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'))
        .flatMap(f => [...readFileSync(join(srcDir, f), 'utf8').matchAll(/PMUSER_[A-Za-z0-9_]+/g)]
            .map(m => m[0])),
)].sort();

describe('PMUSER variable names are declarable in Property Manager', () => {
    it('scans the source and finds the variables', () => {
        // Guards the guard: a broken scan would make every assertion below vacuously pass.
        expect(names.length).toBeGreaterThan(20);
        expect(names).toContain('PMUSER_CHEQ_API_KEY');
    });

    it.each(names)('%s is within Akamai\'s 32-character limit', (name) => {
        expect(name.length).toBeLessThanOrEqual(AKAMAI_MAX_VARIABLE_NAME_LENGTH);
    });

    it.each(names)('%s uses only letters, digits and underscore', (name) => {
        expect(name).toMatch(AKAMAI_LEGAL_VARIABLE_NAME);
    });
});
