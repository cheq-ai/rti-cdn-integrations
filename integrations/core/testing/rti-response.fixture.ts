/**
 * Factory for constructing realistic `RTIResponse` objects in tests.
 *
 * ## Why this exists
 * A real RTI response has 15+ fields. Without a factory, every test that needs one either
 * copies the full structure (fragile, verbose) or asserts on fields it didn't set (brittle).
 * This factory provides safe defaults so each test only specifies what actually matters.
 *
 * ## Defaults (what you get when you pass no overrides)
 *   version:    '4.1'
 *   verdict:    'benign'   — benign, will not trigger block/redirect/challenge (valid options are 'benign', 'malicious', 'suspicious')
 *   code:       0
 *   rayId:      'ray-123'
 *   pageViewId: null
 *   reasons:    []        — empty, no reason-based actions triggered
 *   all other ids fields: null
 *
 * ## Usage examples
 *   buildRTIResponse()                          — benign request, ALLOW path
 *   buildRTIResponse({ verdict: 'malicious' })  — triggers BLOCK in BLOCKING mode
 *   buildRTIResponse({ code: 5 })              — triggers blockTTCodes match
 *   buildRTIResponse({ reasons: [2] })          — triggers blockReasons match
 *   buildRTIResponse({ version: '4.1', rayId: 'abc' }) — assert header format
 */
import type { RTIResponse, Ids } from '../models/rti-response.model';

export function buildRTIResponse(overrides: Partial<{
    rayId: string;
    pageViewId: string | null;
    verdict: 'benign' | 'suspicious' | 'malicious';
    code: number;
    version: string;
    reasons: number[];
}> = {}): Partial<RTIResponse> {
    const ids: Ids = {
        rayId: overrides.rayId ?? 'ray-123',
        pageViewId: overrides.pageViewId !== undefined ? overrides.pageViewId : null,
        duid: null,
        uniqueVisitId: null,
        customParam1: null,
        customParam2: null,
        customParam3: null,
        customParam4: null,
    };
    return {
        metadata: { version: overrides.version ?? '4.1' } as any,
        decision: { verdict: overrides.verdict ?? 'benign' } as any,
        classification: { code: overrides.code ?? 0 } as any,
        ids,
        cheqDetection: { reasons: overrides.reasons ?? [] } as any,
    };
}
