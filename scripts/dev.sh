#!/usr/bin/env bash
# Start the local stack: k8s port-forward, event DB MCP (:7101), agentgateway, PRISM API (:7100), web (:3000). Logs in data/.
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p data
pgrep -f "infra/k8s/forward.sh" >/dev/null || (nohup ./infra/k8s/forward.sh > data/forward.log 2>&1 &)
lsof -ti tcp:7101 -sTCP:LISTEN >/dev/null || (cd mcp-event && nohup npx tsx src/index.ts > ../data/event.log 2>&1 &)
[[ -n "$(docker ps -q -f name=^prism-gw$)" ]] || ./infra/gateway/run.sh
pkill -f "tsx src/index.ts" 2>/dev/null || true
(cd server && nohup npx tsx src/index.ts > ../data/server.log 2>&1 &)
lsof -ti tcp:3000 -sTCP:LISTEN >/dev/null || (cd web && nohup npx next dev -p 3000 > ../data/web.log 2>&1 &)
sleep 4; tail -3 data/server.log
echo "PRISM: http://localhost:3000 · API :7100 · gateway :7200 (admin :15000)"
