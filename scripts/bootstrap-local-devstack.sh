#!/usr/bin/env bash
# Stands up Postgres + SeaweedFS as plain unprivileged processes — no Docker,
# no apt-get, no root. Built for agent sandbox sessions that have no
# docker.sock and can't run `docker-compose up` (see
# .claude/rules/known-pitfalls.md, "Agent Sandbox Sessions Can't Run
# docker-compose"), but works anywhere bash + curl + dpkg-deb are available.
#
# Postgres's own binary dynamically links libxml2, which in turn needs ICU
# (libicuuc/libicudata) — neither is present in a minimal Debian userland.
# Rather than apt-get installing them (needs root, and permanently grows
# whatever image this runs in), this vendors the three missing .so files by
# downloading the raw .deb packages and extracting just the files needed,
# entirely as the current user. deb.debian.org prunes old point-release
# builds once a newer one ships, so the exact build pinned here is fetched
# from snapshot.debian.org's content-addressed archive instead, which never
# prunes — see the DEB_* hash tables below.
#
# The cluster is created UTF8 with the C locale (initdb --encoding=UTF8
# --locale=C), matching production and independent of the caller's LANG. An
# existing SQL_ASCII devstack is not re-encoded: the script stops and tells
# you to recreate it.
#
# Safe to re-run: every step is skipped if its output already exists.
set -e
set -o pipefail

MASKIN_PG_VERSION="${MASKIN_PG_VERSION:-16.14.0}"
MASKIN_WEED_VERSION="${MASKIN_WEED_VERSION:-4.41}"
MASKIN_DEVSTACK_DIR="${MASKIN_DEVSTACK_DIR:-$HOME/.cache/maskin-devstack}"

PG_PORT="${PG_PORT:-5432}"
PG_USER="${PG_USER:-postgres}"
PG_DB="${PG_DB:-maskin}"
S3_PORT="${S3_PORT:-8333}"
# Not weed's stock 9333: agent sandboxes run cdp-retry-proxy.js (the Playwright
# bridge) on 127.0.0.1:9333, so the master dies with "bind: address already in
# use". weed also binds master.port + 10000 for gRPC (19433 here).
S3_MASTER_PORT="${S3_MASTER_PORT:-9433}"
S3_VOLUME_PORT="${S3_VOLUME_PORT:-8081}"
S3_FILER_PORT="${S3_FILER_PORT:-8888}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

case "$(uname -m)" in
	x86_64)
		PG_TARGET="x86_64-unknown-linux-gnu"
		WEED_ARCH="amd64"
		# amd64 hashes for libxml2_2.9.14+dfsg-1.3~deb12u6 / libicu72_72.1-3+deb12u1
		# (bookworm), resolved via snapshot.debian.org/mr/package/.../binfiles/...
		LIBXML2_HASH="6a16bb0c777264fdbaef83273f581dc658af18ba"
		LIBICU72_HASH="33fdfc4e0715648c57182b80bcaf0254a0372776"
		;;
	aarch64 | arm64)
		PG_TARGET="aarch64-unknown-linux-gnu"
		WEED_ARCH="arm64"
		LIBXML2_HASH="b97023f848beddd3edd4150a9df01c5bf8646f33"
		LIBICU72_HASH="dae8ca6a0b69055b8f718e59b71269c992d14c1c"
		;;
	*)
		echo "bootstrap-local-devstack: unsupported architecture $(uname -m)" >&2
		exit 1
		;;
esac

PG_HOME="$MASKIN_DEVSTACK_DIR/postgres-$MASKIN_PG_VERSION-$PG_TARGET"
PG_DATA="$MASKIN_DEVSTACK_DIR/pgdata"
PG_VENDOR_LIB="$MASKIN_DEVSTACK_DIR/vendor-lib-$(uname -m)"
WEED_DIR="$MASKIN_DEVSTACK_DIR/weed-$MASKIN_WEED_VERSION-$WEED_ARCH"
WEED_DATA="$MASKIN_DEVSTACK_DIR/seaweed-data"
LOG_DIR="$MASKIN_DEVSTACK_DIR/logs"

mkdir -p "$MASKIN_DEVSTACK_DIR" "$LOG_DIR"

