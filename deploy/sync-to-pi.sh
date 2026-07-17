#!/usr/bin/env bash
# Deploy concert-bloodhound (remote HTTP MCP) from Mac to Pi.
#
# Model (mirrors brain-mcp/deploy/sync-to-pi.sh): Mac builds, Pi runs the
# compiled dist/. ONE deliberate divergence — this script runs
# `npm ci --omit=dev` on the Pi EVERY deploy. brain-mcp's "no npm ci, run it
# by hand when deps change" was the documented crash-loop trap the gate's
# constraint 3 names (bloodhound gained express + the auth stack as brand-new
# deps with zero node_modules on the Pi). Deterministic beats fast here.
#
# runtime-state != disk-state: the running server caches the old bundle until
# restarted. This script restarts concert-bloodhound.service (SYSTEM unit,
# passwordless sudo) and PROVES the new code serves with (a) an authenticated
# MCP initialize POST and (b) a tools/call asserting structuredContent is
# present — the gate's done-bar for this service, not a bare 200.
#
# First-time provisioning (unit install, .env.local secrets) is deploy/
# provision-pi.sh — this script assumes both exist and fails loud if not.
#
# Usage:
#   ./deploy/sync-to-pi.sh
#   PI_HOST=100.118.159.68 ./deploy/sync-to-pi.sh   # Tailscale IP off-LAN

set -euo pipefail

PI_USER="${PI_USER:-brydup}"
PI_HOST="${PI_HOST:-brain-mcp.local}"
PI_PATH="${PI_PATH:-/home/$PI_USER/concert-bloodhound}"
MCP_PORT="${MCP_PORT:-3003}"
# Public path prefix (Option A: /bloodhound under the shared 443 Funnel). The
# service mounts every route under it — the provers must hit the prefixed paths.
BASE_PATH="${BASE_PATH:-/bloodhound}"
SSH_TIMEOUT="${SSH_TIMEOUT:-10}"

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_DIR"

echo "[sync] $REPO_DIR -> ${PI_USER}@${PI_HOST}:${PI_PATH}"

echo "[sync] Pre-flight ping ${PI_HOST}..."
if ! ping -c1 -W2 "$PI_HOST" >/dev/null 2>&1; then
    echo "[sync] ERROR: ${PI_HOST} unreachable." >&2
    echo "[sync]        Try PI_HOST=<tailscale-ip> (check 'tailscale status')." >&2
    exit 1
fi

echo "[sync] Building concert-bloodhound..."
npm run build

# rsync dist/ (--delete drops stale compiled files) + the two package files
# npm ci needs. EXCLUDE by construction: src/, .git/, node_modules, .env*
# (NEVER ship secrets — the Pi keeps its own .env.local).
echo "[sync] rsync dist/ + package files..."
rsync -a --delete -e "ssh -o ConnectTimeout=$SSH_TIMEOUT" \
    dist/ "${PI_USER}@${PI_HOST}:${PI_PATH}/dist/"
rsync -a -e "ssh -o ConnectTimeout=$SSH_TIMEOUT" \
    package.json package-lock.json "${PI_USER}@${PI_HOST}:${PI_PATH}/"

echo "[sync] npm ci + restart + prove-by-behavior on the Pi..."
ssh -o ConnectTimeout="$SSH_TIMEOUT" "${PI_USER}@${PI_HOST}" bash -s -- "$MCP_PORT" "$PI_PATH" "$BASE_PATH" <<'REMOTE'
set -euo pipefail
PORT="$1"
APP="$2"
BASE_PATH="$3"
export PATH="$HOME/.local/bin:$PATH"

[ -f "$APP/.env.local" ] || { echo "[pi] $APP/.env.local missing — run deploy/provision-pi.sh first" >&2; exit 1; }
[ -f /etc/systemd/system/concert-bloodhound.service ] || { echo "[pi] unit not installed — run deploy/provision-pi.sh first" >&2; exit 1; }

cd "$APP"
echo "[pi] npm ci --omit=dev (every deploy, by design)..."
npm ci --omit=dev --no-audit --no-fund 2>&1 | tail -2

oldpid="$(systemctl show concert-bloodhound.service -p MainPID --value)"
sudo -n systemctl restart concert-bloodhound.service
sleep 3
[ "$(systemctl is-active concert-bloodhound.service)" = active ] || { echo "[pi] NOT active after restart" >&2; journalctl -u concert-bloodhound.service -n 20 --no-pager >&2; exit 1; }
newpid="$(systemctl show concert-bloodhound.service -p MainPID --value)"
[ "$newpid" != "$oldpid" ] || { echo "[pi] MainPID unchanged ($newpid) — restart did not take" >&2; exit 1; }
echo "[pi] active, MainPID $oldpid -> $newpid"

SECRET="$(sed -n 's/^MCP_SECRET=//p' "$APP/.env.local" | tr -d '"')"
[ -n "$SECRET" ] || { echo "[pi] MCP_SECRET empty in .env.local" >&2; exit 1; }

# Proof 1 — authenticated initialize (protocol up, auth gate passes).
code="$(curl -s -o /tmp/cb_init.json -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}${BASE_PATH}/mcp" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"deploy-probe","version":"1.0"}}}')"
grep -q '"serverInfo"' /tmp/cb_init.json && ok=1 || ok=0
rm -f /tmp/cb_init.json
[ "$code" = 200 ] && [ "$ok" = 1 ] || { echo "[pi] initialize POST FAILED (HTTP $code, serverInfo=$ok)" >&2; exit 1; }
echo "[pi] initialize: 200 + serverInfo"

# Proof 2 — tools/call with structuredContent (the gate's done-bar: a bare
# initialize 200 proves transport+auth, not that tool output survives the
# HTTP path). Stateless transport accepts a single-shot call.
code="$(curl -s -o /tmp/cb_call.json -w '%{http_code}' -X POST "http://127.0.0.1:${PORT}${BASE_PATH}/mcp" \
  -H "Authorization: Bearer $SECRET" \
  -H "Content-Type: application/json" \
  -H "Accept: application/json, text/event-stream" \
  -d '{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"search_concerts","arguments":{"city":"Atlanta","size":2}}}')"
grep -q '"structuredContent"' /tmp/cb_call.json && sc=1 || sc=0
rm -f /tmp/cb_call.json
[ "$code" = 200 ] && [ "$sc" = 1 ] || { echo "[pi] tools/call FAILED (HTTP $code, structuredContent=$sc)" >&2; exit 1; }
echo "[pi] tools/call: 200 + structuredContent"
REMOTE

echo "[sync] DONE — deployed, restarted, proven by behavior."
