# ==============================================================================
# CHEQ RTI – Fastly VCL Integration
# ==============================================================================
# How to use
# ----------
# 1. Declare the cheq_rti_backend in your service configuration (see below).
# 2. Copy or #include this file into your custom VCL.
# 3. Call the CHEQ subroutines from each corresponding Fastly lifecycle hook
#    (see example_main.vcl for the wiring pattern).
#
# How it works (restart pattern)
# --------------------------------
#  restart 0:
#    vcl_recv          → routes request to RTI backend (Compute@Edge or dedicated endpoint)
#    vcl_pass          → bereq sent to RTI backend
#    [RTI backend responds with X-Cheq-Verdict / X-Cheq-TT-Code headers]
#    vcl_fetch         → reads verdict, determines action, calls return(restart)
#                        (Fastly calls this vcl_fetch; standard VCL calls it vcl_backend_response)
#  restart 1:
#    vcl_recv          → reads action; block/challenge → synthetic error, redirect → synthetic 302,
#                        allow → restores original request and routes to origin
#    vcl_pass          → strips all internal X-CHEQ-* headers from bereq
#    [origin responds]
#    vcl_deliver       → attaches x-cheq-rti-result to response, fires logging, strips internals
#
# RTI response header requirement
# ---------------------------------
# Fastly VCL cannot inspect a backend response body, only response headers.
# The RTI service must therefore echo the verdict as the response header:
#
#   X-Cheq-Res-Verdict:             benign | suspicious | malicious
#   X-Cheq-Res-Classification-Code: <integer threat-type code>
#   X-Cheq-Res-Version:             <schema version string>
#   X-Cheq-Res-Reasons:             <comma-separated integers>  (optional – detection reason codes)
#   X-Cheq-Res-Ray-Id:              <request trace ID>
#   X-Cheq-Res-Rti-Result:          <pre-built result string including ids>
#
# Telemetry logging (var.cheq_logging)
# ---------------------------------------
# When var.cheq_logging is set to "true" (the default), the integration sends
# RTI timing and verdict data to a Fastly HTTPS logging endpoint after every
# request. This mirrors context.waitUntil(log(duration)) / logger.error() in
# the Cloudflare and CloudFront integrations.
#
# WHY a Fastly logging endpoint is needed
# ----------------------------------------
# Unlike Node.js runtimes, Fastly VCL cannot make arbitrary outbound HTTP calls
# from within request processing. Instead, Fastly provides a built-in "HTTPS
# Logging" mechanism: you configure an endpoint in the Fastly UI, and the
# `log` statement in VCL writes to it asynchronously after the response is
# delivered to the client. This is fire-and-forget – it does not block or add
# latency to the request.
#
# How to configure the logging endpoint
# ---------------------------------------
# In the Fastly UI, go to:  Logging → HTTPS → Create endpoint
# Fill in the following fields:
#
#   Name:         cheq-rti-logger   ← must match the name in cheq_rti_log below
#   URL:          <your logging endpoint URL>
#   Method:       POST
#   Content-Type: application/json
#   Format:       %{req.http.X-Cheq-Log-Payload}V
#
# The "Format" field tells Fastly what to POST as the request body.
# X-Cheq-Log-Payload is an internal header built by cheq_rti_log containing
# the JSON payload – it is stripped before the response reaches the client.
#
# What gets logged
# -----------------
# Every request logs a JSON payload:
#
#   { "level": "info",  "message": "rti_duration: 42",   "action": "allow",  ... }
#   { "level": "error", "message": "rti_error: 503",      "action": "allow",  ... }
#
# Logging fires in three places so no request is missed:
#   - vcl_deliver       : normal allow path (origin was called)
#   - vcl_synth         : blocked/redirected path (origin was NOT called;
#                         Fastly skips vcl_deliver for synthetic responses)
#   - vcl_backend_response (immediately on RTI error, before restarting)
#
# Security note: the apiKey and tagHash are stored in internal request headers
# during processing and stripped from bereq in vcl_backend_fetch so they never
# reach your origin server.
#
# Debug logging (var.cheq_debug)
# --------------------------------
# When var.cheq_debug is set to "true", the integration writes plain-text debug
# messages to Fastly's real-time log stream – equivalent to the console.log()
# calls in the Cloudflare integration. Three messages are written per request:
#   1. After the RTI payload is built        → "CHEQ-DEBUG :: request payload=..."
#   2. After the RTI response is received    → "CHEQ-DEBUG :: rti response status=... verdict=..."
#   3. After the action is determined        → "CHEQ-DEBUG :: action=..."
#
# Stream debug output live with the Fastly CLI:
#   fastly log-tail --service-id=<your-service-id>
#
# WARNING: Do not leave var.cheq_debug = "true" in production.
#          The payload log includes request headers and cookie values.
#
# ==============================================================================
# Backend declaration – add this to your main VCL (not in a subroutine).
# Replace host / port with the actual RTI endpoint.
# ==============================================================================
#
# backend cheq_rti_backend {
#   .host    = "rti-global.cheqzone.com";
#   .port    = "443";
#   .ssl     = true;
#   .ssl_sni_hostname      = "rti-global.cheqzone.com";
#   .ssl_cert_hostname     = "rti-global.cheqzone.com";
#   .connect_timeout       = 500ms;
#   .first_byte_timeout    = 500ms;
#   .between_bytes_timeout = 500ms;
# }
#
# ==============================================================================


# ------------------------------------------------------------------------------
# Edge Dictionaries
# Create these in the Fastly UI: Data → Dictionaries
# ------------------------------------------------------------------------------
#
# general_config — runtime configuration. Keys:
#   api_key              CHEQ RTI API key
#   tag_hash             CHEQ tag hash
#   api_hostname         RTI endpoint hostname (must match cheq_rti_backend .host)
#   mode                 "monitoring" | "blocking"
#   block_strategy       "access_denied" | "not_found" | "redirect" | "captcha"
#   challenge_strategy   "access_denied" | "not_found" | "redirect" | "captcha"
#   redirect_loc         URL for redirect block strategy
#   logging              "true" | "false"
#   debug                "true" | "false"
#   captcha_site_key     reCAPTCHA v2 site key (embedded in challenge page)
#   captcha_host         Hostname of captcha verification backend (must match cheq_captcha_backend .host)
#   captcha_session_ttl  CAPTCHA session cookie TTL in seconds (default "900")
#
# ignored_paths_config — paths that bypass RTI entirely. Runtime alternative to the
# hardcoded regex in cheq_rti_recv. No redeploy needed to add/remove entries.
#   Key:   exact req.url.path  (e.g. "/api/health")
#   Value: "1"
#
# block_tt_codes — Classification-Code values that force action = block regardless of verdict.
#   Key:   integer code string (e.g. "7")
#   Value: "1"
#   Why dict instead of regex: Fastly VCL regex must be compile-time literals
#   (see https://www.fastly.com/documentation/reference/vcl/regex). Since
#   Classification-Code is always a single integer, exact-match table lookup
#   is equivalent and allows runtime changes without redeployment.
#
# challenge_tt_codes — Classification-Code values that force action = challenge.
#   Key:   integer code string (e.g. "12")
#   Value: "1"
#
# redirect_tt_codes — Classification-Code values that force action = redirect.
#   Key:   integer code string (e.g. "3")
#   Value: "1"
#
# general_config key added:
#   captcha_session_ttl  CAPTCHA session cookie TTL in seconds (default "900")
#
# NOTE: Do NOT declare these tables here. When you create an Edge Dictionary in the
# Fastly UI (Data → Dictionaries), Fastly auto-generates the table declaration in
# the compiled VCL. Declaring it again here causes a "Multiple definitions" compile error.


