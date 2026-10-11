#!/usr/bin/env bash
# Expose the local PRISM demo over one public HTTPS URL (Cloudflare quick tunnel; no account needed).
# Assumes the stack is up (scripts/dev.sh). Starts: web prod build (:3001), public proxy (:8090), tunnel.
# The URL is printed and saved to data/public-url. Quick-tunnel URLs change on every restart.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
command -v cloudflared >/dev/null || { echo "cloudflared missing: brew install cloudflared"; exit 1; }

if ! lsof -ti tcp:3001 -sTCP:LISTEN >/dev/null; then
  [[ -d web/.next/server ]] || (cd web && npx next build)
  (cd web && nohup npx next start -p 3001 > ../data/web-prod.log 2>&1 &)
fi
lsof -ti tcp:8090 -sTCP:LISTEN >/dev/null || (nohup node scripts/public-proxy.mjs > data/public-proxy.log 2>&1 &)
pkill -f "cloudflared tunnel .*--url http://localhost:8090" 2>/dev/null || true
(nohup cloudflared tunnel --no-autoupdate --protocol http2 --url http://localhost:8090 > data/tunnel.log 2>&1 &)

for _ in $(seq 1 30); do
  URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' data/tunnel.log | head -1 || true)
  [[ -n "$URL" ]] && break
  sleep 1
done
[[ -n "${URL:-}" ]] || { echo "tunnel did not come up; see data/tunnel.log"; exit 1; }
echo "$URL" > data/public-url
echo "PRISM public demo: $URL"
echo "Judge link for a workspace: $URL/j/<workspace-id>?as=judge   (Share → QR in the app uses the page origin)"
