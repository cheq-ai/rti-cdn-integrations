# ==============================================================================
# CHEQ RTI – VCL Snippet: deliver
# Type:     deliver
# Priority: 10
#
# Applies any final response mutations just before the response is sent to the
# client (strip internal headers, generate and set the CAPTCHA session cookie
# on a successful solve, etc.).
#
# Upload via Fastly CLI:
#   fastly vcl snippet create \
#     --service-id=<SERVICE_ID> --version=<VERSION> \
#     --name=cheq_rti_deliver --type=deliver --priority=10 \
#     --content=snippets/deliver.vcl
# ==============================================================================

call cheq_rti_deliver;
