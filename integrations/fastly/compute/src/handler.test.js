"use strict";

// Mock fastly:config-store (not available in Node.js/Jest environment).
// Returns "test-secret" for any key lookup.
jest.mock("fastly:config-store", () => ({
  ConfigStore: jest.fn().mockImplementation(() => ({
    get: jest.fn().mockReturnValue("test-secret"),
  })),
}), { virtual: true });

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

beforeEach(() => {
  global.fetch = jest.fn();
});

afterEach(() => {
  jest.clearAllMocks();
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
    expect(global.fetch).not.toHaveBeenCalled();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// /validate/<site_key> — reCAPTCHA v2 verification
// ─────────────────────────────────────────────────────────────────────────────

describe("/validate/<site_key> (reCAPTCHA v2 verification)", () => {
  test("returns 302 + Location + Set-Cookie on success", async () => {
    global.fetch.mockResolvedValueOnce({ json: async () => ({ success: true }) });

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
    global.fetch.mockResolvedValueOnce({ json: async () => ({ success: false }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=bad-token" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("captchaFail")).toBe("1");
  });

  test("fails open (no captchaFail) when fetch throws", async () => {
    global.fetch.mockRejectedValueOnce(new Error("network error"));

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=token" })
    );

    expect(res.status).toBe(200);
    expect(res.headers.get("captchaFail")).toBeNull();
  });

  test("redirects to / when origurl header is absent", async () => {
    global.fetch.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    const res = await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=token" })
    );

    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/");
  });

  test("POSTs to Google siteverify with secret and token", async () => {
    global.fetch.mockResolvedValueOnce({ json: async () => ({ success: true }) });

    await handleRequest(
      makeRequest("/validate/my-site-key", { body: "g-recaptcha-response=my-token" })
    );

    const [url, options] = global.fetch.mock.calls[0];
    expect(url).toBe("https://www.google.com/recaptcha/api/siteverify");
    expect(options.method).toBe("POST");
    expect(options.body).toContain("response=my-token");
    expect(options.body).toContain("secret=test-secret");
  });
});
