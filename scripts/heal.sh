#!/usr/bin/env bash
# Demo heal: back to the good image and wait for the rollout.
set -euo pipefail
K="kubectl --context prism -n shop"
CONTAINER="$($K get deploy/checkout-worker -o jsonpath='{.spec.template.spec.containers[0].name}')"
$K set image deploy/checkout-worker "$CONTAINER=prism/checkout:v1"
$K rollout status deploy/checkout-worker --timeout=120s
