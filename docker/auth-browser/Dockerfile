FROM debian:bookworm-slim

# Headful Chromium + Xvfb for server-side interactive browser sessions used
# by the LinkedIn (and future) connect flow. The container exposes Chrome
# DevTools Protocol on port 9222 (internal Docker network only) so the
# backend's CDP proxy can stream Page.screencast frames to the user's modal.
RUN apt-get update && apt-get install -y --no-install-recommends \
		chromium \
		xvfb \
		ca-certificates \
		fonts-liberation \
		dumb-init \
		socat \
	&& rm -rf /var/lib/apt/lists/*

COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

EXPOSE 9222

# dumb-init reaps Xvfb so the container shuts down cleanly when chromium exits.
ENTRYPOINT ["/usr/bin/dumb-init", "--", "/entrypoint.sh"]
