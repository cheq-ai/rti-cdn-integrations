// CHEQ RTI – Fastly Compute@Edge
//
// Handles CAPTCHA verification (reCAPTCHA v2).
// RTI is handled directly by the VCL service via X-Cheq-Param-* request
// headers — no translation layer needed here.
//
// Pure handler logic — no Fastly event registration here.
// index.js registers addEventListener and calls handleRequest.
// Tests import handleRequest directly from this file.

// Verifies a Google reCAPTCHA v2 token via the siteverify API.
// Returns 302 + Set-Cookie on success, 200 + captchaFail header on failure.
// VCL reads captchaFail in cheq_rti_backend_response and restarts to re-show challenge.
//
// Backend contract (replace this handler with any backend that satisfies the same contract):
//   Request:  POST /validate/<site_key>
//             Body:    application/x-www-form-urlencoded, field: g-recaptcha-response=<token>
//             Headers: origurl=<redirect target after success>
//   Success:  302  + Location: <origurl> + Set-Cookie: captchaAuth=1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900
//   Failure:  200  + captchaFail: 1
//   Error:    200  (fail open — avoids blocking legitimate users)
async function handleCaptchaVerify(request) {
  try {
    // Extract parameters from the request
    const body = await request.text();
    const params = new URLSearchParams(body);
    const token = params.get("g-recaptcha-response") || "";
    const origUrl = request.headers.get("origurl") || "/";

    // Extract secret key from secured storage (Fastly Edge Dictionary or Secret Store)
    const { ConfigStore } = require("fastly:config-store");
    const config = new ConfigStore("cheq_rti_config");
    const secret = config.get("recaptcha_secret_key") || "";
    const is_debug = config.get("debugging_enabled") === "true";

    if (is_debug) {
      console.log(`[cheq-rti] captcha_verify url=${request.url} token_present=${!!token} token_len=${token.length} origurl=${origUrl} captcha_verify secret_present=${!!secret}`);
    }

    // Verify the token with Google's reCAPTCHA API
    const verifyResponse = await fetch(
      "https://www.google.com/recaptcha/api/siteverify",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `secret=${encodeURIComponent(secret)}&response=${encodeURIComponent(token)}`,
        backend: "recaptcha_backend",
      }
    );

    // Process the verification response
    const result = await verifyResponse.json();
    
    if (is_debug) {
      console.log(`[cheq-rti] captcha_verify siteverify_status=${verifyResponse.status} success=${result.success} errors=${JSON.stringify(result["error-codes"] || [])}`);
    }

    if (result.success) {
      if (is_debug) {
            console.log(`[cheq-rti] captcha_verify result=success redirecting_to=${origUrl}`);
      }

      return new Response(null, {
        status: 302,
        headers: {
          "Location": origUrl,
          "Set-Cookie": "captchaAuth=1; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=900",
          "Cache-Control": "no-store",
        },
      });
    }

    if (is_debug) {
      console.log(`[cheq-rti] captcha_verify result=failure`);
    }
    
    return new Response(null, { status: 200, headers: { "captchaFail": "1" } });
  } catch (err) {
    
    console.log(`[cheq-rti] captcha_verify error ${err.message}`);
    // Fail open — avoid blocking legitimate users on verify errors
    return new Response(null, { status: 200 });
  }
}

async function handleRequest(request) {
  const url = new URL(request.url);
  
  if (url.pathname.startsWith("/validate/")) {
    return handleCaptchaVerify(request);
  }
  // RTI is handled directly by the VCL service via X-Cheq-Param-* headers.
  // All non-captcha requests pass through here and return 200.
  return new Response(null, { status: 200 });
}

module.exports = { handleRequest };
