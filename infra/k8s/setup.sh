#!/usr/bin/env bash
# Idempotent: minikube profile `prism` up (metrics-server) -> build images into it -> apply manifests ->
# bearer token secret (from K8S_MCP_TOKEN in .env; generated and saved there if empty, never printed) -> wait.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROFILE=prism
ENV_FILE="$ROOT/.env"
K="kubectl --context $PROFILE"

say() { printf '\n==> %s\n' "$*"; }

say "minikube profile $PROFILE"
if [ "$(minikube -p "$PROFILE" status --format '{{.Host}}/{{.APIServer}}' 2>/dev/null || true)" != "Running/Running" ]; then
  minikube start -p "$PROFILE" --addons=metrics-server
fi
minikube -p "$PROFILE" addons enable metrics-server >/dev/null
$K get nodes

say "building images inside minikube"
# `minikube image build` exits 0 even when the build fails, so look for the failure ourselves.
build() {
  local out; out="$(minikube -p "$PROFILE" image build -t "$1" "$2" 2>&1)" || true
  if grep -qiE '^ERROR|failed to (build|solve)' <<<"$out"; then echo "$out" | tail -20; echo "image build failed: $1" >&2; exit 1; fi
  echo "built $1"
}
build prism/checkout:v1 "$ROOT/infra/k8s/checkout"
build prism/k8s-mcp:dev "$ROOT/mcp-k8s"

say "applying manifests"
$K apply -f "$ROOT/infra/k8s/apps.yaml"
$K apply -f "$ROOT/infra/k8s/mcp.yaml"

say "bearer token (K8S_MCP_TOKEN in .env)"
touch "$ENV_FILE"
TOKEN="$(grep -E '^K8S_MCP_TOKEN=' "$ENV_FILE" | tail -1 | cut -d= -f2- | tr -d '"'"'"' \r' || true)"
if [ -z "$TOKEN" ]; then
  TOKEN="$(openssl rand -hex 32)"
  NEW_TOKEN="$TOKEN" node -e '
    const fs = require("fs"); const p = process.argv[1]; const line = "K8S_MCP_TOKEN=" + process.env.NEW_TOKEN;
    let s = fs.readFileSync(p, "utf8");
    s = /^K8S_MCP_TOKEN=.*$/m.test(s) ? s.replace(/^K8S_MCP_TOKEN=.*$/m, line) : s + (s && !s.endsWith("\n") ? "\n" : "") + line + "\n";
    fs.writeFileSync(p, s);' "$ENV_FILE"
  echo "generated a new token and saved it to .env (not shown)"
else
  echo "using the existing token from .env (not shown)"
fi
printf %s "$TOKEN" | $K -n prism-system create secret generic k8s-mcp-token --from-file=token=/dev/stdin \
  --dry-run=client -o yaml | $K apply -f - >/dev/null
unset TOKEN
echo "secret prism-system/k8s-mcp-token up to date"

say "rolling out"
# Same :dev tag after a rebuild (and maybe a new token), so restart to pick both up.
$K -n prism-system rollout restart deploy/k8s-mcp >/dev/null
for d in storefront cart-api redis checkout-worker load-gen; do $K -n shop rollout status deploy/$d --timeout=180s; done
$K -n payments rollout status deploy/ledger --timeout=180s
$K -n prism-system rollout status deploy/k8s-mcp --timeout=180s

say "done"
$K get pods -A -l 'app in (storefront,cart-api,redis,checkout-worker,load-gen,ledger,k8s-mcp)'
echo
echo "Next: nohup infra/k8s/forward.sh > data/forward.log 2>&1 &   -> http://127.0.0.1:7300/mcp"