# ------------------------------------------------------------------------------
# cheq_rti_session_check
# Call from vcl_recv before cheq_rti_recv.
# Verifies the HMAC-SHA256 signed session cookie set after a successful CAPTCHA.
# Sets req.http.X-Cheq-Session-Valid = "true" when the cookie is valid and
# unexpired; "false" otherwise.
#
# Cookie format: cq_session_token=<timestamp_s>.<hmac_hex>
# HMAC message:  <client_ip>:<timestamp_s>
# HMAC key:      api_key from general_config Edge Dictionary
#
# Required general_config keys:
#   api_key              — same key used for RTI requests
#   captcha_session_ttl  — TTL in seconds (default 900)
# ------------------------------------------------------------------------------
sub cheq_rti_session_check {
    declare local var.token       STRING;
    declare local var.api_key     STRING;
    declare local var.ttl         STRING;
    declare local var.ttl_seconds INTEGER;
    declare local var.ts_str      STRING;
    declare local var.sig         STRING;
    declare local var.ts          INTEGER;
    declare local var.expires_at  INTEGER;
    declare local var.now_str     STRING;
    declare local var.now         INTEGER;
    declare local var.message     STRING;
    declare local var.expected    STRING;

    set req.http.X-Cheq-Session-Valid = "false";

    set var.token = req.http.Cookie:cq_session_token;
    if (!var.token || var.token == "") { return; }

    set var.api_key = table.lookup(general_config, "api_key", "");
    if (var.api_key == "") { return; }

    set var.ttl = table.lookup(general_config, "captcha_session_ttl", "900");
    set var.ttl_seconds = std.atoi(var.ttl);
    if (var.ttl_seconds <= 0) { set var.ttl_seconds = 900; }

    # Parse token: <timestamp_s>.<signature>
    if (var.token !~ "^([0-9]+)\.([0-9a-f]+)$") { return; }
    set var.ts_str = re.group.1;
    set var.sig    = re.group.2;

    set var.ts = std.atoi(var.ts_str);
    if (var.ts <= 0) { return; }

    # Check expiry: token_ts + ttl_seconds > now  (all in seconds — avoids 32-bit overflow)
    set var.now_str = strftime({"%s"}, now);
    set var.now = std.atoi(var.now_str);
    set var.expires_at = var.ts;
    set var.expires_at += var.ttl_seconds;
    if (var.now > var.expires_at) { return; }

    # Verify HMAC-SHA256(api_key, "client_ip:timestamp_s")
    set var.message  = client.ip ":" var.ts_str;
    # Strip the "0x" prefix that Fastly's digest.hmac_sha256 prepends, so the
    # comparison matches the cookie value which was also stored without the prefix.
    set var.expected = regsub(digest.hmac_sha256(var.api_key, var.message), "^0x", "");

    if (var.expected == var.sig) {
        set req.http.X-Cheq-Session-Valid = "true";
    }
}


# ------------------------------------------------------------------------------
# cheq_rti_session_generate
# Call from cheq_rti_backend_response when CAPTCHA verification succeeds.
# Builds an HMAC-SHA256 signed session cookie and stores its Set-Cookie value
# in req.http.X-Cheq-Session-Cookie so cheq_rti_deliver can attach it to the
# response.
# ------------------------------------------------------------------------------
sub cheq_rti_session_generate {
    declare local var.api_key     STRING;
    declare local var.ttl         STRING;
    declare local var.ttl_seconds INTEGER;
    declare local var.ts          STRING;
    declare local var.message     STRING;
    declare local var.sig         STRING;
    declare local var.token       STRING;

    set var.api_key = table.lookup(general_config, "api_key", "");
    if (var.api_key == "") { return; }

    set var.ttl = table.lookup(general_config, "captcha_session_ttl", "900");
    set var.ttl_seconds = std.atoi(var.ttl);
    if (var.ttl_seconds <= 0) { set var.ttl_seconds = 900; }

    # Timestamp in seconds (epoch seconds — fits in a 32-bit VCL INTEGER when parsed back)
    set var.ts      = strftime({"%s"}, now);
    set var.message = client.ip ":" var.ts;
    # digest.hmac_sha256 returns a "0x"-prefixed hex string in Fastly VCL.
    # Strip the prefix so the cookie value is <ts>.<hex> and the validation
    # regex [0-9a-f]+ can match it cleanly.
    set var.sig     = regsub(digest.hmac_sha256(var.api_key, var.message), "^0x", "");
    set var.token   = var.ts "." var.sig;

    set req.http.X-Cheq-Session-Cookie = "cq_session_token=" var.token
        "; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=" std.itoa(var.ttl_seconds);
}


