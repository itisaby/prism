#!/usr/bin/env bash
# Run agentgateway v1.6.0 in Docker on 127.0.0.1:7200 (MCP) and :15000 (admin UI).
#   ./run.sh validate   config validation only
#   ./run.sh            (re)start the gateway container
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=cr.agentgateway.dev/agentgateway:v1.6.0
NAME=prism-gw
[[ -f approval-jwks.json ]] || { echo "approval-jwks.json missing: start the PRISM server once (it writes the public key)"; exit 1; }
if [[ "${1:-}" == "validate" ]]; then
  exec docker run --rm -v "$PWD":/config:ro "$IMAGE" -f /config/config.yaml --validate-only
fi
docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --add-host host.docker.internal:host-gateway \
  -v "$PWD":/config:ro -p 127.0.0.1:7200:7200 -p 127.0.0.1:15000:15000 \
  "$IMAGE" -f /config/config.yaml >/dev/null
echo "agentgateway: http://localhost:7200/k8s/mcp · admin http://localhost:15000/ui · logs: docker logs -f $NAME"
