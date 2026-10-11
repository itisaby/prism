#!/usr/bin/env bash
# agentregistry v0.4.0 for PRISM: install arctl, start the registry, apply the
# MCP server catalog (servers.yaml), smoke-test the MCP Registry v0.1 API.
#
#   ./setup.sh          start + apply + smoke test (idempotent, safe to re-run)
#   ./setup.sh status   health + catalog names
#   ./setup.sh stop     docker stop the registry containers (data kept)
#
# Containers: reuses the existing `agentregistry-server` + `agent-registry-postgres`
# (compat API already enabled). If they don't exist, creates `prism-ar-server` +
# `prism-ar-postgres` (network prism-ar-net, volume prism-ar-pgdata).
# Never deletes containers, images or volumes.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
VERSION="v0.4.0"
IMAGE="ghcr.io/agentregistry-dev/agentregistry/server:$VERSION"
REGISTRY_URL="${AGENT_REGISTRY_URL:-http://localhost:12121}"
ARCTL="$HERE/bin/arctl"
export ARCTL_API_BASE_URL="$REGISTRY_URL"
EXPECTED=(sentry nimble github stripe prism-kubernetes prism-event-db)

t0=$(date +%s)
step() { printf '\n==> [%3ss] %s\n' "$(( $(date +%s) - t0 ))" "$*"; }
die() { echo "ERROR: $*" >&2; exit 1; }
exists() { docker container inspect "$1" >/dev/null 2>&1; }
healthy() { curl -fsS -m 2 "$REGISTRY_URL/v0/ping" >/dev/null 2>&1; }
wait_healthy() { # $1 = seconds
  for _ in $(seq 1 "$1"); do healthy && return 0; sleep 1; done; return 1
}

command -v docker >/dev/null || die "docker not found"
command -v jq >/dev/null || die "jq not found (brew install jq)"
docker info >/dev/null 2>&1 || die "Docker isn't responding. Start Docker Desktop yourself, then re-run."

# Pick the container pair.
if exists agentregistry-server && exists agent-registry-postgres; then
  SERVER=agentregistry-server; PG=agent-registry-postgres
else
  SERVER=prism-ar-server; PG=prism-ar-postgres
fi

case "${1:-up}" in
  up) ;;
  stop) docker stop "$SERVER" "$PG" >/dev/null 2>&1 || true; echo "stopped $SERVER $PG"; exit 0 ;;
  status)
    healthy && echo "healthy: $REGISTRY_URL ($SERVER)" || { echo "not healthy: $REGISTRY_URL"; exit 1; }
    curl -fsS -m 3 "$REGISTRY_URL/v0.1/servers?limit=100" | jq -r '.servers[].server | "\(.name)\t\(.title // "")\t\(.remotes[0].url // "")"'
    exit 0 ;;
  *) echo "usage: $0 [up|status|stop]" >&2; exit 2 ;;
esac

# 1. arctl, pinned, local to this directory (gitignored).
step "arctl $VERSION -> infra/registry/bin"
if [[ ! -x "$ARCTL" ]] || [[ "$("$ARCTL" version --json 2>/dev/null | jq -r '.cli.version // empty')" != "$VERSION" ]]; then
  os="$(uname | tr '[:upper:]' '[:lower:]')"
  case "$(uname -m)" in x86_64|amd64) arch=amd64 ;; arm64|aarch64) arch=arm64 ;; *) die "unsupported arch $(uname -m)" ;; esac
  asset="https://github.com/agentregistry-dev/agentregistry/releases/download/$VERSION/arctl-$os-$arch"
  mkdir -p "$HERE/bin"
  tmp="$(mktemp -d)"
  curl -fsSLo "$tmp/arctl" "$asset"
  curl -fsSLo "$tmp/arctl.sha256" "$asset.sha256"
  want="$(awk '{print $1}' "$tmp/arctl.sha256")"
  got="$(shasum -a 256 "$tmp/arctl" | awk '{print $1}')"
  [[ -n "$want" && "$want" == "$got" ]] || die "arctl checksum mismatch"
  chmod +x "$tmp/arctl" && mv "$tmp/arctl" "$ARCTL" && rm -rf "$tmp"
fi
"$ARCTL" version --json | jq -r '"arctl " + .cli.version + " (" + .cli.git_commit + ")"'