# ---------------------------------------------------------------------------
# Postgres
# ---------------------------------------------------------------------------

if [ ! -x "$PG_HOME/bin/postgres" ]; then
	echo "bootstrap-local-devstack: fetching portable Postgres $MASKIN_PG_VERSION ($PG_TARGET)..."
	tmp_tar="$(mktemp)"
	if ! curl -fsSL -o "$tmp_tar" \
		"https://github.com/theseus-rs/postgresql-binaries/releases/download/${MASKIN_PG_VERSION}/postgresql-${MASKIN_PG_VERSION}-${PG_TARGET}.tar.gz"; then
		echo "bootstrap-local-devstack: failed to download Postgres $MASKIN_PG_VERSION ($PG_TARGET) — check MASKIN_PG_VERSION and network access" >&2
		rm -f "$tmp_tar"
		exit 1
	fi
	mkdir -p "$PG_HOME"
	tar xzf "$tmp_tar" -C "$PG_HOME" --strip-components=1
	rm -f "$tmp_tar"
fi

if [ ! -f "$PG_VENDOR_LIB/libicudata.so.72" ]; then
	echo "bootstrap-local-devstack: vendoring libxml2 + ICU shared libs (no apt-get, no root)..."
	mkdir -p "$PG_VENDOR_LIB"
	tmp_dir="$(mktemp -d)"
	if ! curl -fsSL -o "$tmp_dir/libxml2.deb" "https://snapshot.debian.org/file/${LIBXML2_HASH}"; then
		echo "bootstrap-local-devstack: failed to download libxml2 .deb from snapshot.debian.org (hash ${LIBXML2_HASH} may have expired)" >&2
		rm -rf "$tmp_dir"
		exit 1
	fi
	if ! curl -fsSL -o "$tmp_dir/libicu72.deb" "https://snapshot.debian.org/file/${LIBICU72_HASH}"; then
		echo "bootstrap-local-devstack: failed to download libicu72 .deb from snapshot.debian.org (hash ${LIBICU72_HASH} may have expired)" >&2
		rm -rf "$tmp_dir"
		exit 1
	fi
	dpkg-deb -x "$tmp_dir/libxml2.deb" "$tmp_dir/x1"
	dpkg-deb -x "$tmp_dir/libicu72.deb" "$tmp_dir/x2"
	libxml2_so="$(find "$tmp_dir/x1" -name 'libxml2.so.*.*' | head -1)"
	libicuuc_so="$(find "$tmp_dir/x2" -name 'libicuuc.so.*.*' | head -1)"
	libicudata_so="$(find "$tmp_dir/x2" -name 'libicudata.so.*.*' | head -1)"
	if [ -z "$libxml2_so" ] || [ -z "$libicuuc_so" ] || [ -z "$libicudata_so" ]; then
		echo "bootstrap-local-devstack: expected .so files not found in extracted .deb packages — package layout may have changed" >&2
		rm -rf "$tmp_dir"
		exit 1
	fi
	cp "$libxml2_so" "$libicuuc_so" "$libicudata_so" "$PG_VENDOR_LIB/"
	ln -sf "$(basename "$libxml2_so")" "$PG_VENDOR_LIB/libxml2.so.2"
	ln -sf "$(basename "$libicuuc_so")" "$PG_VENDOR_LIB/libicuuc.so.72"
	ln -sf "$(basename "$libicudata_so")" "$PG_VENDOR_LIB/libicudata.so.72"
	rm -rf "$tmp_dir"
fi

export PATH="$PG_HOME/bin:$PATH"
export LD_LIBRARY_PATH="$PG_VENDOR_LIB${LD_LIBRARY_PATH:+:$LD_LIBRARY_PATH}"

if [ ! -d "$PG_DATA" ]; then
	echo "bootstrap-local-devstack: initializing Postgres data dir..."
	initdb -D "$PG_DATA" -U "$PG_USER" --auth=trust --encoding=UTF8 --locale=C >"$LOG_DIR/initdb.log" 2>&1
fi

