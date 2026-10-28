#!/usr/bin/env bash
# Devnet deploy with one resumable buffer. Never closes live programs.
set -euo pipefail

PROGRAM_ID="CYVpaizqcMaoqPfBaMABPAH3xpPaC6iCuWiViXjeHuER"
CLOSED_ID="GeLQ6ETg5VPU86bCBKAnA7pRygoJaf5uXd5g6upvzfmD"
TOKEN_ID="2Ztk1WhiRrFqZZktipzPEQghJFNJbA8C1LL1v3LsWCiP"
WIN_ROOT="/mnt/c/Users/30149/prediction_market"
WORK="$HOME/pm_deploy"
SO_SRC="$WIN_ROOT/target/deploy/prediction_market.so"
KP_SRC="$WIN_ROOT/target/deploy/prediction_market-keypair.json"
BUF_SRC="$WIN_ROOT/target/deploy/prediction_market-buffer.devnet.json"
RPC_FILE="$WIN_ROOT/scripts/.rpc.url"
WRITE_ATTEMPTS="${WRITE_ATTEMPTS:-12}"
MAX_SIGN_ATTEMPTS="${MAX_SIGN_ATTEMPTS:-80}"
CU_PRICE="${CU_PRICE:-100000}"
FORCE_BUILD="${FORCE_BUILD:-0}"

export PATH="$HOME/.local/share/solana/install/active_release/bin:$HOME/.cargo/bin:$PATH"

die() { echo "$*" >&2; exit 1; }

pick_rpc() {
  if [[ -n "${RPC_URL:-}" ]]; then
    echo "$RPC_URL"
    return
  fi
  if [[ -f "$RPC_FILE" ]]; then
    tr -d '\r' < "$RPC_FILE" | sed '/^[[:space:]]*$/d; /^#/d' | head -n 1
    return
  fi
  echo "https://api.devnet.solana.com"
}

command -v solana >/dev/null 2>&1 || die "solana CLI not found"
command -v solana-keygen >/dev/null 2>&1 || die "solana-keygen not found"
[[ -f "$KP_SRC" ]] || die "missing $KP_SRC"
[[ -f "$SO_SRC" ]] || die "missing $SO_SRC; set FORCE_BUILD=1"

RPC="$(pick_rpc)"
[[ -n "$RPC" ]] || die "empty RPC"

src_id="$(tr -d '\r' < "$WIN_ROOT/programs/prediction_market/src/lib.rs" | sed -n 's/.*declare_id!("\([^"]*\)").*/\1/p' | head -n 1)"
[[ "$src_id" == "$PROGRAM_ID" ]] || die "lib.rs declare_id is $src_id, expected $PROGRAM_ID"
kp_pubkey="$(solana-keygen pubkey "$KP_SRC")"
[[ "$kp_pubkey" == "$PROGRAM_ID" ]] || die "keypair is $kp_pubkey, expected $PROGRAM_ID"

if [[ "$FORCE_BUILD" == "1" ]]; then
  echo "=== FORCE_BUILD=1 rebuild ==="
  cd "$WIN_ROOT"
  if command -v anchor >/dev/null 2>&1; then
    anchor build -p prediction_market
  elif command -v cargo-build-sbf >/dev/null 2>&1; then
    cargo-build-sbf --manifest-path programs/prediction_market/Cargo.toml
  else
    die "need anchor or cargo-build-sbf"
  fi
else
  echo "=== reuse existing .so (FORCE_BUILD=1 to rebuild) ==="
fi
[[ -f "$SO_SRC" ]] || die "missing $SO_SRC"

if [[ ! -f "$BUF_SRC" ]]; then
  solana-keygen new --no-bip39-passphrase --silent --outfile "$BUF_SRC"
fi

mkdir -p "$WORK"
cp -f "$SO_SRC" "$WORK/prediction_market.so"
cp -f "$KP_SRC" "$WORK/prediction_market-keypair.json"
cp -f "$BUF_SRC" "$WORK/prediction_market-buffer.json"
SO="$WORK/prediction_market.so"
KP="$WORK/prediction_market-keypair.json"
BUF_KP="$WORK/prediction_market-buffer.json"
BUF_PUB="$(solana-keygen pubkey "$BUF_KP")"
SO_BYTES="$(wc -c < "$SO" | tr -d ' ')"

solana config set --url "$RPC" --rpc-timeout 180 --confirm-timeout 180 >/dev/null || solana config set --url "$RPC" >/dev/null
echo "solana $(solana --version)"
echo "wallet $(solana address)"
echo "rpc $RPC"
echo "program $PROGRAM_ID"
echo "buffer $BUF_PUB"
echo "so_bytes $SO_BYTES"
solana balance --url "$RPC"

if [[ "$RPC" == *api.devnet.solana.com* ]]; then
  echo "WARN: public Devnet RPC is too slow for 400+ write txs; blockhash will expire."
  echo "Put a Helius/QuickNode URL in scripts/.rpc.url or export RPC_URL=..."
fi

echo
echo "=== current prediction_market ==="
solana program show "$PROGRAM_ID" --url "$RPC" || echo "(not deployed yet)"
echo
echo "=== meme_token keep ==="
solana program show "$TOKEN_ID" --url "$RPC"

is_protected() {
  case "$1" in
    "$PROGRAM_ID"|"$TOKEN_ID"|"$CLOSED_ID") return 0 ;;
  esac
  return 1
}

