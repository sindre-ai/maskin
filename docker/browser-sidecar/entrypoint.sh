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

exec socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223
