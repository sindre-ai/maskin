#!/bin/bash
set -e

# The container/VM starts this as root. Drop to the unprivileged user before
# starting anything, so every process (X server, window manager, browser, and
# the commands agents run through desktopd) is that user. `sudo` stays available.
if [ "$(id -u)" = 0 ]; then
	exec runuser -u user -- env HOME=/home/user USER=user LOGNAME=user \
		VNC_PASSWORD="${VNC_PASSWORD:-}" SCREEN_SIZE="${SCREEN_SIZE:-}" "$0" "$@"
fi

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
export VNC_PASSWORD
umask 077
echo "$VNC_PASSWORD" >/tmp/vnc-password
x11vnc -storepasswd "$VNC_PASSWORD" /tmp/vnc-passwd >/dev/null

Xvfb "$DISPLAY" -screen 0 "$SCREEN" &
echo $! >"$XVFB_PIDFILE"
sleep 0.5

# Desktop: window manager (with compositor, for the dock's transparency), the
# wallpaper/icon manager and the Plank dock, all on one session bus. No XFCE
# session or panel. Nothing is auto-launched on top: apps start from the dock,
# or from an agent via desktop_run.
export GSETTINGS_BACKEND=keyfile
dbus-launch --exit-with-session sh -c '
	xfsettingsd &
	xfwm4 --compositor=on &
	xfdesktop &
	exec plank
' >/tmp/desktop.log 2>&1 &

# Set the wallpaper on every monitor xfdesktop registers. The property path
# includes the monitor name, which differs between Xvfb setups, so find it
# instead of hard-coding it. Waits for xfdesktop to publish its properties.
(
	export DISPLAY
	for _ in $(seq 1 50); do
		props=$(xfconf-query -c xfce4-desktop -l 2>/dev/null | grep '/last-image$' || true)
		[ -n "$props" ] && break
		sleep 0.2
	done
	for p in $props; do
		xfconf-query -c xfce4-desktop -p "$p" -s /usr/share/backgrounds/maskin.png
		xfconf-query -c xfce4-desktop -p "${p%last-image}image-style" -n -t int -s 5
	done
) &

# VNC server is loopback-only; only websockify (below) is reachable from outside.
x11vnc -display "$DISPLAY" -rfbport "$VNC_PORT" -rfbauth /tmp/vnc-passwd \
  -localhost -forever -shared -noxdamage -quiet &

until (echo >/dev/tcp/127.0.0.1/$VNC_PORT) 2>/dev/null || [ "${tries:=0}" -ge 50 ]; do
	tries=$((tries + 1))
	sleep 0.2
done

# Control API for agents (screenshot / input / exec). Its /healthz only turns 200
# once X and websockify are both up, which is what the agent-server waits for.
DISPLAY="$DISPLAY" python3 /usr/local/bin/desktopd.py &

exec websockify --web /usr/share/novnc "$NOVNC_PORT" "127.0.0.1:$VNC_PORT"
