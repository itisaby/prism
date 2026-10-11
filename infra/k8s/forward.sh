#!/usr/bin/env bash
# Self-healing port-forward: http://127.0.0.1:7300 -> svc/k8s-mcp (prism-system).
# `kubectl port-forward` pins one pod and keeps "running" after that pod is replaced, so probe /healthz through
# the tunnel every 5 s and restart the forward whenever it stops answering.
PORT="${PORT:-7300}"
K="kubectl --context prism"
PF=""
cleanup() { [ -n "$PF" ] && kill "$PF" 2>/dev/null; exit 0; }
trap cleanup INT TERM

while true; do
  $K -n prism-system port-forward svc/k8s-mcp "$PORT:80" --address 127.0.0.1 >/dev/null 2>&1 &
  PF=$!
  echo "$(date '+%H:%M:%S') [forward] started (pid $PF) on 127.0.0.1:$PORT"
  for _ in 1 2 3 4 5 6 7 8 9 10; do curl -sf -m 2 "http://127.0.0.1:$PORT/healthz" >/dev/null && break; sleep 1; done
  while kill -0 "$PF" 2>/dev/null && curl -sf -m 3 "http://127.0.0.1:$PORT/healthz" >/dev/null; do sleep 5; done
  echo "$(date '+%H:%M:%S') [forward] tunnel unhealthy; reconnecting"
  kill "$PF" 2>/dev/null; wait "$PF" 2>/dev/null
  sleep 1
done
