#!/usr/bin/env bash
# Run agentgateway v1.6.0 in Docker:
#   :7200  MCP (k8s, event, github, stripe routes; writes need a signed approval)
#   :4000  LLM (Claude via the UI-managed "prism-composer" model, see llm-model.sh)
#   :15000 admin UI (Logs page shows MCP + LLM calls with user, tokens, cost)
# Plus traces: agentgateway → OpenTelemetry Collector (:4319) → Jaeger (:16686) and Sentry.
#   ./run.sh validate   config validation only
#   ./run.sh            (re)start
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=cr.agentgateway.dev/agentgateway:v1.6.0
NAME=prism-gw
VOL=prism-gw-data
[[ -f approval-jwks.json ]] || { echo "approval-jwks.json missing: start the PRISM server once (it writes the public key)"; exit 1; }

# Writable volume (the image runs as uid 65532) + the Anthropic key for the LLM route, piped from ../../.env, never printed.
docker volume create "$VOL" >/dev/null
docker run --rm -v "$VOL":/data busybox:1.36 chown 65532:65532 /data
KEY_LINE=$(grep -E '^ANTHROPIC_API_KEY=.+' ../../.env || true)
if [[ -n "$KEY_LINE" ]]; then
  printf '%s' "${KEY_LINE#ANTHROPIC_API_KEY=}" | docker run -i --rm -v "$VOL":/data busybox:1.36 \
    sh -c 'cat > /data/anthropic.key && chown 65532:65532 /data/anthropic.key && chmod 400 /data/anthropic.key'
fi
unset KEY_LINE

if [[ "${1:-}" == "validate" ]]; then
  exec docker run --rm -v "$VOL":/data -v "$PWD":/config:ro "$IMAGE" -f /config/config.yaml --validate-only
fi

# Jaeger for traces (container prism-traces): start it if it exists, create it otherwise.
if [[ -z "$(docker ps -q -f name=^prism-traces$)" ]]; then
  docker start prism-traces >/dev/null 2>&1 || \
    docker run -d --name prism-traces -p 127.0.0.1:16686:16686 -p 127.0.0.1:4317:4317 jaegertracing/all-in-one:1.62.0 >/dev/null
fi
# OpenTelemetry Collector (prism-otel): fans gateway traces out to Jaeger and, when SENTRY_DSN is set, to Sentry's OTLP endpoint.
# The endpoint and public key are derived from the DSN (https://<key>@o<org>.ingest.<region>.sentry.io/<project>).
DSN=$(grep -E '^SENTRY_DSN=.+' ../../.env | cut -d= -f2- || true)
OTEL_ENV=()
if [[ -n "$DSN" ]]; then
  KEY=${DSN#https://}; KEY=${KEY%%@*}; HOST=${DSN#*@}; HOST=${HOST%%/*}; PROJECT=${DSN##*/}
  OTEL_ENV=(-e "SENTRY_PUBLIC_KEY=$KEY" -e "SENTRY_OTLP_TRACES_ENDPOINT=https://$HOST/api/$PROJECT/integration/otlp/v1/traces")
else
  OTEL_ENV=(-e "SENTRY_PUBLIC_KEY=none" -e "SENTRY_OTLP_TRACES_ENDPOINT=http://localhost:1/disabled")
fi
docker rm -f prism-otel >/dev/null 2>&1 || true
docker run -d --name prism-otel --add-host host.docker.internal:host-gateway "${OTEL_ENV[@]}" \
  -v "$PWD/otel-collector.yaml":/etc/otelcol-contrib/config.yaml:ro -p 127.0.0.1:4319:4317 \
  otel/opentelemetry-collector-contrib:0.161.0 >/dev/null
unset DSN KEY OTEL_ENV

docker rm -f "$NAME" >/dev/null 2>&1 || true
docker run -d --name "$NAME" --add-host host.docker.internal:host-gateway \
  -v "$PWD":/config:ro -v "$VOL":/data \
  -p 127.0.0.1:7200:7200 -p 127.0.0.1:4000:4000 -p 127.0.0.1:15000:15000 \
  "$IMAGE" -f /config/config.yaml >/dev/null
sleep 2
./llm-model.sh
echo "agentgateway: MCP :7200 · LLM :4000 · UI http://localhost:15000/ui · traces http://localhost:16686"