# ------------------------------------------------------------------------------
# cheq_rti_recv
# Call from vcl_recv.
# On restart 0: stash original request data, build RTI payload, route to RTI.
# On restart 1: restore original request, route to origin or serve synthetic.
# ------------------------------------------------------------------------------
sub cheq_rti_recv {

    # ---- Configuration -------------------------------------------------------
    # Update these values before deploying.
    declare local var.cheq_api_key              STRING;
    declare local var.cheq_tag_hash             STRING;
    declare local var.cheq_mode                 STRING;  # "monitoring" | "blocking"
    declare local var.cheq_redirect_loc         STRING;  # URL to redirect to when strategy is "redirect" (e.g. "https://www.cheq.ai/")
    declare local var.cheq_block_strategy       STRING;  # The block strategy: "access_denied" | "not_found"  | "redirect" | "captcha"
    declare local var.cheq_challenge_strategy   STRING;  # The challenge strategy: "access_denied" | "not_found"  | "redirect" | "captcha"
    declare local var.cheq_logging              STRING;  # "true" | "false"
    declare local var.cheq_debug                STRING;  # "true" | "false" – enable real-time debug logging
    declare local var.cheq_api_hostname         STRING;  # The hostname portion of the CHEQ RTI API URL
    declare local var.cheq_captcha_key          STRING;  # reCAPTCHA v2 site key – embedded in the challenge page and the verification URL path
    declare local var.cheq_captcha_host         STRING;  # Hostname of captcha verification backend (must match cheq_captcha_backend .host)
    #
    # NOTE on logging configuration
    # --------------------------------
    # Unlike the Cloudflare/CloudFront integrations where the logger URL is set
    # directly in code, Fastly VCL cannot make arbitrary outbound HTTP calls.
    # Logging works differently here: you configure an HTTPS endpoint in the
    # Fastly UI (Logging → HTTPS) and VCL references it by name.
    #
    # What this means in practice:
    #   - The logging endpoint URL is set once in the Fastly UI – NOT in this file.
    #   - What you control here (var.cheq_logging) is only whether to log or not.
    #   - The endpoint name in the `log` statement inside cheq_rti_log must match
    #     the name you gave the endpoint in the Fastly UI (default: "cheq-rti-logger").
    #
    # If you need to rename the logging endpoint, update the name in two places:
    #   1. The Fastly UI (Logging → HTTPS → endpoint name)
    #   2. The `log` statement in the cheq_rti_log subroutine below


    # All config values are read from the general_config Edge Dictionary.
    # Create the dictionary in the Fastly UI (Data → Dictionaries → general_config)
    # and add the keys listed in the table declaration at the top of this file.
    set var.cheq_api_key            = table.lookup(general_config, "api_key",            ""); # Mandatory
    set var.cheq_tag_hash           = table.lookup(general_config, "tag_hash",           ""); # Mandatory

    # cheq_api_hostname is the RTI endpoint hostname.
    # IMPORTANT: must match the .host value in the cheq_rti_backend declaration in your main VCL.
    # cheq_api_hostname sets the HTTP Host header of the outgoing RTI request; the backend
    # declaration sets the TCP connection destination. Both must point to the same server.
    # Dev:        "obs.dev.cheqzone.com"
    # Production: "rti-global.cheqzone.com"
    set var.cheq_api_hostname       = table.lookup(general_config, "api_hostname",       "rti-global.cheqzone.com"); # Change for Dev Testing only

    set var.cheq_mode               = table.lookup(general_config, "mode",               "blocking"); # "monitoring" (no blocking) or "blocking"
    set var.cheq_block_strategy     = table.lookup(general_config, "block_strategy",     ""); # Default to "access_denied"
    set var.cheq_challenge_strategy = table.lookup(general_config, "challenge_strategy", ""); # Default to "captcha"
    set var.cheq_redirect_loc       = table.lookup(general_config, "redirect_loc",       "https://www.cheq.ai/");
    set var.cheq_logging            = table.lookup(general_config, "logging",            "false");
    set var.cheq_debug              = table.lookup(general_config, "debug",              "false");
    set var.cheq_captcha_key        = table.lookup(general_config, "captcha_site_key",   "");
    set var.cheq_captcha_host       = table.lookup(general_config, "captcha_host",       "");

    # ---- TT code and Reasons overrides ---------------------------------------------------
    # Classification-Code overrides: configured via block_tt_codes / challenge_tt_codes /
    # redirect_tt_codes Edge Dictionaries. Add integer code strings as keys (value = "1").
    # No VCL redeploy needed — changes take effect immediately in the Fastly UI.
    #
    # Reasons overrides: still use literal regex patterns in cheq_rti_backend_response.
    # Fastly VCL's ~ operator only accepts compile-time literals — variables and
    # dictionary values cannot be used as regex patterns (VCL language constraint).


    # ---- Strip client-injectable internal headers --------------------------------
    # Must run on every new request (restarts == 0) to prevent clients from
    # injecting fake state (e.g. X-Cheq-Action: allow bypasses RTI verdict,
    # X-Cheq-Captcha-Verify: 1 skips backend_response verdict processing).
    if (req.restarts == 0) {
        unset req.http.X-Cheq-Action;
        unset req.http.X-Cheq-Captcha-Verify;
        unset req.http.X-Cheq-Captcha-Fail;
        unset req.http.X-Cheq-Session-Valid;
        unset req.http.X-Cheq-Session-Cookie;
        unset req.http.X-Cheq-Session-Bypass;
        unset req.http.X-Cheq-Config-Debug;
        unset req.http.X-Cheq-Config-Mode;
        unset req.http.X-Cheq-Config-Captcha-Key;
        unset req.http.origURL;
        unset req.http.X-Cheq-Param-Api-Key;
        unset req.http.X-Cheq-Param-Tag-Hash;
        unset req.http.X-Cheq-Param-Client-Ip;
        unset req.http.X-Cheq-Param-Request-Url;
        unset req.http.X-Cheq-Param-User-Agent;
        unset req.http.X-Cheq-Param-Accept-Language;
        unset req.http.X-Cheq-Param-Ja3;
        unset req.http.X-Cheq-Param-Ja4;
    }


    # ---- CAPTCHA session check -----------------------------------------------
    # IMPORTANT: Integrators must call cheq_rti_session_check in their main VCL
    # BEFORE calling cheq_rti_recv, and return(pass) early when the session is
    # valid. Example (from example_main.vcl):
    #
    #   call cheq_rti_session_check;
    #   if (req.http.X-Cheq-Session-Valid == "true") {
    #       set req.http.X-Cheq-Session-Bypass = "1";
    #       set req.backend = origin_backend;
    #       return(pass);
    #   }
    #
    # cheq_rti_recv does NOT check the session cookie itself because it cannot
    # set req.backend to the integrator's origin — that value is unknown here.

    # ---- Failed challenge (restart after verification failure) ---------------
    # cheq_rti_backend_response sets X-Cheq-Captcha-Fail when the verification
    # backend signals failure, then restarts.  Re-serve the challenge page.
    if (req.restarts > 0 && req.http.X-Cheq-Captcha-Fail) {
        set req.http.X-Cheq-Config-Captcha-Key = var.cheq_captcha_key;
        error 601 "Security Challenge";
    }

    # ---- CAPTCHA verification POST (?captcha=<nonce>) -----------------------
    # The challenge page POSTs the CAPTCHA token here with a server-generated
    # HMAC nonce in place of the static "1" value.  The nonce is:
    #   HMAC-SHA256(api_key, client_ip)
    # embedded by cheq_rti_synth in the form's data-captcha-nonce attribute.
    # This prevents bots from constructing valid captcha POST URLs — the nonce
    # is IP-bound and unforgeable without knowledge of the api_key secret.
    # (Fastly VCL does not support TIME arithmetic, so no time component is used;
    #  security is provided by the HMAC secret + IP binding alone.)
    if (req.method == "POST" && req.url.qs ~ "(?:^|&)captcha=([0-9a-f]+)(?:$|&)") {
        declare local var.submitted_nonce STRING;
        declare local var.expected_nonce  STRING;

        set var.submitted_nonce = re.group.1;

        set var.expected_nonce = regsub(
            digest.hmac_sha256(var.cheq_api_key, client.ip),
            "^0x", ""
        );

        if (var.submitted_nonce == var.expected_nonce) {
            set req.http.X-Cheq-Captcha-Verify = "1";
            set req.http.origURL               = querystring.filter(req.url, "captcha");
            set req.http.Host                  = var.cheq_captcha_host;
            set req.url                        = "/validate/" + var.cheq_captcha_key;
            set req.backend                    = cheq_captcha_backend;
            return(pass);
        }
        # Invalid nonce — re-serve the challenge without routing to
        # the captcha backend.  This silently drops fabricated POST attempts.
        set req.http.X-Cheq-Config-Captcha-Key = var.cheq_captcha_key;
        error 601 "Security Challenge";
    }

    # ---- Ignored paths -------------------------------------------------------
    # Paths matching this regex bypass the RTI check entirely and go straight
    # to origin. To add or remove paths, edit the regex literal directly.
    #
    # NOTE: Fastly VCL's ~ operator only accepts a literal regex – string
    # variables cannot be used as patterns (unlike Cloudflare/CloudFront where
    # the ignore list is a runtime config value). This is a VCL language limit.
    #
    # To check all paths without filtering, comment out the if block below.
    # (CONFIGURE THIS REGEX - URL PATHS TO IGNORE)
    if (req.url.path ~ "(?i)^/(favicon\.ico|robots\.txt|health|ping)") {
        set req.http.X-Cheq-Session-Bypass = "1";
        set req.backend = origin_backend;
        return(pass);
    }

    # Dictionary-based path filter — runtime alternative to the regex above.
    # Add entries in the Fastly UI: Data → Dictionaries → ignored_paths_config
    # Key = exact req.url.path (e.g. "/api/health"), Value = "1".
    # Multiple paths are supported — one dictionary entry per path.
    # No VCL redeploy needed to add or remove entries.
    if (table.lookup(ignored_paths_config, req.url.path, "") == "1") {
        set req.http.X-Cheq-Session-Bypass = "1";
        set req.backend = origin_backend;
        return(pass);
    }

    # ==========================================================================
    # RESTART 0 – forward request to RTI
    # ==========================================================================
    if (req.restarts == 0) {

        # Stash config so it is available after the restart
        set req.http.X-Cheq-Config-Mode            = var.cheq_mode;
        set req.http.X-Cheq-Config-Redirect-Loc    = var.cheq_redirect_loc;
        set req.http.X-Cheq-Config-Logging-Enabled = var.cheq_logging;
        set req.http.X-Cheq-Config-Debug           = var.cheq_debug;
        set req.http.X-Cheq-Config-Block-Strategy   = var.cheq_block_strategy;
        set req.http.X-Cheq-Config-Challenge-Strategy = var.cheq_challenge_strategy;


        # Stash credentials needed by the logger (stripped from bereq in cheq_rti_backend_fetch)
        set req.http.X-Cheq-Log-ApiKey  = var.cheq_api_key;
        set req.http.X-Cheq-Log-TagHash = var.cheq_tag_hash;

        # Stash original request so we can restore it after the restart
        set req.http.X-Cheq-Orig-Method = req.method;
        set req.http.X-Cheq-Orig-URL    = req.url;
        set req.http.X-Cheq-Orig-Host   = req.http.Host;

        # Determine protocol
        declare local var.proto STRING;
        if (req.is_ssl) {
            set var.proto = "https";
        } else {
            set var.proto = "http";
        }

        # Extract _cq_duid / _cq_pvid values from the Cookie header.
        #
        # Cookie header format: "name1=val1; name2=val2; name3=val3"
        # regsuball replaces the ENTIRE string with capture group \1, effectively
        # stripping everything except the target cookie's value:
        #   "^.*_cq_duid="  — greedily consume everything up to and including the cookie name + "="
        #   "([^;]+)"        — capture the value (stops at ";" which separates cookies)
        #   ".*$"            — consume the remainder of the string
        #
        # The ~ guard is required: when the pattern does not match, regsuball returns
        # the input unchanged — the full Cookie string would be assigned instead of "".
        #
        # _cq_duid is set by the CHEQ CT (content tracking) beacon that fires after page load.
        # _cq_pvid is the page-view ID cookie, also set by CT.
        # Both are forwarded to the RTI endpoint via X-Cheq-Param-Duid-Cookie /
        # X-Cheq-Param-Pvid-Cookie so RTI can correlate requests to known visitors.
        declare local var.duid_cookie STRING;
        declare local var.pvid_cookie STRING;

        if (req.http.Cookie ~ "_cq_duid=") {
            set var.duid_cookie = regsuball(req.http.Cookie, "^.*_cq_duid=([^;]+).*$", "\1");
        } else {
            set var.duid_cookie = "";
        }

        if (req.http.Cookie ~ "_cq_pvid=") {
            set var.pvid_cookie = regsuball(req.http.Cookie, "^.*_cq_pvid=([^;]+).*$", "\1");
        } else {
            set var.pvid_cookie = "";
        }

        # ---- Build X-Cheq-Param-* headers for the RTI endpoint ----
        # The RTI endpoint accepts all parameters as request headers (prefix X-Cheq-Param-).
        # It reads them, builds the RTI JSON payload internally, and returns the verdict
        # as X-Cheq-Res-* response headers plus a pre-built X-Cheq-Rti-Result string.
        # -----------------------------------------------------------------------

        # Core RTI parameters
        set req.http.X-Cheq-Param-Api-Key      = var.cheq_api_key;
        set req.http.X-Cheq-Param-Tag-Hash     = var.cheq_tag_hash;
        set req.http.X-Cheq-Param-Client-Ip    = req.http.Fastly-Client-IP;
        set req.http.X-Cheq-Param-Request-Url  = var.proto + "://" + req.http.Host + req.url;
        set req.http.X-Cheq-Param-Duid-Cookie  = var.duid_cookie;
        set req.http.X-Cheq-Param-Pvid-Cookie  = var.pvid_cookie;

        # Truncate long headers before forwarding to stay within Fastly's 8 KB
        # header limit under adversarial conditions (e.g. 64 KB User-Agent).
        if (std.strlen(req.http.User-Agent) > 512) {
            set req.http.User-Agent = regsub(req.http.User-Agent, "^(.{512}).*$", "\1");
        }
        if (std.strlen(req.http.Accept-Language) > 512) {
            set req.http.Accept-Language = regsub(req.http.Accept-Language, "^(.{512}).*$", "\1");
        }

        # User request headers forwarded to the RTI endpoint.
        set req.http.X-Cheq-Param-User-Agent      = req.http.User-Agent;
        set req.http.X-Cheq-Param-Host            = req.http.Host;
        set req.http.X-Cheq-Param-X-Forwarded-For = req.http.X-Forwarded-For;
        set req.http.X-Cheq-Param-Accept-Encoding = req.http.Accept-Encoding;
        set req.http.X-Cheq-Param-Accept-Language = req.http.Accept-Language;
        set req.http.X-Cheq-Param-Accept-Charset  = req.http.Accept-Charset;

        # TLS fingerprints — among the strongest bot signals available in Fastly VCL.
        set req.http.X-Cheq-Param-Ja3 = tls.client.ja3_md5;
        set req.http.X-Cheq-Param-Ja4 = tls.client.ja4;

        # Build Header-Names: comma-separated list of user headers that are present.
        declare local var.header_names STRING;
        declare local var.sep          STRING;
        set var.header_names = "";
        set var.sep          = "";
        if (req.http.User-Agent)      { set var.header_names = var.header_names + var.sep + "user-agent";       set var.sep = ","; }
        if (req.http.Host)            { set var.header_names = var.header_names + var.sep + "host";             set var.sep = ","; }
        if (req.http.X-Forwarded-For) { set var.header_names = var.header_names + var.sep + "x-forwarded-for"; set var.sep = ","; }
        if (req.http.Accept-Encoding) { set var.header_names = var.header_names + var.sep + "accept-encoding";  set var.sep = ","; }
        if (req.http.Accept-Language) { set var.header_names = var.header_names + var.sep + "accept-language";  set var.sep = ","; }
        if (req.http.Accept-Charset)  { set var.header_names = var.header_names + var.sep + "accept-charset";   set var.sep = ","; }
        if (req.http.X-Cheq-Param-Ja3) { set var.header_names = var.header_names + var.sep + "x-cheq-param-ja3"; set var.sep = ","; }
        if (req.http.X-Cheq-Param-Ja4) { set var.header_names = var.header_names + var.sep + "x-cheq-param-ja4"; set var.sep = ","; }
        set req.http.X-Cheq-Param-Header-Names = var.header_names;

        if (req.http.X-Cheq-Config-Debug == "true") {
            log "syslog " + req.service_id + " CHEQ-DEBUG :: request"
                + " clientIp=" + req.http.X-Cheq-Param-Client-Ip
                + " url="      + req.http.X-Cheq-Param-Request-Url
                + " duid="     + var.duid_cookie
                + " pvid="     + var.pvid_cookie;
        }

        # Route to the RTI endpoint.
        # var.cheq_api_hostname must match the .host value in the cheq_rti_backend
        # declaration in your main VCL (example_main.vcl).
        # Force POST — the RTI endpoint is POST-only; original method is stashed in
        # X-Cheq-Orig-Method and restored in restart 1.
        set req.method    = "POST";
        set req.url       = "/defend/4.0/traffic-headers";
        set req.http.Host = var.cheq_api_hostname;
        set req.backend   = cheq_rti_backend;
        return(pass);
    }

    # ==========================================================================
    # RESTART 1 – act on the RTI verdict, then route to origin if allowed
    # ==========================================================================
    if (req.restarts == 1) {

        declare local var.action   STRING;
        declare local var.strategy STRING;

        # Read the RTI action and block strategy from the stashed headers,
        # set by cheq_rti_backend_response based on the RTI response headers.
        set var.action   = req.http.X-Cheq-Action; # "allow" | "block" | "challenge" | "redirect"

        if (req.http.X-Cheq-Config-Debug == "true") {
            log "syslog " + req.service_id + " CHEQ-DEBUG :: action=" + var.action;
        }

        if (var.action != "allow") {
            set var.strategy = req.http.X-Cheq-Block-Strategy; # "access_denied" | "not_found" | "redirect" | "captcha"

            if (var.strategy == "access_denied") {
                error 403 "Forbidden";
            } else if (var.strategy == "not_found") {
                error 404 "Not Found";
            } else if (var.strategy == "redirect") {
                # Location header is set from X-Cheq-Config-Redirect-Loc in cheq_rti_synth.
                error 302 "Found";
            } else if (var.strategy == "captcha") {
                # Serve a CAPTCHA challenge page via cheq_rti_synth.
                set req.http.X-Cheq-Config-Captcha-Key = var.cheq_captcha_key;
                error 601 "Security Challenge";
            }
        }


        # Restore original request and route to the customer origin
        set req.backend   = origin_backend;
        set req.method    = req.http.X-Cheq-Orig-Method;
        set req.url       = req.http.X-Cheq-Orig-URL;
        set req.http.Host = req.http.X-Cheq-Orig-Host;

        # Strip routing/stash headers from req so they are not forwarded to origin.
        # Logger-specific headers (X-Cheq-Log-*, X-Cheq-Config-Logging-Enabled, X-Cheq-RTI-Duration)
        # are stripped from bereq in cheq_rti_backend_fetch so they survive to vcl_deliver.
        unset req.http.X-Cheq-Action;
        unset req.http.X-Cheq-Config-Mode;
        unset req.http.X-Cheq-Config-Redirect-Loc;
        unset req.http.X-Cheq-Config-Block-Strategy;
        unset req.http.X-Cheq-Config-Challenge-Strategy;
        unset req.http.X-Cheq-Block-Strategy;
        unset req.http.X-Cheq-Orig-Method;
        unset req.http.X-Cheq-Orig-URL;
        unset req.http.X-Cheq-Orig-Host;
        unset req.http.X-Cheq-Payload;
        unset req.http.Content-Type;

        return(pass);
    }
}


