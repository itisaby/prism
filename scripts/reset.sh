#!/usr/bin/env bash
# Demo reset (<10 s): heal the cluster, clear incidents/decisions/refresh counters.
#   ./scripts/reset.sh          keep saved playbooks (for the "second break" beat)
#   ./scripts/reset.sh --all    also forget playbooks (start the demo from scratch)
set -euo pipefail
cd "$(dirname "$0")/.."
KEEP=true; [[ "${1:-}" == "--all" ]] && KEEP=false
kubectl -n shop get deploy checkout-worker -o jsonpath='{.spec.template.spec.containers[0].image}' | grep -q ':v1$' || ./scripts/heal.sh
curl -fsS -X POST localhost:7100/api/admin/reset -H 'content-type: application/json' -d "{\"keepPlaybooks\": $KEEP}" >/dev/null
echo "reset done (playbooks kept: $KEEP)"
