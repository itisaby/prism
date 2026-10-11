#!/usr/bin/env bash
# Serve the voice-following pitch on localhost (the mic needs localhost or https) and open it.
set -euo pipefail
cd "$(dirname "$0")/../docs/pitch"
PORT="${PORT:-8090}"
(sleep 1; open "http://localhost:$PORT/") &
exec python3 -m http.server "$PORT" --bind 127.0.0.1
