#!/bin/sh
set -e

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
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  about:blank &

# Wait for CDP to come up before accepting external connections.
until socat /dev/null TCP:127.0.0.1:9223 2>/dev/null; do sleep 0.2; done

exec socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223
