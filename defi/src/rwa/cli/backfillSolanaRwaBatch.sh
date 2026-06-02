#!/usr/bin/env bash
# Batch driver for Solana RWA onchain-mcap backfills via Dune.
# Wraps fetchSolanaSupplyFromDune.ts + backfillSolanaRwaMcap.ts for each
# token below. Default mode is dry-run (CSV pulled, HTML preview written,
# no DB writes). Pass --commit on the final pass once previews look right.
#
# Per-token review loop is intentional — eyeball each HTML before committing.
#
# Usage:
#   DUNE_API_KEY=xxx ./backfillSolanaRwaBatch.sh                # dry-run all (named + xStocks)
#   DUNE_API_KEY=xxx ./backfillSolanaRwaBatch.sh --only USDY    # dry-run one
#   DUNE_API_KEY=xxx ./backfillSolanaRwaBatch.sh --only CRCLx
#   DUNE_API_KEY=xxx ./backfillSolanaRwaBatch.sh --no-xstocks   # named tokens only
#   DUNE_API_KEY=xxx ./backfillSolanaRwaBatch.sh --skip ABCx,DEFx  # exclude specific labels
#   DUNE_API_KEY=xxx ./backfillSolanaRwaBatch.sh --commit       # commit all enabled
#
# NFLXx is always skipped (Dune supply 10× under on-chain — under investigation).
# Override via --only NFLXx if you need to run it anyway.
#
# Prereqs:
#   - Dune query 7435636 (parameterised SPL supply query). Override with DUNE_QUERY_ID.
#   - DUNE_API_KEY env var.
#   - jq, ts-node available.
#
# Notes on xStocks:
# defi/src/rwa/atvlRefill.ts mirrors activeMcap → onChainMcap each live tick for
# the xStock and Backed Finance platforms (see constants.ts:ONCHAIN_MCAP_EQUALS_ACTIVE_PLATFORMS).
# That only stamps the current row. Historical pre-onboarding rows are still 0,
# and that's exactly the gap the Dune supply × price route fills. The backfill's
# isMissing() guard means already-populated live rows are preserved, so the mirror
# rule keeps working for the present and our Dune values fill the past.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFI_ROOT="$(cd "$SCRIPT_DIR/../../.." && pwd)"   # → .../defillama-server-1/defi
RWA_CACHE="$DEFI_ROOT/src/rwa/.rwa-cache/v3.05/build/current.json"
DUNE_QUERY_ID="${DUNE_QUERY_ID:-7435636}"
WORK_DIR="${WORK_DIR:-/tmp/solana-rwa-backfill}"
mkdir -p "$WORK_DIR"

# ── Named targets (non-xStock) ────────────────────────────────────────
# label|asset_id|mint|decimals|from_date|notes
# Decimals verified by getTokenSupply RPC against api.mainnet-beta.solana.com.
# from_date: YYYY-MM-DD to skip rows before that day (treasury-cap trim);
#   "-" leaves the full series. Re-check the HTML preview's left edge —
#   a long flat plateau usually means a from_date is needed.
NAMED_TARGETS=(
  "USDY|89|A1KLoBrKBde8Ty9qtNQUtq3C2ortoC3u7twggz7sEto6|6|-|Ondo"
  "BUIDL|79|GyWgeqpy5GueU2YbkE8xqUeVEokCMMCEeUrfbtMw6phr|6|-|BlackRock / Securitize"
  "ACRED|545|FubtUcvhSCr3VPXEcxouoQjKQ7NWTCzXyECe76B7L3f8|6|-|Apollo / Securitize"
  "PRIME|659|3b8X44fLF9ooXaUm3hhSgjpmVs6rZZ3pPoGnGahc3Uu7|6|-|Hastra"
  "ANTHROPIC|407|Pren1FvFX6J3E4kXhJuCiAD5aDmGEb7qJRncwA8Lkhw|9|-|PreStocks"
  "OPENAI|408|PreweJYECqtQwBtpxHL171nL2K6umo692gTm7Q3rpgF|9|-|PreStocks"
  "SPACEX|409|PreANxuXjsy2pvisWWMNB6YaJNzr7681wJJr2rHsfTh|9|-|PreStocks"
  "XAI|410|PreC1KtJ1sBPPqaeeqL6Qb15GTLCYVvyYEwxhdfTwfx|9|-|PreStocks"
  "ANDURIL|406|PresTj4Yc2bAR197Er7wz4UUKSfqt6FryBEdAriBoQB|9|-|PreStocks"
  "POLYMARKET|2835|Pre8AREmFPtoJFT8mQSXQLh56cwJmM7CFDRuoGBZiUP|9|-|PreStocks"
  "KALSHI|2836|PreLWGkkeqG1s4HEfFZSy9moCrJ7btsHuUtfcCeoRua|9|-|PreStocks"
  "NEURALINK|3287|PrekqLJvJ3qVdXmBGDiexvwUTF4rLFDa6HWS4HJbw9S|9|-|PreStocks"
)
# ONyc (id 175) already backfilled — see memory project_solana_mcap_no_backfill.