list_buffers() {
  solana program show --buffers --url "$RPC" 2>/dev/null | awk '{print $1}' | grep -E '^[1-9A-HJ-NP-Za-km-z]{32,44}$' || true
}

account_len() {
  solana account "$1" --url "$RPC" 2>/dev/null | awk '/Length:/ {print $2; exit}' | tr -d ',' || true
}

echo
echo "=== buffers ==="
solana program show --buffers --url "$RPC" || true

keep_buf=0
if solana account "$BUF_PUB" --url "$RPC" >/dev/null 2>&1; then
  blen="$(account_len "$BUF_PUB")"
  echo "named buffer exists length=${blen:-unknown} need>=$SO_BYTES"
  if [[ -n "${blen:-}" ]] && awk -v a="$blen" -v b="$SO_BYTES" 'BEGIN { exit ((a+0) >= (b+0)) ? 0 : 1 }'; then
    keep_buf=1
    echo "resume named buffer $BUF_PUB"
  else
    echo "named buffer too small, closing $BUF_PUB"
    is_protected "$BUF_PUB" && die "refusing to close protected $BUF_PUB"
    solana program close "$BUF_PUB" --bypass-warning --url "$RPC" || true
  fi
fi

while read -r addr; do
  [[ -n "$addr" ]] || continue
  if is_protected "$addr"; then
    echo "skip protected $addr"
    continue
  fi
  if [[ "$keep_buf" == "1" && "$addr" == "$BUF_PUB" ]]; then
    echo "keep resume buffer $addr"
    continue
  fi
  echo "closing leftover buffer $addr"
  solana program close "$addr" --bypass-warning --url "$RPC" || true
done < <(list_buffers)

sol_balance() {
  solana balance --url "$RPC" --lamports | awk '{printf "%.9f", $1/1000000000}'
}
enough() {
  awk -v have="$1" -v need="$2" 'BEGIN { exit ((have+0) >= (need+0)) ? 0 : 1 }'
}

rent_sol="$(solana rent "$SO_BYTES" --url "$RPC" 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i ~ /^[0-9.]+$/) {print $i; exit}}')"
if [[ "$keep_buf" == "1" ]]; then
  need="$(awk -v r="${rent_sol:-3.3}" 'BEGIN {printf "%.9f", r+0.30}')"
else
  need="$(awk -v r="${rent_sol:-3.3}" 'BEGIN {printf "%.9f", (2*r)+0.30}')"
fi
have="$(sol_balance)"
echo "spendable $have SOL, need about $need SOL (rent~$rent_sol)"
if ! enough "$have" "$need"; then
  echo "假 SOL 不够。现在 $have，大约需要 $need" >&2
  echo "地址 $(solana address --url "$RPC")" >&2
  exit 2
fi

wb_help="$(solana program write-buffer --help 2>&1 || true)"
dep_help="$(solana program deploy --help 2>&1 || true)"
WRITE_FLAGS=(--buffer "$BUF_KP" --url "$RPC")
DEPLOY_FLAGS=(--buffer "$BUF_KP" --program-id "$KP" --url "$RPC")
if grep -q -- '--use-rpc' <<<"$wb_help"; then WRITE_FLAGS+=(--use-rpc); fi
if grep -q -- '--max-sign-attempts' <<<"$wb_help"; then WRITE_FLAGS+=(--max-sign-attempts "$MAX_SIGN_ATTEMPTS"); fi
if grep -q -- '--use-rpc' <<<"$dep_help"; then DEPLOY_FLAGS+=(--use-rpc); fi
if grep -q -- '--max-sign-attempts' <<<"$dep_help"; then DEPLOY_FLAGS+=(--max-sign-attempts "$MAX_SIGN_ATTEMPTS"); fi
echo "write flags: ${WRITE_FLAGS[*]}"
echo "deploy flags: ${DEPLOY_FLAGS[*]}"

write_once() {
  solana program write-buffer "$SO" "${WRITE_FLAGS[@]}"
}

echo
echo "=== write-buffer (same buffer, resume on fail) ==="
ok=0
for i in $(seq 1 "$WRITE_ATTEMPTS"); do
  echo "write-buffer attempt $i/$WRITE_ATTEMPTS buffer=$BUF_PUB"
  if write_once; then
    ok=1
    break
  fi
  echo "write-buffer attempt $i failed, keep buffer and retry"
  sleep 2
done
[[ "$ok" == "1" ]] || die "write-buffer still incomplete after $WRITE_ATTEMPTS attempts; rerun this script, it will resume $BUF_PUB"

echo
echo "=== deploy from buffer (few txs, never close live programs) ==="
solana program deploy "${DEPLOY_FLAGS[@]}"

echo
echo "=== leftover buffers after deploy ==="
solana program show --buffers --url "$RPC" || true
while read -r addr; do
  [[ -n "$addr" ]] || continue
  is_protected "$addr" && continue
  echo "closing leftover buffer $addr"
  solana program close "$addr" --bypass-warning --url "$RPC" || true
done < <(list_buffers)

echo
echo "=== after ==="
solana program show "$PROGRAM_ID" --url "$RPC"
echo
echo "=== meme_token still there ==="
solana program show "$TOKEN_ID" --url "$RPC"
solana balance --url "$RPC"
echo done