# 2. Containers.
step "registry containers ($SERVER, $PG)"
if [[ "$SERVER" == agentregistry-server ]]; then
  docker container inspect -f '{{.Config.Image}}' "$SERVER" | grep -qx "$IMAGE" \
    || echo "WARN: $SERVER is not running $IMAGE"
  docker container inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SERVER" \
    | grep -qx 'AGENT_REGISTRY_MCP_REGISTRY_COMPAT_ENABLED=true' \
    || die "$SERVER lacks AGENT_REGISTRY_MCP_REGISTRY_COMPAT_ENABLED=true; stop it and re-run after renaming, or ask before recreating"
else
  # Fallback: fresh, PRISM-owned pair. Local-only, catalog use (no auth in the OSS build).
  docker network inspect prism-ar-net >/dev/null 2>&1 || docker network create prism-ar-net >/dev/null
  docker volume inspect prism-ar-pgdata >/dev/null 2>&1 || docker volume create prism-ar-pgdata >/dev/null
  if ! exists "$PG"; then
    docker run -d --name "$PG" --network prism-ar-net --restart unless-stopped \
      -e POSTGRES_DB=agentregistry -e POSTGRES_USER=agentregistry -e POSTGRES_PASSWORD=agentregistry \
      -v prism-ar-pgdata:/var/lib/postgresql/data postgres:16 >/dev/null
  fi
  if ! exists "$SERVER"; then
    docker run -d --name "$SERVER" --network prism-ar-net --restart unless-stopped \
      -p 127.0.0.1:12121:8080 \
      -e "AGENT_REGISTRY_DATABASE_URL=postgres://agentregistry:agentregistry@$PG:5432/agentregistry?sslmode=disable" \
      -e AGENT_REGISTRY_SERVER_ADDRESS=:8080 \
      -e AGENT_REGISTRY_MCP_REGISTRY_COMPAT_ENABLED=true \
      -e AGENT_REGISTRY_MCP_REGISTRY_COMPAT_PATH_PREFIX= \
      -e AGENT_REGISTRY_ENABLE_REGISTRY_VALIDATION=false \
      -e AGENT_REGISTRY_PLATFORM_MODE=docker \
      -v /var/run/docker.sock:/var/run/docker.sock \
      --add-host host.docker.internal:host-gateway \
      --entrypoint /app/bin/arctl-server "$IMAGE" >/dev/null
  fi
fi

docker start "$PG" >/dev/null
for _ in $(seq 1 30); do
  docker exec "$PG" pg_isready -q -U agentregistry -d agentregistry && break; sleep 1
done
docker exec "$PG" pg_isready -q -U agentregistry -d agentregistry || die "$PG not ready"
echo "postgres ready"

# 3. Health. Known gotcha: the server can start before Postgres resolves and get
# stuck in restart backoff -> one `docker restart` fixes it.
step "wait for $REGISTRY_URL/v0/ping"
docker start "$SERVER" >/dev/null
if ! wait_healthy 30; then
  echo "unhealthy; docker restart $SERVER"
  docker restart "$SERVER" >/dev/null
  wait_healthy 45 || die "registry not healthy (docker logs $SERVER)"
fi
echo "healthy"

# 4. Catalog.
step "arctl apply -f servers.yaml"
"$ARCTL" apply -f "$HERE/servers.yaml"

# 5. Smoke test the MCP Registry v0.1 compat API.
step "v0.1 smoke test"
list="$(curl -fsS -m 5 "$REGISTRY_URL/v0.1/servers?limit=100")"
echo "$list" | jq -r '"list: \(.metadata.count) servers", (.servers[].server | "  \(.name)  \(.title // "")  \(.remotes[0].url // "-")")'
missing=()
for n in "${EXPECTED[@]}"; do
  echo "$list" | jq -e --arg n "default/$n" 'any(.servers[]; .server.name == $n)' >/dev/null || missing+=("$n")
done
[[ ${#missing[@]} -eq 0 ]] || die "missing from v0.1 list: ${missing[*]}"
search="$(curl -fsS -m 5 "$REGISTRY_URL/v0.1/servers?search=sentry")"
echo "$search" | jq -e 'any(.servers[]; .server.name == "default/sentry")' >/dev/null || die "v0.1 search=sentry returned no sentry"
echo "search=sentry: $(echo "$search" | jq -r '[.servers[].server.name] | join(", ")')"
echo "$list" | jq -e '[.servers[].server.remotes[]?.headers // empty] | length == 0' >/dev/null \
  || echo "WARN: some remotes carry headers (the v0.1 API returns them verbatim)"

step "done"
echo "UI       : $REGISTRY_URL"
echo "API docs : $REGISTRY_URL/docs"
echo "v0.1 API : $REGISTRY_URL/v0.1/servers"