# ── xStock targets (auto-discovered from RWA cache) ───────────────────
# All Solana xStocks share decimals=8 (sampled across 10 tokens, all matched).
# The cache is the canonical source — adding a new xStock there picks it up here.
build_xstock_targets() {
  if [[ ! -f "$RWA_CACHE" ]]; then
    echo "WARN: RWA cache not found at $RWA_CACHE — xStocks will be skipped" >&2
    return
  fi
  jq -r '.[] | select(.parentPlatform == "xStock" and (.contracts.Solana // [] | length > 0)) |
         "\(.ticker)|\(.id)|\(.contracts.Solana[0])|8|-|xStock (auto)"' "$RWA_CACHE"
}

# ── Flag parsing ──────────────────────────────────────────────────────
COMMIT=0
ONLY=""
SKIP=""
NO_XSTOCKS=0
SKIP_FETCH=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    --commit)     COMMIT=1; shift ;;
    --only)       ONLY="$2"; shift 2 ;;
    --skip)       SKIP="$2"; shift 2 ;;
    --no-xstocks) NO_XSTOCKS=1; shift ;;
    --skip-fetch) SKIP_FETCH=1; shift ;;
    -h|--help)    sed -n '1,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 1 ;;
  esac
done

# Default skip list — tokens where Dune supply diverges from on-chain RPC by >10%.
# Investigate before re-adding: run `SELECT action, COUNT(*), SUM(amount) FROM
# tokens_solana.transfers WHERE token_mint_address = '<MINT>' GROUP BY action`
# on Dune and reconcile against the live getTokenSupply value.
DEFAULT_SKIP="NFLXx"
if [[ -z "$SKIP" ]]; then
  SKIP="$DEFAULT_SKIP"
else
  SKIP="$SKIP,$DEFAULT_SKIP"
fi

# Build a comma-bounded skip-list so `,LABEL,` substring match avoids prefix collisions.
SKIP_BOUNDED=",$SKIP,"

if [[ -z "${DUNE_API_KEY:-}" ]]; then
  echo "ERROR: DUNE_API_KEY is not set" >&2
  exit 1
fi

cd "$DEFI_ROOT"

run_one() {
  local label="$1" asset_id="$2" mint="$3" decimals="$4" from_date="$5" notes="$6"
  # Replace anything non-alnum in label with _ so weird tickers (BRK.Bx) don't blow up paths.
  # tr-based lowercase so we work on macOS's bash 3.2 (no ${var,,} support).
  local safe
  safe="$(printf '%s' "$label" | tr -c 'A-Za-z0-9' '_' | tr '[:upper:]' '[:lower:]')"
  local csv="$WORK_DIR/${safe}.csv"
  local html="$WORK_DIR/preview-${safe}.html"

  echo
  echo "════════════════════════════════════════════════════════════════"
  echo "▶ $label (id=$asset_id, decimals=$decimals)  — $notes"
  echo "  csv:   $csv"
  echo "  html:  $html"
  echo "════════════════════════════════════════════════════════════════"

  if [[ "$SKIP_FETCH" -eq 0 || ! -f "$csv" ]]; then
    npx ts-node src/rwa/cli/fetchSolanaSupplyFromDune.ts \
      --query-id "$DUNE_QUERY_ID" \
      --mint "$mint" \
      --decimals "$decimals" \
      --out "$csv"
  else
    echo "[skip-fetch] reusing $csv"
  fi

  local args=(--asset-id "$asset_id" --mint "$mint" --csv "$csv")
  if [[ "$from_date" != "-" ]]; then
    args+=(--from-date "$from_date")
  fi

  if [[ "$COMMIT" -eq 1 ]]; then
    echo "[backfill] COMMIT mode — writing to daily_rwa_data + backup_rwa_data"
    npx ts-node src/rwa/cli/backfillSolanaRwaMcap.ts "${args[@]}"
  else
    npx ts-node src/rwa/cli/backfillSolanaRwaMcap.ts "${args[@]}" \
      --dry-run --out "$html"
    echo "[dry-run] open the preview:  open \"$html\""
  fi
}

# Build the full target list: named first, then xStocks (unless suppressed).
ALL_TARGETS=("${NAMED_TARGETS[@]}")
if [[ "$NO_XSTOCKS" -eq 0 ]]; then
  while IFS= read -r line; do
    [[ -n "$line" ]] && ALL_TARGETS+=("$line")
  done < <(build_xstock_targets)
fi

matched=0
skipped=0
for row in "${ALL_TARGETS[@]}"; do
  IFS='|' read -r label asset_id mint decimals from_date notes <<<"$row"
  [[ -z "$label" || "$label" == \#* ]] && continue
  if [[ -n "$ONLY" && "$label" != "$ONLY" ]]; then continue; fi
  # --only takes precedence: if the user explicitly asked for this label, run it
  # even if it's in the skip list.
  if [[ -z "$ONLY" && "$SKIP_BOUNDED" == *",$label,"* ]]; then
    echo "[skip] $label (in skip list)"
    skipped=$((skipped+1))
    continue
  fi
  run_one "$label" "$asset_id" "$mint" "$decimals" "$from_date" "$notes"
  matched=$((matched+1))
done

if [[ "$matched" -eq 0 ]]; then
  echo "no targets matched (ONLY=$ONLY)" >&2
  exit 1
fi

echo
if [[ "$COMMIT" -eq 1 ]]; then
  echo "✔ Done. Wrote $matched asset(s) to daily_rwa_data + backup_rwa_data."
else
  echo "✔ Dry-run done for $matched asset(s). Open the HTML previews; re-run with --commit when ready."
fi
