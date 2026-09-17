// Stands in for Akamai's built-in `encoding` module on Node. Real implementations, not stubs.
// Akamai's `text-encode-transform` module provides only the *Stream* variants - the plain
// TextEncoder/TextDecoder live in `encoding`.
export const TextEncoder = globalThis.TextEncoder;
export const TextDecoder = globalThis.TextDecoder;