# ------------------------------------------------------------------------------
# cheq_rti_backend_fetch
# Call from vcl_pass.
# restart 0 (RTI request): X-Cheq-Param-* headers are forwarded as-is to the
#   RTI endpoint, which reads them directly (no JSON body needed).
# restart 1 (origin request): strips all internal CHEQ headers from bereq so
#   they never reach the origin server.
# ------------------------------------------------------------------------------
sub cheq_rti_backend_fetch {

    # restart 0: X-Cheq-Param-* headers are already on bereq and forwarded to
    # the RTI endpoint directly. No body manipulation needed.

    # NOTE: In the snippet deployment model the origin_host Host-header override
    # lives in pass.vcl (which calls cheq_rti_backend_fetch and then applies
    # the override itself).  In this standalone deployment model it lives here.
    #
    # Optional runtime override: allow integrators to set `origin_host` in the
    # `general_config` Edge Dictionary. When present, this value is applied to
    # `bereq.http.Host` for origin requests (restart >= 1) or session-bypass
    # requests so name-based vhosts (S3 static website, virtual hosts) receive
    # the expected Host header without a VCL redeploy.
    declare local var.origin_host STRING;
    set var.origin_host = table.lookup(general_config, "origin_host", "");

    if (req.restarts >= 1) {
        # Strip all X-Cheq-Param-* headers so they never reach the customer origin.
        unset bereq.http.X-Cheq-Param-Api-Key;
        unset bereq.http.X-Cheq-Param-Tag-Hash;
        unset bereq.http.X-Cheq-Param-Client-Ip;
        unset bereq.http.X-Cheq-Param-Request-Url;
        unset bereq.http.X-Cheq-Param-Duid-Cookie;
        unset bereq.http.X-Cheq-Param-Pvid-Cookie;
        unset bereq.http.X-Cheq-Param-User-Agent;
        unset bereq.http.X-Cheq-Param-Host;
        unset bereq.http.X-Cheq-Param-X-Forwarded-For;
        unset bereq.http.X-Cheq-Param-Accept-Encoding;
        unset bereq.http.X-Cheq-Param-Accept-Language;
        unset bereq.http.X-Cheq-Param-Accept-Charset;
        unset bereq.http.X-Cheq-Param-Ja3;
        unset bereq.http.X-Cheq-Param-Ja4;
        unset bereq.http.X-Cheq-Param-Header-Names;
        unset bereq.http.origURL;

        # Strip internal CHEQ stash headers.
        unset bereq.http.X-Cheq-Log-ApiKey;
        unset bereq.http.X-Cheq-Log-TagHash;
        unset bereq.http.X-Cheq-Config-Logging-Enabled;
        unset bereq.http.X-Cheq-RTI-Duration;
        unset bereq.http.X-Cheq-Verdict;
        unset bereq.http.X-Cheq-TT-Code;
        unset bereq.http.X-Cheq-Version;
        unset bereq.http.X-Cheq-Rti-Result-Stash;
        unset bereq.http.X-Cheq-Config-Debug;
    }

    # If an origin_host is configured at runtime, override the Host header sent
    # to the origin so name-based vhosts (S3 static website, virtual hosts)
    # receive the expected value.  Must cover both restart >= 1 (normal RTI
    # path) and restart == 0 session-bypass requests.
    if (var.origin_host != "" && (req.restarts >= 1 || req.http.X-Cheq-Session-Bypass)) {
        set bereq.http.Host = var.origin_host;
    }

    # Never forward captcha-internal or session-state headers to any backend.
    # These are internal RTI headers and must never be visible to origin or
    # any other backend regardless of restart count.
    unset bereq.http.X-Cheq-Captcha-Verify;
    unset bereq.http.X-Cheq-Config-Captcha-Key;
    unset bereq.http.X-Cheq-Session-Bypass;
    unset bereq.http.X-Cheq-Session-Valid;
}


