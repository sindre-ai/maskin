#!/bin/bash
set -e

# `msb exec` re-invokes ENTRYPOINT rather than attaching, so guard against a
# second copy colliding on the X display lock (same reasoning as
# docker/browser-sidecar/entrypoint.sh).
XVFB_PIDFILE=/tmp/xvfb.pid
if [ -f "$XVFB_PIDFILE" ] && kill -0 "$(cat "$XVFB_PIDFILE")" 2>/dev/null; then
	echo "desktop already running, blocking instead of re-starting" >&2
	exec sleep infinity
fi

export DISPLAY=:99
VNC_PORT=5900
NOVNC_PORT=6080
SCREEN="${SCREEN_SIZE:-1280x720x24}"

# Per-boot VNC password; read it with `msb exec <name> -- cat /tmp/vnc-password`.
VNC_PASSWORD="${VNC_PASSWORD:-$(head -c 12 /dev/urandom | base64 | tr -dc 'A-Za-z0-9')}"
umask 077
echo "$VNC_PASSWORD" >/tmp/vnc-password
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc-passwd >/dev/null

Xvfb "$DISPLAY" -screen 0 "$SCREEN" &
echo $! >"$XVFB_PIDFILE"
sleep 0.5

openbox &
xterm -geometry 100x30+20+20 &
chromium --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run \
  --no-default-browser-check about:blank &

# VNC server is loopback-only; only websockify (below) is reachable from outside.
x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -rfbauth /tmp/vnc-passwd \
  -localhost -forever -shared -noxdamage -quiet &

until (echo >/dev/tcp/127.0.0.1/$VNC_PORT) 2>/dev/null || [ "${tries:=0}" -ge 50 ]; do
	tries=$((tries + 1))
	sleep 0.2
done

exec websockify --web /usr/share/novnc "$NOVNC_PORT" "127.0.0.1:$VNC_PORT"
