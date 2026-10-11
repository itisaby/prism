#!/usr/bin/env bash
# Demo break: point checkout-worker at an image tag that doesn't exist -> ErrImagePull / ImagePullBackOff in seconds.
set -euo pipefail
K="kubectl --context prism -n shop"
CONTAINER="$($K get deploy/checkout-worker -o jsonpath='{.spec.template.spec.containers[0].name}')"
$K set image deploy/checkout-worker "$CONTAINER=prism/checkout:v2-bad"
echo "checkout-worker -> prism/checkout:v2-bad (watch: kubectl --context prism -n shop get pods -w)"
