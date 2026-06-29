#!/usr/bin/env bash
# Verify the baked pnpm install — AC-T5 from bet/dev-agent-token-waste.
#
# Runs inside a freshly-spawned container of the agent-base image. Asserts
# that a session-local clone of each pre-fetched repo can resolve its
# dependencies from the baked pnpm CAS store in under 10 seconds with zero
# packages downloaded from the registry.
#
# Usage: docker exec -i <container> bash /verify-baked-pnpm.sh
#    or: copy this file into a container and run it as the `agent` user.
#
# Exit codes:
#   0  — both repos installed in <10s with no downloads
#   1  — at least one repo exceeded the timing budget or downloaded packages
#   2  — preflight failure (baked layout missing, pnpm not on PATH, etc.)

set -euo pipefail

THRESHOLD_SECONDS="${VERIFY_THRESHOLD_SECONDS:-10}"
PREFETCH_ROOT="${VERIFY_PREFETCH_ROOT:-/opt/agent-prefetch}"
WORK_ROOT="$(mktemp -d)"
trap 'rm -rf "$WORK_ROOT"' EXIT

if ! command -v pnpm >/dev/null 2>&1; then
  echo "[verify] pnpm not on PATH" >&2
  exit 2
fi

if [ ! -d "$PREFETCH_ROOT/maskin" ] || [ ! -d "$PREFETCH_ROOT/skjald" ]; then
  echo "[verify] expected baked repos under $PREFETCH_ROOT not found" >&2
  exit 2
fi

failed=0

run_one() {
  local name="$1"
  local src="$PREFETCH_ROOT/$name"
  local dst="$WORK_ROOT/$name"

  # Copy lockfile + workspace package.jsons into a fresh dir, mirroring what a
  # session-local `git clone` would produce. node_modules is intentionally
  # NOT copied — the point of the test is to prove that `pnpm install`
  # resolves from the CAS store alone.
  mkdir -p "$dst"
  ( cd "$src" && tar --exclude='node_modules' --exclude='.git' -cf - . ) \
    | ( cd "$dst" && tar -xf - )

  echo "[verify] $name: pnpm install --frozen-lockfile --prefer-offline"
  local log
  log="$(mktemp)"
  local started_ns ended_ns elapsed_ms
  started_ns=$(date +%s%N)
  ( cd "$dst" && pnpm install --frozen-lockfile --prefer-offline ) >"$log" 2>&1
  ended_ns=$(date +%s%N)
  elapsed_ms=$(( (ended_ns - started_ns) / 1000000 ))

  # `Progress: resolved X, reused Y, downloaded Z, added W` — Z must be 0.
  # Match any non-zero digit in the downloaded slot to fail fast.
  if grep -E 'downloaded [1-9][0-9]*' "$log" >/dev/null; then
    echo "[verify] $name FAILED — downloaded packages from registry:"
    grep -E 'downloaded [0-9]+' "$log" | tail -3
    failed=1
  fi

  local threshold_ms=$(( THRESHOLD_SECONDS * 1000 ))
  if [ "$elapsed_ms" -gt "$threshold_ms" ]; then
    echo "[verify] $name FAILED — took ${elapsed_ms}ms (> ${threshold_ms}ms)"
    tail -5 "$log"
    failed=1
  else
    echo "[verify] $name OK — ${elapsed_ms}ms (budget ${threshold_ms}ms)"
  fi

  rm -f "$log"
}

run_one maskin
run_one skjald

if [ "$failed" -ne 0 ]; then
  echo "[verify] FAILED — see output above"
  exit 1
fi

echo "[verify] PASS — both repos installed under ${THRESHOLD_SECONDS}s with zero downloads"
