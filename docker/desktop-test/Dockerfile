# Desktop test image: Xvfb + openbox + Chromium, streamed to a browser via
# x11vnc + noVNC. Proof of concept for a viewable agent computer — see
# README.md. Not wired into CI or the session launcher.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    xvfb \
    openbox \
    xterm \
    chromium \
    x11vnc \
    novnc \
    websockify \
    xdotool \
    scrot \
    procps \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

# noVNC web client + WebSocket bridge to the VNC server.
EXPOSE 6080

ENTRYPOINT ["/entrypoint.sh"]
