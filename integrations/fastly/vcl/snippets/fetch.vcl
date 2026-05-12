# ==============================================================================
# CHEQ RTI – VCL Snippet: fetch
# Type:     fetch
# Priority: 10
#
# Processes the backend response before it is delivered or cached.  When a
# valid CAPTCHA session cookie was present (bypass path) cheq_rti_backend_response
# is skipped entirely.  Otherwise the subroutine inspects the RTI verdict
# headers and may trigger a restart.
#
# Upload via Fastly CLI:
#   fastly vcl snippet create \
#     --service-id=<SERVICE_ID> --version=<VERSION> \
#     --name=cheq_rti_fetch --type=fetch --priority=10 \
#     --content=snippets/fetch.vcl
# ==============================================================================

if (!req.http.X-Cheq-Session-Bypass) {
    call cheq_rti_backend_response;
}
