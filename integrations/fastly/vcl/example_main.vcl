# ==============================================================================
# example_main.vcl
# ==============================================================================
# This file shows how to wire cheq_rti.vcl into a Fastly custom VCL service.
# Replace the origin backend declaration with your actual origin details.
# Upload both this file (as "main") and cheq_rti.vcl (as an include) via the
# Fastly UI (Manage > Custom VCL) or the Fastly API.
# ==============================================================================

# Include the CHEQ RTI subroutines.
# "cheq_rti" must match the name you gave the file when uploading it to Fastly
# Custom VCL (the name field, not the filename).
include "cheq_rti";

# ---- Backend declarations ----------------------------------------------------

# Your origin server configuration
# Change the .host, .ssl_sni_hostname, and .ssl_cert_hostname values below to match your origin server's hostname.
backend origin_backend {
    .host              = "your-origin.example.com";
    .port              = "443";
    .ssl               = true;
    .ssl_sni_hostname  = "your-origin.example.com";
    .ssl_cert_hostname = "your-origin.example.com";

    # Optional: configure a health probe for the origin backend. Adjust the path and expected response as needed.
    .probe = {
        .request           = "HEAD / HTTP/1.1" "Host: your-origin.example.com" "Connection: close";
        .expected_response = 200;
        .initial = 5;
        .interval  = 2s;
        .threshold = 1;
        .timeout   = 2s;
        .window    = 5;
    }
}


# ---- CHEQ RTI backend --------------------------------------------------------
# VCL sends X-Cheq-Param-* request headers directly to the RTI endpoint.
# The endpoint reads them, evaluates the request, and returns the verdict as
# X-Cheq-Res-* response headers plus a pre-built X-Cheq-Rti-Result string.
#
# IMPORTANT: .host here must match var.cheq_api_hostname in cheq_rti.vcl.

backend cheq_rti_backend {
    .host    = "rti-global.cheqzone.com";  # change to dev env for internal testing
    .port    = "443";
    .ssl     = true;
    .ssl_sni_hostname  = "rti-global.cheqzone.com";  # Important: must match the .host value
    .ssl_cert_hostname = "rti-global.cheqzone.com";  # Important: must match the .host value
    .dynamic         = true;   # disable DNS caching — SaaS endpoint IPs may rotate
    .max_connections = 200;    # prevent RTI backend from exhausting all connections
    .connect_timeout       = 300ms;
    .first_byte_timeout    = 300ms;
    .between_bytes_timeout = 300ms;
    .probe = {
        # POST to the real RTI endpoint so the probe validates the actual path.
        # The header 'x-cheq-param-probe' is used by the endpoint to identify probe requests 
        .request = "POST /defend/4.1/traffic-headers HTTP/1.1"
                   "x-cheq-param-probe: true"
                   "Connection: close";
        .expected_response = 200;
        .initial = 5;
        .interval  = 2s;
        .threshold = 1;
        .timeout   = 2s;
        .window    = 5;
    }
}


# ---- CHEQ CAPTCHA verification backend ---------------------------------------
# This backend points at the Compute@Edge service that runs handler.js.
# handler.js verifies the Google reCAPTCHA v2 token at POST /validate/<site_key>.
backend cheq_captcha_backend {
    .host    = "your-compute-edge-domain.example.com";  # IMPORTANT: replace with your Compute@Edge service hostname
    .port    = "443";
    .ssl     = true;
    .ssl_sni_hostname  = "your-compute-edge-domain.example.com";  # IMPORTANT: must match the .host value
    .ssl_cert_hostname = "your-compute-edge-domain.example.com";  # IMPORTANT: must match the .host value
    .connect_timeout       = 5s;
    .first_byte_timeout    = 10s;
    .between_bytes_timeout = 10s;
    .probe = {
        .request = "HEAD / HTTP/1.1" "Host: entirely-wanted-colt.edgecompute.app" "Connection: close";
        .expected_response = 200;
        .initial = 5;
        .interval  = 60s;
        .threshold = 1;
        .timeout   = 2s;
        .window    = 5;
    }
}



# ==============================================================================
# vcl_recv
# ==============================================================================
sub vcl_recv {
    # CAPTCHA session bypass — verify the HMAC-signed session cookie.
    # Must run before cheq_rti_recv and must set req.backend explicitly here
    # (cheq_rti_session_check cannot know the integrator's origin backend name).
    call cheq_rti_session_check;
    if (req.http.X-Cheq-Session-Valid == "true") {
        set req.http.X-Cheq-Session-Bypass = "1";
        set req.backend = origin_backend;
        return(pass);
    }

    # Run CHEQ RTI logic (handles routing to RTI on restart 0,
    # restoring origin request on restart 1, and serving synthetics)
    call cheq_rti_recv;

    #FASTLY recv

    # Your existing vcl_recv logic goes here...

    if (req.method != "HEAD" && req.method != "GET" && req.method != "FASTLYPURGE") {
        return(pass);
    }
    return(lookup);
}


# ==============================================================================
# vcl_pass
# Called before each backend request when the request is not cached (pass path).
# Both restart 0 (RTI call) and restart 1 (origin call) use return(pass),
# so bereq modification for both happens here.
# ==============================================================================
sub vcl_pass {
    # Set RTI POST body (restart 0) and strip internal CHEQ headers (restart 1)
    call cheq_rti_backend_fetch;

    #FASTLY pass

    # On restart 1 (origin fetch) or session bypass (restart 0), optionally set Host header
    # from the runtime `origin_host` key in the `general_config` Edge Dictionary.
    declare local var.origin_host STRING;
    set var.origin_host = table.lookup(general_config, "origin_host", "");
    if (var.origin_host != "" && (req.restarts >= 1 || req.http.X-Cheq-Session-Bypass)) {
        set bereq.http.Host = var.origin_host;
    }

    return(pass);
}


# ==============================================================================
# vcl_fetch  (Fastly name for vcl_backend_response)
# Called after the backend response is received.
# ==============================================================================
sub vcl_fetch {
    # Skip RTI verdict processing for session bypass (direct origin pass).
    # Without this check, cheq_rti_backend_response treats the origin response as an
    # RTI response (restart 0 path), finds no verdict headers, and calls return(restart).
    if (!req.http.X-Cheq-Session-Bypass) {
        call cheq_rti_backend_response;
    }

    #FASTLY fetch

    # Your existing vcl_fetch logic goes here...

    return(deliver);
}


# ==============================================================================
# vcl_deliver
# ==============================================================================
sub vcl_deliver {
    # Attach x-cheq-rti-result header to origin responses
    call cheq_rti_deliver;

    #FASTLY deliver

    # Your existing vcl_deliver logic goes here...

    return(deliver);
}


# ==============================================================================
# vcl_error  (Fastly name for vcl_synth — synthetic / error responses)
# ==============================================================================
sub vcl_error {
    # Handle CHEQ block / redirect synthetic responses
    call cheq_rti_synth;

    #FASTLY error

    # Your existing vcl_error logic goes here...

    return(deliver);
}
