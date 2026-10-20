# Desktop test image: Xvfb + XFCE + Chromium, streamed to a browser via
# x11vnc + noVNC. Proof of concept for a viewable agent computer — see
# README.md. Not wired into CI or the session launcher.
FROM debian:bookworm-slim

# xfwm4 (windows) + xfdesktop (wallpaper) + Plank (a macOS-style dock). No XFCE
# session or panel: the dock is the only chrome. --no-install-recommends keeps
# out the screen locker, power manager and other daemons that make no sense on a
# virtual display.
RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    xfwm4 \
    plank \
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
    sudo \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

# Everything the person or agent sees runs as an ordinary user, not root: Chromium
# refuses to enable its security sandbox as root. Passwordless sudo means nothing
# that needs administrator rights is out of reach (apt install, system files);
# it is just deliberate (`sudo ...`) instead of the default for every process.
RUN useradd -m -s /bin/bash user \
  && echo 'user ALL=(ALL) NOPASSWD:ALL' > /etc/sudoers.d/user \
  && chmod 0440 /etc/sudoers.d/user

# Chromium flags, set here (not on one command line) so the dock and menu
# launchers get them too. No --no-sandbox: the sandbox is on.
RUN printf '%s\n' \
    'export CHROMIUM_FLAGS="$CHROMIUM_FLAGS --disable-gpu --disable-dev-shm-usage --no-first-run --no-default-browser-check"' \
    > /etc/chromium.d/desktop-flags

# Compositor on: Plank needs it for its translucent, rounded dock. It is software
# (xrender) rendering, but the screen is mostly static so the cost is small.
RUN mkdir -p /home/user/.config/xfce4/xfconf/xfce-perchannel-xml \
  && printf '%s\n' \
    '<?xml version="1.0" encoding="UTF-8"?>' \
    '<channel name="xfwm4" version="1.0">' \
    '  <property name="general" type="empty">' \
    '    <property name="use_compositing" type="bool" value="true"/>' \
    '    <property name="show_dock_shadow" type="bool" value="false"/>' \
    '    <property name="workspace_count" type="int" value="1"/>' \
    '  </property>' \
    '</channel>' \
    > /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/xfwm4.xml

# Clean desktop: a wallpaper, no desktop icons, and a floating dock (browser,
# files, terminal). Pictures come from make-wallpaper.py and make-icons.py.
COPY wallpaper.png /usr/share/backgrounds/maskin.png
COPY icons/ /usr/share/icons/maskin/
# Same file names as the system launchers on purpose: Plank pairs a running window
# with the .desktop file that matches its WM class, and a second launcher with a
# different name would leave every open app with an extra, unlabelled dock icon.
COPY apps/ /usr/share/applications/
COPY xfce/xfce4-desktop.xml /home/user/.config/xfce4/xfconf/xfce-perchannel-xml/
# The right-click desktop menu is built from this file: only the three dock apps.
COPY menus/xfce-applications.menu /etc/xdg/menus/xfce-applications.menu
COPY dock/launchers/ /home/user/.config/plank/dock1/launchers/
COPY dock/theme/ /home/user/.local/share/plank/themes/Maskin/
# Plank reads its settings through GSettings; the keyfile backend needs no dconf.
COPY dock/keyfile /home/user/.config/glib-2.0/settings/keyfile

# Everything above was written as root; hand the user its home.
RUN chown -R user:user /home/user

COPY entrypoint.sh /entrypoint.sh
COPY desktopd.py /usr/local/bin/desktopd.py
RUN chmod +x /entrypoint.sh /usr/local/bin/desktopd.py

# noVNC web client + WebSocket bridge to the VNC server.
# 6080 = noVNC (humans), 6081 = desktopd control API (agents, via the agent-server).
EXPOSE 6080 6081

ENTRYPOINT ["/entrypoint.sh"]
