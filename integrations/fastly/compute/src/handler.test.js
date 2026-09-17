"use strict";

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
// Imported through Vitest rather than createRequire(): a native require() bypasses Vite's
// transform, so istanbul never instruments handler.js and coverage reports 0% even though
// these tests do exercise it.
import { handleRequest } from "./handler";

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeRequest(path = "/", { body = "", headers = {} } = {}) {
  return {
    url: `https://example.com${path}`,
    headers: { get: (name) => headers[name.toLowerCase()] ?? null },
    text: async () => body,
  };
}

// ── Test setup ────────────────────────────────────────────────────────────────

let fetchMock;

beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

// ─────────────────────────────────────────────────────────────────────────────
// Non-captcha paths — pass-through (RTI handled by VCL)
// ─────────────────────────────────────────────────────────────────────────────

describe("non-captcha paths", () => {
  test("returns 200", async () => {
    const res = await handleRequest(makeRequest("/"));
    expect(res.status).toBe(200);
  });

  test("does not call fetch", async () => {
    await handleRequest(makeRequest("/some/page"));
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /validate/<site_key> — reCAPTCHA v2 verification
// ─────────────────────────────────────────────────────────────────────────────

describe("/validate/<site_key> (reCAPTCHA v2 verification)", () => {
  test("returns 302 + Location + Set-Cookie on success", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", {
        body: "g-recaptcha-response=valid-token",
        headers: { origurl: "/protected-page" },
      })
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/protected-page");
    expect(res.headers.get("Set-Cookie")).toContain("captchaAuth=1");
  });

  test("returns 200 + captchaFail: 1 on failed verification", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: false }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=bad-token" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("captchaFail")).toBe("1");
  });

  test("fails open (no captchaFail) when fetch throws", async () => {
    fetchMock.mockRejectedValueOnce(new Error("network error"));

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=token" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("captchaFail")).toBeNull();
  });

  test("redirects to / when origurl header is absent", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=token" })
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  test("POSTs to Google siteverify with secret and token", async () => {
    fetchMock.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=my-token" })
    );

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://www.google.com/recaptcha/api/siteverify");
    expect(options.method).toBe("POST");
    expect(options.body).toContain("response=my-token");
    expect(options.body).toContain("secret=test-secret");
  });
});

describe("debug logging", () => {
  // handler.js gates four console.log calls behind `debugging_enabled`. Without a test that
  // turns it on, those branches never execute - which is what held branch coverage at 60%.
  afterEach(() => {
    delete globalThis.__CHEQ_TEST_DEBUG__;
  });

  test("logs the verify flow when debugging_enabled is true", async () => {
    globalThis.__CHEQ_TEST_DEBUG__ = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ success: true }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", {
        body: "g-recaptcha-response=valid-token",
        headers: { origurl: "/protected-page" },
      })
    );

    expect(res.status).toBe(302);
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(logged).toContain("token_present=true");
    expect(logged).toContain("siteverify_status=200");
    expect(logged).toContain("result=success");
    logSpy.mockRestore();
  });

  test("logs the failure path when debugging_enabled is true", async () => {
    globalThis.__CHEQ_TEST_DEBUG__ = "true";
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ success: false, "error-codes": ["invalid-input-response"] }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=bad-token" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("captchaFail")).toBe("1");
    const logged = logSpy.mock.calls.map((c) => String(c[0])).join(" | ");
    expect(logged).toContain("result=failure");
    expect(logged).toContain("invalid-input-response");
    logSpy.mockRestore();
  });

  test("stays silent when debugging_enabled is not set", async () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ success: true }) });

    await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=valid-token" })
    );

    expect(logSpy).not.toHaveBeenCalled();
    logSpy.mockRestore();
  });
});

describe("missing inputs", () => {
  afterEach(() => {
    delete globalThis.__CHEQ_TEST_SECRET__;
  });

  test("treats a body with no g-recaptcha-response as an empty token", async () => {
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ success: false }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "some-other-field=x" })
    );

    // Empty token is still sent to Google, which rejects it -> captchaFail, not a crash
    expect(res.status).toBe(200);
    expect(res.headers.get("captchaFail")).toBe("1");
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("response=");
  });

  test("still calls siteverify when the config store has no secret", async () => {
    globalThis.__CHEQ_TEST_SECRET__ = "";
    fetchMock.mockResolvedValueOnce({ status: 200, json: async () => ({ success: false }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=tok" })
    );

    // Google rejects a blank secret; the handler must surface that as captchaFail rather than throw
    expect(res.status).toBe(200);
    expect(String(fetchMock.mock.calls[0][1].body)).toContain("secret=&");
  });
});
