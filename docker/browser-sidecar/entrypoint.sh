#!/bin/sh
set -e

# Idempotency guard: `msb exec` re-invokes this ENTRYPOINT rather than
# attaching to an already-running instance. If a prior invocation's
# Xvfb/Chromium/proxy are already up (or still starting up), starting a
# second copy collides on the X11 display lock and the proxy's port bind,
# crashing the working instance (observed directly: "Server is already
# active for display 99" / "bind ... Address already in use"). Detect that
# case and block harmlessly instead of restarting.
#
# Checked via Xvfb's own PID (not a port probe on 9222): the proxy doesn't
# bind its port until the very last step of this script, after Xvfb starts,
# Chromium launches, and the CDP-readiness wait completes — a port-9222
# probe would miss a re-invocation landing anywhere in that whole startup
# window, which is exactly when a collision on the Xvfb display lock is
# possible. Checking `kill -0` (not just file existence) means a stale
# pidfile left behind by a prior crash doesn't block a legitimate restart.
XVFB_PIDFILE=/tmp/xvfb.pid
if [ -f "$XVFB_PIDFILE" ] && kill -0 "$(cat "$XVFB_PIDFILE")" 2>/dev/null; then
	echo "browser sidecar already running (Xvfb pid $(cat "$XVFB_PIDFILE") alive), blocking instead of re-starting" >&2
	exec sleep infinity
fi

# Device profile. User-facing verification defaults to a real Chromium mobile
# viewport profile (iPhone-class ~375x667) so the pass exercises the deployed
# surface the way a phone user meets it, rather than shrinking a desktop
# browser at verification time. `MOBILE=0` restores the desktop profile for
# the general/research browser path. The Xvfb virtual screen stays large in
# both cases so a pass can still resize up to a desktop width for a layout
# check (Playwright applies its own CDP viewport override when it drives).
MOBILE="${MOBILE:-1}"
MOBILE_WIDTH="${MOBILE_WIDTH:-375}"
MOBILE_HEIGHT="${MOBILE_HEIGHT:-667}"

if [ "$MOBILE" = "1" ]; then
	X_SCREEN="1280x720x24"
	CHROMIUM_PROFILE_FLAGS="--window-size=${MOBILE_WIDTH},${MOBILE_HEIGHT} --use-mobile-user-agent --touch-events=enabled"
else
	X_SCREEN="1280x720x24"
	CHROMIUM_PROFILE_FLAGS="--window-size=1280,720"
fi

Xvfb :99 -screen 0 "$X_SCREEN" &
echo $! >"$XVFB_PIDFILE"
export DISPLAY=:99

sleep 0.5

# Chromium ignores --remote-debugging-address on Debian builds and binds CDP
# to 127.0.0.1 only. host-rewrite-proxy.py (started below) bridges the
# externally-exposed port to this loopback listener so the agent VM can
# reach it.
chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  $CHROMIUM_PROFILE_FLAGS \
  about:blank &

# Wait for CDP to come up before accepting external connections.
until socat /dev/null TCP:127.0.0.1:9223 2>/dev/null; do sleep 0.2; done

# Chrome's DevTools HTTP server rejects any request whose Host header isn't
# "localhost" or a raw IP (DNS-rebinding protection) — and sessions reach
# this sidecar via the host.microsandbox.internal DNS name, which is
# neither, so a plain TCP bridge here gets every CDP request rejected with
# 500 (or ECONNRESET, depending on timing). host-rewrite-proxy.py rewrites
# the Host header to "localhost" on each connection's first request, then
# relays everything else — including the WebSocket upgrade and subsequent
# binary frames — byte-for-byte. See
# docs/runbooks/agent-session-failures-2026-08-11.md, Issue 2.
exec python3 /host-rewrite-proxy.py
