# ==============================================================================
# CHEQ RTI – VCL Snippet: recv
# Type:     recv
# Priority: 10
#
# Verifies the CAPTCHA session cookie and, if valid, bypasses RTI for this
# request.  Otherwise delegates to cheq_rti_recv which handles:
#   - restart 0: stash original request, route to RTI backend
#   - restart 1: act on verdict (block / challenge / redirect / allow)
#
# IMPORTANT – set your origin backend name on the line marked TODO below.
#
# Upload via Fastly CLI:
#   fastly vcl snippet create \
#     --service-id=<SERVICE_ID> --version=<VERSION> \
#     --name=cheq_rti_recv --type=recv --priority=10 \
#     --content=snippets/recv.vcl
# ==============================================================================

# Verify the HMAC-signed CAPTCHA session cookie set after a successful solve.
# Must run before cheq_rti_recv and must set req.backend explicitly here
# because cheq_rti_session_check cannot know your origin backend name.
# Only check the session cookie on fresh requests.
# At restart 1 a block/challenge decision is already in flight — the session
# cookie must not be able to override it.
if (req.restarts == 0) {
    call cheq_rti_session_check;
    if (req.http.X-Cheq-Session-Valid == "true") {
        set req.http.X-Cheq-Session-Bypass = "1";
        set req.backend = F_origin_backend;  # Configure your origin backend in UI Fastly under "Origins" using the name 'origin_backend'.
        return(pass);
    }
}

call cheq_rti_recv;
