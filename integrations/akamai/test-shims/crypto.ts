// Stands in for Akamai's built-in `crypto` module when the suite runs on Node.
// Deliberately re-exports the REAL Web Crypto rather than a stub, so the signing tests
// exercise genuine SHA-256 and a wrong digest or truncation still fails the suite.
export const crypto = globalThis.crypto;
