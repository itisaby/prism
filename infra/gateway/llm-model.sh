#!/usr/bin/env bash
# Create the LLM route in agentgateway's UI-managed overlay (idempotent): a gateway on :4000 and a model
# "prism-composer" matching claude-*, provider anthropic, passthrough (PRISM's request body goes through unchanged),
# with the key read from the data volume. PRISM points the Anthropic SDK at http://localhost:4000.
set -euo pipefail
ADMIN=${ADMIN:-http://localhost:15000}
for i in $(seq 1 20); do curl -sf "$ADMIN/api/config/resources" >/dev/null && break; sleep 0.5; done
put() { # PUT /api/config/resources/<kind> takes {"resources":[{"value":…}]} (a bare value is silently ignored)
  curl -sf -X PUT "$ADMIN/api/config/resources/$1" -H 'content-type: application/json' -d "{\"resources\":[{\"value\":$2}]}" >/dev/null \
    && echo "  llm overlay: $1 ok" || echo "  llm overlay: $1 FAILED"
}
put traffic.gateway '{"name":"default","port":4000}'
put llm.settings '{"gateways":"default"}'
put llm.model '{"id":"prism-composer","name":"claude-*","provider":"anthropic","passthrough":"detect","params":{"apiKey":{"file":"/data/anthropic.key"}}}'
