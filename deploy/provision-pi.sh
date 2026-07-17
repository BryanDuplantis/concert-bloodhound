#!/usr/bin/env bash
# ONE-TIME Pi provisioning for concert-bloodhound's remote HTTP transport.
# Idempotent-guarded: refuses to overwrite an existing .env.local (a re-run
# would rotate MCP_SECRET/OAUTH_AUTHORIZE_PASSWORD and orphan live tokens).
#
# What it does, all ON the Pi (secrets are minted at the consumer — never
# staged through the Mac clipboard or argv; the two Mac-held API keys travel
# file→ssh-stdin→file):
#   1. mkdir the app dir
#   2. Write .env.local: MCP_SECRET + OAUTH_AUTHORIZE_PASSWORD minted via
#      openssl on the Pi; OAUTH_ALLOWED_REDIRECT_URIS copied server-side from
#      brain-mcp's live .env.local (same claude.ai callback); PUBLIC_BASE_URL
#      pinned to the Funnel :10000 origin; chmod 600 (explicit — redirect
#      rewrites drop modes).
#   3. Append TICKETMASTER_API_KEY + JAMBASE_API_KEY piped from the Mac .env.
#   4. Pre-create the OAuth state dir mode 700.
#   5. Install + enable the systemd unit (does not start — first start comes
#      from sync-to-pi.sh which also ships the code).
#
# Usage: ./deploy/provision-pi.sh   (PI_HOST=<tailscale-ip> ... off-LAN)

set -euo pipefail

PI_USER="${PI_USER:-brydup}"
PI_HOST="${PI_HOST:-brain-mcp.local}"
PI_PATH="${PI_PATH:-/home/$PI_USER/concert-bloodhound}"
SSH_TIMEOUT="${SSH_TIMEOUT:-10}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

[ -f .env ] || { echo "[provision] ERROR: local .env with API keys not found" >&2; exit 1; }

echo "[provision] Pre-flight ping ${PI_HOST}..."
ping -c1 -W2 "$PI_HOST" >/dev/null 2>&1 || { echo "[provision] ERROR: ${PI_HOST} unreachable" >&2; exit 1; }

echo "[provision] Writing .env.local on the Pi (secrets minted there)..."
ssh -o ConnectTimeout="$SSH_TIMEOUT" "${PI_USER}@${PI_HOST}" bash -s -- "$PI_PATH" <<'REMOTE'
set -euo pipefail
APP="$1"
ENVF="$APP/.env.local"
if [ -f "$ENVF" ]; then
    echo "[pi] $ENVF already exists — refusing to overwrite (would rotate live secrets)." >&2
    echo "[pi] Delete it on the Pi first if a rotation is intended." >&2
    exit 3
fi
mkdir -p "$APP"
REDIRECTS="$(sed -n 's/^OAUTH_ALLOWED_REDIRECT_URIS=//p' "$HOME/brain-mcp/.env.local")"
[ -n "$REDIRECTS" ] || { echo "[pi] could not read redirect allowlist from brain-mcp .env.local" >&2; exit 1; }
umask 077
{
    echo "MCP_PORT=3003"
    echo "PUBLIC_BASE_URL=https://raspberrypi.tail5a9795.ts.net:10000"
    echo "MCP_SECRET=$(openssl rand -hex 32)"
    echo "OAUTH_AUTHORIZE_PASSWORD=$(openssl rand -hex 16)"
    echo "OAUTH_ALLOWED_REDIRECT_URIS=$REDIRECTS"
    echo "MCP_ALLOWED_ORIGINS=https://claude.ai,https://claude.com"
} > "$ENVF"
chmod 600 "$ENVF"
mkdir -p "$HOME/.local/state/concert-bloodhound/oauth"
chmod 700 "$HOME/.local/state/concert-bloodhound" "$HOME/.local/state/concert-bloodhound/oauth"
echo "[pi] .env.local written ($(wc -l < "$ENVF") lines, mode $(stat -c %a "$ENVF"))"
REMOTE

echo "[provision] Appending API keys (file -> ssh stdin -> file, never argv)..."
grep -E '^(TICKETMASTER_API_KEY|JAMBASE_API_KEY)=' .env | \
    ssh -o ConnectTimeout="$SSH_TIMEOUT" "${PI_USER}@${PI_HOST}" \
    "cat >> '$PI_PATH/.env.local' && chmod 600 '$PI_PATH/.env.local'"

echo "[provision] Verifying every key is present AND non-empty (PM-8)..."
ssh -o ConnectTimeout="$SSH_TIMEOUT" "${PI_USER}@${PI_HOST}" bash -s -- "$PI_PATH" <<'REMOTE'
set -euo pipefail
ENVF="$1/.env.local"
missing=0
for k in MCP_PORT PUBLIC_BASE_URL MCP_SECRET OAUTH_AUTHORIZE_PASSWORD OAUTH_ALLOWED_REDIRECT_URIS MCP_ALLOWED_ORIGINS TICKETMASTER_API_KEY JAMBASE_API_KEY; do
    v="$(sed -n "s/^$k=//p" "$ENVF")"
    if [ -z "$v" ]; then echo "[pi] EMPTY OR MISSING: $k" >&2; missing=1; fi
done
[ "$missing" = 0 ] || exit 1
echo "[pi] all 8 keys present and non-empty; mode $(stat -c %a "$ENVF")"
REMOTE

echo "[provision] Installing systemd unit..."
rsync -a -e "ssh -o ConnectTimeout=$SSH_TIMEOUT" \
    deploy/concert-bloodhound.service "${PI_USER}@${PI_HOST}:/tmp/concert-bloodhound.service"
ssh -o ConnectTimeout="$SSH_TIMEOUT" "${PI_USER}@${PI_HOST}" \
    "sudo -n cp /tmp/concert-bloodhound.service /etc/systemd/system/ && rm /tmp/concert-bloodhound.service && sudo -n systemctl daemon-reload && sudo -n systemctl enable concert-bloodhound.service && echo '[pi] unit installed + enabled'"

echo "[provision] DONE. Next: ./deploy/sync-to-pi.sh (ships code, npm ci, starts, proves)."
echo "[provision] The consent password lives ONLY on the Pi:"
echo "[provision]   ssh ${PI_USER}@${PI_HOST} \"sed -n 's/^OAUTH_AUTHORIZE_PASSWORD=//p' $PI_PATH/.env.local\""
