# ==============================================================================
# CHEQ RTI – VCL Snippet: pass
# Type:     pass
# Priority: 10
#
# Updates bereq headers before Fastly forwards the request to the origin or
# RTI backend.  Delegates to cheq_rti_backend_fetch which sets the correct
# backend-specific headers and strips internal tracking headers.
#
# A configurable Host header override is included, enabled by setting
# `origin_host` in the `general_config` Edge Dictionary.
#
# Upload via Fastly CLI:
#   fastly vcl snippet create \
#     --service-id=<SERVICE_ID> --version=<VERSION> \
#     --name=cheq_rti_pass --type=pass --priority=10 \
#     --content=snippets/pass.vcl
# ==============================================================================

call cheq_rti_backend_fetch;

# Override the Host header for origin requests (restart >= 1) and session-bypass
# requests only when an `origin_host` value is configured in the `general_config`
# Edge Dictionary. This allows runtime configuration without VCL redeploys.
#
# To enable: add `origin_host` -> "your-origin.example.com" to `general_config`.
declare local var.origin_host STRING;
set var.origin_host = table.lookup(general_config, "origin_host", "");

if (var.origin_host != "" && (req.restarts >= 1 || req.http.X-Cheq-Session-Bypass)) {
    set bereq.http.Host = var.origin_host;
}