if ! pg_ctl -D "$PG_DATA" status >/dev/null 2>&1; then
	echo "bootstrap-local-devstack: starting Postgres on port $PG_PORT..."
	pg_ctl -D "$PG_DATA" -l "$LOG_DIR/postgres.log" -o "-p $PG_PORT" start
	for _ in $(seq 1 30); do
		pg_isready -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1 && break
		sleep 0.5
	done
	if ! pg_isready -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" >/dev/null 2>&1; then
		echo "bootstrap-local-devstack: Postgres did not become ready — see $LOG_DIR/postgres.log" >&2
		exit 1
	fi
fi

createdb_err="$(createdb -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" "$PG_DB" 2>&1)" || {
	if ! grep -q "already exists" <<<"$createdb_err"; then
		echo "bootstrap-local-devstack: createdb failed: $createdb_err" >&2
		exit 1
	fi
}

# initdb only runs for a missing data dir, so an older SQL_ASCII devstack is not
# re-encoded by the flags above. Stop rather than delete someone's data.
# pg_dump reads the encoding from CREATE DATABASE because psql links libreadline,
# which minimal sandboxes lack and this script does not vendor.
cluster_encoding="$(pg_dump -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" --create --schema-only "$PG_DB" |
	sed -n "s/^CREATE DATABASE .* ENCODING = '\([^']*\)'.*/\1/p")"
if [ "$cluster_encoding" != "UTF8" ]; then
	echo "bootstrap-local-devstack: cluster at $PG_DATA is $cluster_encoding, expected UTF8." >&2
	echo "This devstack predates the encoding fix. Recreate it: rm -rf '$PG_DATA' and re-run the script." >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# SeaweedFS
# ---------------------------------------------------------------------------

if [ ! -x "$WEED_DIR/weed" ]; then
	echo "bootstrap-local-devstack: fetching SeaweedFS $MASKIN_WEED_VERSION ($WEED_ARCH)..."
	tmp_tar="$(mktemp)"
	if ! curl -fsSL -o "$tmp_tar" \
		"https://github.com/seaweedfs/seaweedfs/releases/download/${MASKIN_WEED_VERSION}/linux_${WEED_ARCH}.tar.gz"; then
		echo "bootstrap-local-devstack: failed to download SeaweedFS $MASKIN_WEED_VERSION ($WEED_ARCH) — check MASKIN_WEED_VERSION and network access" >&2
		rm -f "$tmp_tar"
		exit 1
	fi
	mkdir -p "$WEED_DIR"
	tar xzf "$tmp_tar" -C "$WEED_DIR"
	rm -f "$tmp_tar"
fi

s3_http_code() {
	# curl's own -w already prints "000" on a total connection failure, so
	# appending `|| echo "000"` here double-prints it as "000000" once curl's
	# non-zero exit also triggers the fallback — check for empty output
	# instead of relying on the exit code.
	local code
	code="$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:${S3_PORT}/" 2>/dev/null)"
	[ -z "$code" ] && code="000"
	echo "$code"
}

# --- SeaweedFS master port ---------------------------------------------------
# weed's master listens on the master port and, by default, on that port + 10000
# (gRPC): both must be free. 9333 is also the sandbox browser proxy's fixed port
# (docker/agent-base/agent-run.sh), so a busy 9333 is the normal case in agent
# sandboxes, not an error.
maskin_port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
maskin_master_port_busy() { maskin_port_busy "$1" || maskin_port_busy "$(($1 + 10000))"; }

