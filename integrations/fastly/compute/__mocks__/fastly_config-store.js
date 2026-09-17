"use strict";

// Test double for Fastly's `fastly:config-store`. Resolved via the Module._resolveFilename
// patch in vitest.setup.js.
//
// `get` is key-aware so handler.js's debug branches are reachable: `debugging_enabled` is read
// from globalThis, defaulting to "false" to match production. Set
// globalThis.__CHEQ_TEST_DEBUG__ = "true" in a test to exercise the debug-logging paths.
const ConfigStore = function () {
  return {
    get: (key) =>
      key === "debugging_enabled"
        ? (globalThis.__CHEQ_TEST_DEBUG__ ?? "false")
        : (globalThis.__CHEQ_TEST_SECRET__ ?? "test-secret"),
  };
};

module.exports = { ConfigStore };
