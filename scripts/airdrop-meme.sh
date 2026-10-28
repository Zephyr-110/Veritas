#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"
if command -v node >/dev/null 2>&1; then
  exec node scripts/airdrop-meme.js "$@"
fi
for n in \
  "/mnt/c/Users/30149/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node.exe" \
  "/mnt/d/????/????/node.exe" \
  "/mnt/d/????/????/Node.js/node.exe"
do
  if [[ -x "$n" ]]; then
    exec "$n" scripts/airdrop-meme.js "$@"
  fi
done
echo "node not found" >&2
exit 1