# ------------------------------------------------------------------------------
# cheq_rti_backend_response
# Call from vcl_fetch (Fastly) / vcl_backend_response (standard VCL).
# Reads the RTI verdict headers and stores the action for restart 1. 
# This is basically the RTI response processing but only the part of it that figures the action 
# and stashes it for the restart or makes the decision to fail-open on RTI errors. 
# The rest of the RTI response processing (stashing metadata for logging, debug logging, etc.) is also done here since this is the only place where the RTI response headers are accessible.
# Fail-open: any error from RTI results in action "allow", logged as "error" level.
# ------------------------------------------------------------------------------
sub cheq_rti_backend_response {

    # ---- CAPTCHA verification response ---------------------------------------
    # Verification backend returns 302 on success, or sets captchaFail on failure.
    # On failure: stash the fail flag on req and restart to re-serve the challenge.
    # On success: generate an HMAC-signed session cookie to replace the unsigned
    #   captchaAuth cookie returned by Compute@Edge, then deliver the 302 redirect.
    if (req.http.X-Cheq-Captcha-Verify) {
        if (beresp.http.captchaFail) {
            set req.http.X-Cheq-Captcha-Fail = "1";
            return(restart);
        }
        # Replace unsigned captchaAuth cookie with HMAC-signed cq_session_token.
        # cheq_rti_deliver will attach X-Cheq-Session-Cookie as Set-Cookie.
        call cheq_rti_session_generate;
        unset beresp.http.Set-Cookie;
        return(deliver);
    }

    if (req.restarts == 0) {

        # X-Cheq-Orig-URL is only stashed when the request was routed to RTI.
        # If it's absent the request took a bypass path (ignored path, session bypass, etc.)
        # and this is a direct origin response — do not restart.
        if (!req.http.X-Cheq-Orig-URL) { return; }

        declare local var.verdict           STRING;
        declare local var.mode              STRING;
        declare local var.block_strategy    STRING;
        declare local var.challenge_strategy STRING;

        # Fail-open: if the RTI endpoint returned an HTTP error, log it and allow the request through.
        if (beresp.status >= 400) {
            set req.http.X-Cheq-RTI-Duration = time.elapsed.msec;
            set req.http.X-Cheq-Verdict      = "benign"; # default to benign so the request is treated as allowed in the restart
            set req.http.X-Cheq-Log-Level    = "error";
            set req.http.X-Cheq-Log-Message  = "rti_error: " + beresp.status;
            if (req.http.X-Cheq-Config-Debug == "true") {
                log "syslog " + req.service_id + " CHEQ-DEBUG :: rti error status=" + beresp.status;
                set req.http.X-Cheq-RTI-Debug-Status = beresp.status;
            }
            if (req.http.X-Cheq-Config-Logging-Enabled == "true") {
                call cheq_rti_log;
            }
            set req.http.X-Cheq-Action = "allow";
            return(restart);
        }

        # Read verdict from response headers (new X-Cheq-Res-* names).
        set var.verdict           = beresp.http.X-Cheq-Res-Verdict;
        set var.mode              = req.http.X-Cheq-Config-Mode;
        set var.block_strategy    = req.http.X-Cheq-Config-Block-Strategy;
        set var.challenge_strategy = req.http.X-Cheq-Config-Challenge-Strategy;

        # Stash RTI metadata for the response headers (restart 1 / deliver)
        set req.http.X-Cheq-Verdict           = var.verdict;
        set req.http.X-Cheq-Version           = beresp.http.X-Cheq-Res-Version;
        set req.http.X-Cheq-TT-Code           = beresp.http.X-Cheq-Res-Classification-Code;
        set req.http.X-Cheq-Reasons           = beresp.http.X-Cheq-Res-Reasons;
        set req.http.X-Cheq-Ray-Id            = beresp.http.X-Cheq-Res-Ray-Id;
        set req.http.X-Cheq-Rti-Result-Stash  = beresp.http.X-Cheq-Res-Rti-Result;
        set req.http.X-Cheq-RTI-Duration      = time.elapsed.msec;

        # Set log level/message for the normal telemetry path (used by cheq_rti_log)
        set req.http.X-Cheq-Log-Level   = "info";
        set req.http.X-Cheq-Log-Message = "rti_duration: " + time.elapsed.msec;

        # NOTE: VCL cannot enumerate or dump all headers dynamically – each header
        # must be listed explicitly. If RTI introduces new X-Cheq-Res-* response headers,
        # add them here. Headers not sent by RTI will appear as empty strings.
        if (req.http.X-Cheq-Config-Debug == "true") {
            log "syslog " + req.service_id + " CHEQ-DEBUG :: rti response"
                + " status="                      + beresp.status
                + " X-Cheq-Res-Verdict="          + beresp.http.X-Cheq-Res-Verdict
                + " X-Cheq-Res-Classification-Code=" + beresp.http.X-Cheq-Res-Classification-Code
                + " X-Cheq-Res-Version="          + beresp.http.X-Cheq-Res-Version;
        }

        # ── TT-code and Reasons override guide ────────────────────────────────
        # Classification-Code (single integer, e.g. "7"):
        #   Configured via Edge Dictionaries: block_tt_codes, challenge_tt_codes,
        #   redirect_tt_codes. Add the integer string as a key (value = "1").
        #   No redeploy needed. Runtime-configurable.
        #
        #   WHY not regex: Fastly VCL regex must be compile-time literals and
        #   cannot be read from variables or dictionaries. Since Classification-Code
        #   is always a single integer, exact-match table.lookup is equivalent.
        #   See: https://www.fastly.com/documentation/reference/vcl/regex
        #
        # Reasons (comma-separated integers, e.g. "5,10,20"):
        #   Still configured as a literal regex — VCL constraint, no workaround.
        #   Pattern: "(^|,)(A|B|C)(,|$)" matches a number at any list position.
        #   Example: "(^|,)(5|10|15)(,|$)" matches if reasons contains 5, 10, or 15.
        #   Default "^\x01$" never matches (null byte) — leave it to disable.
        # ───────────────────────────────────────────────────────────────────────
        if (var.mode == "blocking") {
            if (var.verdict == "malicious"
                # blockTTCodes — add integer codes to the block_tt_codes Edge Dictionary
                || table.lookup(block_tt_codes, beresp.http.X-Cheq-Res-Classification-Code, "") != ""
                # blockReasons — literal regex required (comma-separated list, VCL constraint)
                || beresp.http.X-Cheq-Res-Reasons ~ "^\x01$" # (CONFIGURE THIS REGEX - BLOCKING REASONS)
                ) {

                set req.http.X-Cheq-Action = "block";

                if (var.block_strategy != "") {
                    set req.http.X-Cheq-Block-Strategy = var.block_strategy;
                } else {
                    set req.http.X-Cheq-Block-Strategy = "access_denied";
                }

            } else if (var.verdict == "suspicious"
                # challengeTTCodes — add integer codes to the challenge_tt_codes Edge Dictionary
                || table.lookup(challenge_tt_codes, beresp.http.X-Cheq-Res-Classification-Code, "") != ""
                # challengeReasons — literal regex required (comma-separated list, VCL constraint)
                || beresp.http.X-Cheq-Res-Reasons ~ "^\x01$" # (CONFIGURE THIS REGEX - CHALLENGE REASONS)
                ) {

                set req.http.X-Cheq-Action = "challenge";

                if (var.challenge_strategy != "") {
                    set req.http.X-Cheq-Block-Strategy = var.challenge_strategy;
                } else {
                    set req.http.X-Cheq-Block-Strategy = "captcha";
                }

            } else if (
                # redirectTTCodes — add integer codes to the redirect_tt_codes Edge Dictionary
                table.lookup(redirect_tt_codes, beresp.http.X-Cheq-Res-Classification-Code, "") != ""
                # redirectReasons — literal regex required (comma-separated list, VCL constraint)
                || beresp.http.X-Cheq-Res-Reasons ~ "^\x01$" # (CONFIGURE THIS REGEX - REDIRECT REASONS)
                ) {

                set req.http.X-Cheq-Action = "redirect";
                set req.http.X-Cheq-Block-Strategy = "redirect";
            } else {
                set req.http.X-Cheq-Action = "allow";
            }
        } else {
            # Monitoring mode – always allow
            set req.http.X-Cheq-Action = "allow";
        }

        set req.http.X-Cheq-Action-Stash   = req.http.X-Cheq-Action;
        set req.http.X-Cheq-Strategy-Stash = req.http.X-Cheq-Block-Strategy;

        return(restart);
    }
}


