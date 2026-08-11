#!/bin/sh
set -e

# Idempotency guard: `msb exec` re-invokes this ENTRYPOINT rather than
# attaching to an already-running instance. If a prior invocation's
# Xvfb/Chromium/socat are already serving CDP on 9222, starting a second
# copy collides on the X11 display lock and the socat port bind, crashing
# the working instance (observed directly: "Server is already active for
# display 99" / "bind ... Address already in use"). Detect that case and
# block harmlessly instead of restarting.
if socat /dev/null TCP:127.0.0.1:9222 2>/dev/null; then
	echo "browser sidecar already running on :9222, blocking instead of re-starting" >&2
	exec sleep infinity
fi

Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

sleep 0.5

# Chromium ignores --remote-debugging-address on Debian builds and binds CDP
# to 127.0.0.1 only. socat bridges the externally-exposed port to the
# loopback listener so the agent VM can reach it.
chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9223 \
  --remote-allow-origins=* \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
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
