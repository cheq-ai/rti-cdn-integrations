#!/usr/bin/env bash
# Simple setup script equivalent to the Windows `setup.cmd` variant.
# Edit or export the environment variables below before running.

set -euo pipefail

# Configure these (or export them in your environment)
SERVICE_ID="${SERVICE_ID:-}" # Fastly Service ID to update (required)
VERSION="${VERSION:-}" # Version number to use for VCL snippets (draft clone version)
FASTLY="${FASTLY:-fastly}"
SNIPPETS="${SNIPPETS:-$(cd "$(dirname "$0")" && pwd)/snippets}"

if [ -z "$SERVICE_ID" ] || [ -z "$VERSION" ]; then
  echo "Please set SERVICE_ID and VERSION (clone active first if needed)."
  echo "Example: SERVICE_ID=xyz VERSION=123 $0"
  exit 1
fi

echo "Using Fastly binary: $FASTLY"
echo "Snippets dir: $SNIPPETS"

echo "--- Step: Create backends ---"
"$FASTLY" backend create --service-id="$SERVICE_ID" --version="$VERSION" \
  --name=F_cheq_rti_backend \
  --address=rti-global.cheqzone.com \
  --port=443 \
  --use-ssl \
  --ssl-cert-hostname=rti-global.cheqzone.com \
  --ssl-sni-hostname=rti-global.cheqzone.com \
  --autoclone=false || echo "(F_cheq_rti_backend may already exist)"

"$FASTLY" backend create --service-id="$SERVICE_ID" --version="$VERSION" \
  --name=F_cheq_captcha_backend \
  --address=entirely-wanted-colt.edgecompute.app \
  --port=443 \
  --use-ssl \
  --ssl-cert-hostname=entirely-wanted-colt.edgecompute.app \
  --ssl-sni-hostname=entirely-wanted-colt.edgecompute.app \
  --autoclone=false || echo "(F_cheq_captcha_backend may already exist)"

"$FASTLY" backend create --service-id="$SERVICE_ID" --version="$VERSION" \
  --name=F_origin_backend \
  --address=tel-aviv.blog \
  --port=443 \
  --use-ssl \
  --ssl-cert-hostname=tel-aviv.blog \
  --ssl-sni-hostname=tel-aviv.blog \
  --autoclone=false || echo "(F_origin_backend may already exist)"

echo "--- Step: Create Edge Dictionaries ---"
"$FASTLY" dictionary create --service-id="$SERVICE_ID" --version="$VERSION" --name=general_config --autoclone=false || echo "(general_config may already exist)"
"$FASTLY" dictionary create --service-id="$SERVICE_ID" --version="$VERSION" --name=challenge_tt_codes --autoclone=false || echo "(challenge_tt_codes may already exist)"
"$FASTLY" dictionary create --service-id="$SERVICE_ID" --version="$VERSION" --name=redirect_tt_codes --autoclone=false || echo "(redirect_tt_codes may already exist)"
"$FASTLY" dictionary create --service-id="$SERVICE_ID" --version="$VERSION" --name=block_tt_codes --autoclone=false || echo "(block_tt_codes may already exist)"
"$FASTLY" dictionary create --service-id="$SERVICE_ID" --version="$VERSION" --name=ignored_paths_config --autoclone=false || echo "(ignored_paths_config may already exist)"

# Optional: create a compute config store (Edge Dictionary) used by Compute@Edge
echo "--- Optional: Create compute_config Edge Dictionary (if needed) ---"
"$FASTLY" dictionary create --service-id="$SERVICE_ID" --version="$VERSION" --name=compute_config --autoclone=false || echo "(compute_config may already exist)"

"$FASTLY" vcl snippet create --service-id="$SERVICE_ID" --version="$VERSION" --name=cheq_rti_init    --type=none    --priority=10 --content="$SNIPPETS/init.vcl"
"$FASTLY" vcl snippet create --service-id="$SERVICE_ID" --version="$VERSION" --name=cheq_rti_recv    --type=recv    --priority=10 --content="$SNIPPETS/recv.vcl"
"$FASTLY" vcl snippet create --service-id="$SERVICE_ID" --version="$VERSION" --name=cheq_rti_pass    --type=pass    --priority=10 --content="$SNIPPETS/pass.vcl"
"$FASTLY" vcl snippet create --service-id="$SERVICE_ID" --version="$VERSION" --name=cheq_rti_fetch   --type=fetch   --priority=10 --content="$SNIPPETS/fetch.vcl"
"$FASTLY" vcl snippet create --service-id="$SERVICE_ID" --version="$VERSION" --name=cheq_rti_deliver --type=deliver --priority=10 --content="$SNIPPETS/deliver.vcl"
"$FASTLY" vcl snippet create --service-id="$SERVICE_ID" --version="$VERSION" --name=cheq_rti_error   --type=error   --priority=10 --content="$SNIPPETS/error.vcl"

echo "Snippet upload commands executed. Review output for errors."

# NOTE: This VCL setup script is intentionally VCL-only. Compute build/deploy
# is handled by the dedicated compute setup script: ../compute/setup_compute.sh
