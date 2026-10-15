#!/usr/bin/env bash
# Proves a brand-new devstack comes up UTF8 and that the whole migration chain
# applies on it. Bootstraps into a throwaway devstack dir, so no existing
# cluster is touched or deleted. Downloads (Postgres, vendored libs, weed) are
# reused from MASKIN_DEVSTACK_DIR (default ~/.cache/maskin-devstack) and any
# that were missing are copied back there so CI can cache them.
#
# LC_ALL=C LANG=C is forced below on purpose. On a runner whose default locale
# is UTF8, initdb without --encoding would still produce a UTF8 cluster and
# this check would stay green with the fix stripped out.
set -u
set -o pipefail

export LC_ALL=C LANG=C

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CACHE_DIR="${MASKIN_DEVSTACK_DIR:-$HOME/.cache/maskin-devstack}"
WORK_DIR="$(mktemp -d)"

fail() {
	echo "fresh-db-utf8: FAIL: $*" >&2
	exit 1
}

cleanup() {
	local pg_ctl vendor_lib weed_pid d
	# Not via env.sh: a failed bootstrap never writes it, and Postgres may be up.
	pg_ctl="$(ls "$WORK_DIR"/postgres-*/bin/pg_ctl 2>/dev/null | head -1)"
	vendor_lib="$(ls -d "$WORK_DIR"/vendor-lib-* 2>/dev/null | head -1)"
	if [ -n "$pg_ctl" ] && [ -d "$WORK_DIR/pgdata" ]; then
		LD_LIBRARY_PATH="$vendor_lib" "$pg_ctl" -D "$WORK_DIR/pgdata" stop -m immediate >/dev/null 2>&1
	fi
	if [ -f "$WORK_DIR/weed.pid" ]; then
		weed_pid="$(cat "$WORK_DIR/weed.pid")"
		kill "$weed_pid" 2>/dev/null
		# weed can ignore SIGTERM for a while; do not leave it holding the ports.
		for _ in 1 2 3 4 5 6 7 8 9 10; do
			kill -0 "$weed_pid" 2>/dev/null || break
			sleep 0.5
		done
		kill -9 "$weed_pid" 2>/dev/null
	fi
	# Keep fresh downloads for the next run, even when the check failed.
	for d in "$WORK_DIR"/postgres-* "$WORK_DIR"/vendor-lib-* "$WORK_DIR"/weed-*; do
		[ -d "$d" ] && [ ! -L "$d" ] && cp -a "$d" "$CACHE_DIR/"
	done
	rm -rf "$WORK_DIR"
}
trap cleanup EXIT

# A port is free when nothing accepts a connection on it. S3_MASTER_PORT + 10000
# is weed's gRPC port, so both must be free.
free_port() {
	local p="$1"
	while (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null || (exec 3<>"/dev/tcp/127.0.0.1/$((p + 10000))") 2>/dev/null; do
		p=$((p + 1))
	done
	echo "$p"
}

export PG_PORT S3_PORT S3_MASTER_PORT S3_VOLUME_PORT S3_FILER_PORT
PG_PORT="$(free_port 25432)"
S3_PORT="$(free_port 28333)"
S3_MASTER_PORT="$(free_port 29333)"
S3_VOLUME_PORT="$(free_port 28081)"
S3_FILER_PORT="$(free_port 28888)"

mkdir -p "$CACHE_DIR"
for d in "$CACHE_DIR"/postgres-* "$CACHE_DIR"/vendor-lib-* "$CACHE_DIR"/weed-*; do
	[ -e "$d" ] && ln -s "$d" "$WORK_DIR/$(basename "$d")"
done

MASKIN_DEVSTACK_DIR="$WORK_DIR" bash "$REPO_ROOT/scripts/bootstrap-local-devstack.sh" ||
	fail "bootstrap-local-devstack.sh exited non-zero on a fresh devstack under LC_ALL=C"

# shellcheck disable=SC1091
. "$WORK_DIR/env.sh"

# Read it independently of the script's own assertion. pg_dump, not psql: psql
# needs libreadline, which minimal sandboxes lack.
encoding="$(pg_dump --create --schema-only "$DATABASE_URL" |
	sed -n "s/^CREATE DATABASE .* ENCODING = '\([^']*\)'.*/\1/p")" ||
	fail "could not read the database encoding"
[ "$encoding" = "UTF8" ] || fail "fresh cluster encoding is '$encoding', expected UTF8"

(cd "$REPO_ROOT" && pnpm db:migrate)
migrate_exit=$?
[ "$migrate_exit" -eq 0 ] || fail "pnpm db:migrate exited $migrate_exit on a fresh UTF8 cluster"

echo "fresh-db-utf8: OK (UTF8 cluster, migrations applied)"
