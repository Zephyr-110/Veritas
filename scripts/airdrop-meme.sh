#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v node >/dev/null 2>&1; then
  exec node scripts/airdrop-meme.js "$@"
fi
if [[ -n "${NODE_EXE:-}" && -x "$NODE_EXE" ]]; then
  exec "$NODE_EXE" scripts/airdrop-meme.js "$@"
fi
echo "node not found; install node on PATH or set NODE_EXE=/path/to/node" >&2
exit 1