# Best effort: name the process listening on port $1. Linux /proc only, own
# processes only; prints nothing when it cannot tell.
maskin_port_holder() {
	local hex inode d pid
	hex="$(printf '%04X' "$1")"
	inode="$(awk -v h=":$hex" '$4=="0A" && $2 ~ h"$" {print $10; exit}' /proc/net/tcp /proc/net/tcp6 2>/dev/null)"
	[ -n "$inode" ] && [ "$inode" != 0 ] || return 0
	for d in /proc/[0-9]*/fd/*; do
		[ "$(readlink "$d" 2>/dev/null)" = "socket:[$inode]" ] || continue
		pid="${d#/proc/}"
		pid="${pid%%/*}"
		printf 'pid %s: %s\n' "$pid" "$(tr '\0' ' ' </proc/"$pid"/cmdline | cut -c1-80)"
		return 0
	done
}

if [ "$(s3_http_code)" = "000" ]; then
	master_wanted="$S3_MASTER_PORT"
	master_tries=0
	while maskin_master_port_busy "$S3_MASTER_PORT"; do
		master_tries=$((master_tries + 1))
		if [ "$master_tries" -gt 20 ]; then
			echo "bootstrap-local-devstack: no free SeaweedFS master port in $master_wanted-$((master_wanted + 20)) — set S3_MASTER_PORT to a free port" >&2
			exit 1
		fi
		S3_MASTER_PORT=$((S3_MASTER_PORT + 1))
	done
	if [ "$S3_MASTER_PORT" != "$master_wanted" ]; then
		master_holder="$(maskin_port_holder "$master_wanted")"
		echo "bootstrap-local-devstack: SeaweedFS master port $master_wanted (or its gRPC port $((master_wanted + 10000))) is in use${master_holder:+ ($master_holder)}; using $S3_MASTER_PORT instead. Set S3_MASTER_PORT to pick one." >&2
	fi

	echo "bootstrap-local-devstack: starting SeaweedFS S3 on port $S3_PORT..."
	mkdir -p "$WEED_DATA"
	nohup "$WEED_DIR/weed" server \
		-dir="$WEED_DATA" \
		-s3 \
		-s3.config="$REPO_ROOT/seaweedfs-s3.json" \
		-s3.port="$S3_PORT" \
		-master.port="$S3_MASTER_PORT" \
		-volume.port="$S3_VOLUME_PORT" \
		-filer.port="$S3_FILER_PORT" \
		-ip=127.0.0.1 \
		>"$LOG_DIR/seaweedfs.log" 2>&1 &
	echo $! >"$MASKIN_DEVSTACK_DIR/weed.pid"
	disown
	for _ in $(seq 1 30); do
		[ "$(s3_http_code)" != "000" ] && break
		sleep 0.5
	done
	if [ "$(s3_http_code)" = "000" ]; then
		echo "bootstrap-local-devstack: SeaweedFS did not become ready (master port $S3_MASTER_PORT) — see $LOG_DIR/seaweedfs.log" >&2
		tail -n 5 "$LOG_DIR/seaweedfs.log" >&2 || true
		exit 1
	fi
	echo "$S3_MASTER_PORT" >"$MASKIN_DEVSTACK_DIR/weed.master.port"
else
	# weed is already up from an earlier run — report the master port it actually bound.
	if [ -f "$MASKIN_DEVSTACK_DIR/weed.master.port" ]; then
		S3_MASTER_PORT="$(cat "$MASKIN_DEVSTACK_DIR/weed.master.port")"
	fi
fi

# ---------------------------------------------------------------------------
# Env vars for the rest of the stack — same shape docker-compose.yml's `dev`
# service already uses, so ensure-encryption-key.mjs / apps/dev pick these up
# with zero changes.
# ---------------------------------------------------------------------------

ENV_FILE="$MASKIN_DEVSTACK_DIR/env.sh"
cat >"$ENV_FILE" <<EOF
export DATABASE_URL="postgresql://${PG_USER}:${PG_USER}@127.0.0.1:${PG_PORT}/${PG_DB}"
export S3_ENDPOINT="http://127.0.0.1:${S3_PORT}"
export S3_BUCKET="agent-files"
export S3_ACCESS_KEY="admin"
export S3_SECRET_KEY="admin"
export S3_REGION="us-east-1"
export S3_MASTER_PORT="${S3_MASTER_PORT}"
export PATH="${PG_HOME}/bin:\$PATH"
export LD_LIBRARY_PATH="${PG_VENDOR_LIB}\${LD_LIBRARY_PATH:+:\$LD_LIBRARY_PATH}"
EOF

echo "bootstrap-local-devstack: ready."
echo "  Postgres : $(pg_isready -h 127.0.0.1 -p "$PG_PORT" -U "$PG_USER" 2>&1)"
echo "  S3 (weed): http://127.0.0.1:${S3_PORT} (http $(s3_http_code))"
echo "  S3 master: 127.0.0.1:${S3_MASTER_PORT}"
echo "  Env vars : source $ENV_FILE"
