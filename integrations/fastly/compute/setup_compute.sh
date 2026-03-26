#!/usr/bin/env bash
set -euo pipefail

# ── Fill in before running ────────────────────────────────────────────────────
FASTLY_API_TOKEN="${FASTLY_API_TOKEN:-}" # Fill in your Fastly API token with write permissions
VERSION="${VERSION:-}" # Fill in the version number to use for VCL snippets (draft clone version)
#RECAPTCHA_SECRET_KEY="${RECAPTCHA_SECRET_KEY:-}"
DEBUGGING_ENABLED="${DEBUGGING_ENABLED:-false}"
# ─────────────────────────────────────────────────────────────────────────────

FASTLY="${FASTLY:-fastly}"
COMPUTE_DIR="$(cd "$(dirname "$0")" && pwd)"

[ -z "$FASTLY_API_TOKEN" ]     && echo "Fill in FASTLY_API_TOKEN at the top of this script."    && exit 1
#[ -z "$RECAPTCHA_SECRET_KEY" ] && echo "Fill in RECAPTCHA_SECRET_KEY at the top of this script." && exit 1

# Create config store
echo "--- Creating cheq_rti_config Config Store ---"
"$FASTLY" config-store create --name cheq_rti_config 2>/dev/null || echo "(config store already exists)"

# Write entries
# For now create the entries manually
#echo "--- Writing Config Store entries ---"
#STORE_ID=$(
#  "$FASTLY" config-store list 2>/dev/null \
#  | awk '/cheq_rti_config/ { print $2; exit }'
#)
#"$FASTLY" config-store-entry create --store-id "$STORE_ID" --key recaptcha_secret_key --value "$RECAPTCHA_SECRET_KEY" 2>/dev/null || "$FASTLY" config-store-entry update --store-id "$STORE_ID" --key recaptcha_secret_key --value "$RECAPTCHA_SECRET_KEY"
#"$FASTLY" config-store-entry create --store-id "$STORE_ID" --key debugging_enabled    --value "$DEBUGGING_ENABLED"    2>/dev/null || "$FASTLY" config-store-entry update --store-id "$STORE_ID" --key debugging_enabled    --value "$DEBUGGING_ENABLED"

# Build and deploy (fastly.toml [setup.dictionaries] handles linking automatically)
echo "--- Building ---"
npm install --prefix "$COMPUTE_DIR"
"$FASTLY" compute build --directory "$COMPUTE_DIR"

echo "--- Deploying ---"
"$FASTLY" compute deploy --directory "$COMPUTE_DIR" --accept-defaults

echo "Done."
