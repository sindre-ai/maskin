#!/bin/sh
set -e

Xvfb :99 -screen 0 1280x720x24 &
export DISPLAY=:99

sleep 0.5

exec chromium \
  --no-sandbox \
  --disable-gpu \
  --disable-dev-shm-usage \
  --remote-debugging-port=9222 \
  --remote-debugging-address=0.0.0.0 \
  --no-first-run \
  --no-default-browser-check \
  --disable-extensions \
  about:blank
