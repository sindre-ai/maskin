# Desktop test image: Xvfb + XFCE + Chromium, streamed to a browser via
# x11vnc + noVNC. Proof of concept for a viewable agent computer — see
# README.md. Not wired into CI or the session launcher.
FROM debian:bookworm-slim

# XFCE gives a normal desktop (panel, app menu, wallpaper, icons, file manager).
# --no-install-recommends keeps out the screen locker, power manager and other
# daemons that make no sense on a virtual display.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xfce4-session \
    xfwm4 \
    xfce4-panel \
    xfdesktop4 \
    xfce4-settings \
    xfconf \
    thunar \
    xfce4-terminal \
    dbus-x11 \
    adwaita-icon-theme \
    fonts-dejavu-core \
    chromium \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    scrot \
    procps \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Chromium runs as root in the VM, so it needs --no-sandbox. Setting it here
# (not on one command line) makes the panel/menu launchers work too.
RUN printf '%s\n' \
    'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --no-sandbox --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check"' \
    > /etc/chromium.d/desktop-flags

# No compositor: there is no GPU, and it only costs CPU on a virtual display.
RUN mkdir -p /root/.config/xfce4/xfconf/xfce-perchannel-xml \
  && printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<channel name="xfwm4" version="1.0">' \
    '  <property name="general" type="empty">' \
    '    <property name="use_compositing" type="bool" value="false"/>' \
    '  </property>' \
    '</channel>' \
    > /root/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml

COPY entrypoint.sh /entrypoint.sh
COPY desktopd.py /usr/local/bin/desktopd.py
RUN chmod +x /entrypoint.sh /usr/local/bin/desktopd.py

# noVNC web client + WebSocket bridge to the VNC server.
# 6080 = noVNC (humans), 6081 = desktopd control API (agents, via the agent-server).
EXPOSE 6080 6081

ENTRYPOINT ["/entrypoint.sh"]