# ------------------------------------------------------------------------------
# cheq_rti_synth
# Call from vcl_error (Fastly) / vcl_synth (standard VCL).
# Serves synthetic block / redirect responses triggered by cheq_rti_recv.
# Also fires telemetry logging here because vcl_deliver is NOT called by Fastly
# for synthetic responses – logging would otherwise be skipped for blocked requests.
# ------------------------------------------------------------------------------
sub cheq_rti_synth {

    # Fire telemetry logging for blocked/redirected requests.
    # Mirrors: context.waitUntil(log(duration)) in the Cloudflare integration.
    # The needed headers (X-Cheq-Log-*, X-Cheq-Verdict, X-Cheq-RTI-Duration) are
    # still available because `error` fires before the unset block in cheq_rti_recv.
    if (req.http.X-Cheq-Config-Logging-Enabled == "true") {
        call cheq_rti_log;
    }

    # Clean up log control headers (cheq_rti_deliver is not called for synth responses)
    unset req.http.X-Cheq-Log-Level;
    unset req.http.X-Cheq-Log-Message;

    if (obj.status == 403) {
        set obj.http.Content-Type = "text/plain; charset=utf-8";
        synthetic {"Access Denied"} + if(req.http.X-Cheq-Ray-Id, {" (Reference ID: "} + req.http.X-Cheq-Ray-Id + {")"},  "");
        return(deliver);
    }

    if (obj.status == 404) {
        set obj.http.Content-Type = "text/plain; charset=utf-8";
        synthetic {"Not Found"} + if(req.http.X-Cheq-Ray-Id, {" (Reference ID: "} + req.http.X-Cheq-Ray-Id + {")"},  "");
        return(deliver);
    }

    if (obj.status == 302) {
        set obj.http.Location = req.http.X-Cheq-Config-Redirect-Loc;
        synthetic {""};
        return(deliver);
    }

    if (obj.status == 503) {
        # Check if the error is a backend read error (timeout)
        # This is not eqvivalent to http status 503
        # By default, Fastly returns a 503 Service Unavailable error if a backend fetch fails due to a timeout
        # Fail-open: if the endpoint returned an HTTP error, log it and allow the request through.
        if (req.http.X-Cheq-Config-Debug == "true") {
            log "syslog " + req.service_id + " CHEQ-DEBUG :: rti error status=Backend Timeout - Fail Open";
            set req.http.X-Cheq-RTI-Debug-Status = "Backend '" + req.backend + "' Timeout - Fail Open";
        }
        return(restart);
    }

    if (obj.status == 601) {
        set obj.status = 200;
        set obj.http.Content-Type = "text/html; charset=utf-8";
        set obj.http.Cache-Control = "no-store";

        # Generate an IP-bound nonce for the captcha POST URL.
        # Nonce = HMAC-SHA256(api_key, client_ip) — unforgeable without the api_key secret
        # and non-transferable between IPs.  No time component is used because Fastly VCL
        # does not support TIME arithmetic; the HMAC secret + IP binding provides the
        # necessary security guarantee against nonce guessing.
        declare local var.captcha_nonce STRING;
        set var.captcha_nonce = regsub(
            digest.hmac_sha256(
                table.lookup(general_config, "api_key", ""),
                client.ip
            ),
            "^0x", ""
        );

        synthetic {"<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Security Verification</title>
  <script src="https://www.google.com/recaptcha/api.js" async defer></script>
  <style>
    body{display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;font-family:sans-serif;background:#f5f5f5}
    .box{background:#fff;padding:2rem;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.1);text-align:center}
  </style>
</head>
<body>
  <div class="box">
    <h2>Security Verification</h2>
    <p>Please complete the verification to continue.</p>
    <form id="captcha-form" method="POST" data-captcha-nonce="} + var.captcha_nonce + {">
      <div class="g-recaptcha" data-sitekey="} + req.http.X-Cheq-Config-Captcha-Key + {" data-callback="onCaptchaSolved"></div>
    </form>
  </div>
  <script>
    function onCaptchaSolved(token) {
      var sep = location.search ? '&' : '?';
      var form = document.getElementById('captcha-form');
      var nonce = form.getAttribute('data-captcha-nonce');
      form.action = location.pathname + location.search + sep + 'captcha=' + nonce;
      var input = document.createElement('input');
      input.type = 'hidden';
      input.name = 'g-recaptcha-response';
      input.value = token;
      form.appendChild(input);
      form.submit();
    }
  </script>
</body>
</html>"};
        return(deliver);
    }
}


# ------------------------------------------------------------------------------
# cheq_rti_log
# Called internally by cheq_rti_deliver when logging is enabled (normal path),
# by cheq_rti_synth when logging is enabled (blocked/redirected requests), and
# directly from cheq_rti_backend_response when RTI returns an error status.
#
# This is the VCL equivalent of:
#   context.waitUntil(log(duration))   – for normal telemetry (Cloudflare)
#   logger.error(`error: ${err.message}`) – for RTI error cases (Cloudflare)
#
# Because VCL cannot make arbitrary HTTP calls mid-request, logging is sent
# asynchronously via a Fastly HTTPS logging endpoint named "cheq-rti-logger".
# This is fire-and-forget and non-blocking.
#
# Required Fastly HTTPS logging endpoint configuration:
#   Name:         cheq-rti-logger
#   URL:          <your logging endpoint URL>
#   Method:       POST
#   Content-Type: application/json
#   Format:       %{req.http.X-Cheq-Log-Payload}V
#
# Before calling this subroutine, set:
#   req.http.X-Cheq-Log-Level   – "info" or "error"
#   req.http.X-Cheq-Log-Message – message string (e.g. "rti_duration: 45" or "rti_error: 503")
# ------------------------------------------------------------------------------
sub cheq_rti_log {

    set req.http.X-Cheq-Log-Payload =
        {"{"level":""} +
        req.http.X-Cheq-Log-Level +
        {"","message":""} +
        req.http.X-Cheq-Log-Message +
        {"","action":""} +
        req.http.X-Cheq-Verdict +
        {"","application":"fastly-vcl-integration","apiKey":""} +
        req.http.X-Cheq-Log-ApiKey +
        {"","tagHash":""} +
        req.http.X-Cheq-Log-TagHash +
        urldecode("%22}")
    ;

    # Write to the Fastly HTTPS logging endpoint (fire-and-forget, post-delivery)
    log {"syslog "} + req.service_id + {" cheq-rti-logger :: "} + req.http.X-Cheq-Log-Payload;
}


# ------------------------------------------------------------------------------
# cheq_rti_deliver
# Call from vcl_deliver.
# Attaches x-cheq-rti-result to the origin response, fires the logging call if
# enabled, and strips all internal CHEQ headers.
# ------------------------------------------------------------------------------
sub cheq_rti_deliver {

    # --------------------------------------------------------------------------
    # CAPTCHA verification response
    # Attach the HMAC-signed session cookie generated in cheq_rti_backend_response,
    # then clean up internal markers.
    # --------------------------------------------------------------------------
    if (req.http.X-Cheq-Captcha-Verify) {
        if (req.http.X-Cheq-Session-Cookie) {
            set resp.http.Set-Cookie = req.http.X-Cheq-Session-Cookie;
            unset req.http.X-Cheq-Session-Cookie;
        }
        unset req.http.X-Cheq-Captcha-Verify;
        unset req.http.X-Cheq-Session-Valid;
        unset req.http.X-Cheq-Session-Bypass;
    } else if (req.restarts >= 1) {
        # Attach RTI result to the response — use the pre-built string from the endpoint.
        set resp.http.X-Cheq-RTI-Result = req.http.X-Cheq-Rti-Result-Stash;

        # Debug: expose RTI status and stash state as a response header visible in DevTools.
        # Remove var.cheq_debug = "true" in production to stop emitting this header.
        if (req.http.X-Cheq-Config-Debug == "true") {
            if (req.http.X-Cheq-RTI-Debug-Status) {
                set resp.http.X-Cheq-RTI-Debug = "rti_error=" + req.http.X-Cheq-RTI-Debug-Status
                    + " ; duid=" + req.http.X-Cheq-Param-Duid-Cookie
                    + " ; pvid=" + req.http.X-Cheq-Param-Pvid-Cookie;
            } else if (req.http.X-Cheq-Rti-Result-Stash) {
                set resp.http.X-Cheq-RTI-Debug = "ok verdict=" + req.http.X-Cheq-Verdict
                    + " ; action="   + req.http.X-Cheq-Action-Stash
                    + " ; strategy=" + req.http.X-Cheq-Strategy-Stash
                    + " ; reasons="  + req.http.X-Cheq-Reasons
                    + " ; duid="     + req.http.X-Cheq-Param-Duid-Cookie
                    + " ; pvid="     + req.http.X-Cheq-Param-Pvid-Cookie
                    + " ; cookie_hdr=" + req.http.Cookie;
            } else {
                set resp.http.X-Cheq-RTI-Debug = "ok_but_no_result_header verdict=" + req.http.X-Cheq-Verdict
                    + " ; reasons=" + req.http.X-Cheq-Reasons
                    + " ; duid=" + req.http.X-Cheq-Param-Duid-Cookie
                    + " ; pvid=" + req.http.X-Cheq-Param-Pvid-Cookie;
            }
        }

        # Fire logging call if enabled (equivalent to context.waitUntil(log(duration)) in Cloudflare)
        if (req.http.X-Cheq-Config-Logging-Enabled == "true") {
            call cheq_rti_log;
        }

        # Remove any RTI-internal headers that leaked through to the response
        unset resp.http.X-Cheq-Verdict;
        unset resp.http.X-Cheq-TT-Code;
        unset resp.http.X-Cheq-Version;

        # Clean up internal req headers
        unset req.http.X-Cheq-Config-Logging-Enabled;
        unset req.http.X-Cheq-RTI-Duration;
        unset req.http.X-Cheq-RTI-Debug-Status;
        unset req.http.X-Cheq-Action-Stash;
        unset req.http.X-Cheq-Strategy-Stash;
        unset req.http.X-Cheq-Log-ApiKey;
        unset req.http.X-Cheq-Log-TagHash;
        unset req.http.X-Cheq-Log-Payload;
        unset req.http.X-Cheq-Log-Level;
        unset req.http.X-Cheq-Log-Message;
        unset req.http.X-Cheq-Verdict;
        unset req.http.X-Cheq-TT-Code;
        unset req.http.X-Cheq-Version;
        unset req.http.X-Cheq-Reasons;
        unset req.http.X-Cheq-Ray-Id;
        unset req.http.X-Cheq-Rti-Result-Stash;
        unset req.http.X-Cheq-Config-Debug;
        unset req.http.X-Cheq-Config-Block-Strategy;
        unset req.http.X-Cheq-Config-Challenge-Strategy;
        unset req.http.X-Cheq-Session-Valid;
        unset req.http.X-Cheq-Session-Bypass;
    }
}
