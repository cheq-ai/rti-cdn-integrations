"use strict";

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { handleRequest } = require("./handler");

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
