# Browser sidecar: headful Chromium + Xvfb + socat CDP bridge
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    chromium \
    xvfb \
    socat \
    python3 \
    ca-certificates \
  && rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
COPY host-rewrite-proxy.py /host-rewrite-proxy.py
RUN chmod +x /entrypoint.sh

EXPOSE 9222

ENTRYPOINT ["/entrypoint.sh"]
