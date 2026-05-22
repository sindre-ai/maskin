#!/bin/bash
set -e

# Start Xvfb on display :99 so chromium runs headful in a virtual framebuffer.
# 1280x800x24 matches the canvas size the modal renders.
Xvfb :99 -screen 0 1280x800x24 &

# Give Xvfb a moment to come up before chromium tries to connect.
sleep 1

# --no-sandbox: required inside Docker (no user namespaces by default).
# --remote-debugging-port=9222 + --remote-debugging-address=0.0.0.0: expose CDP
#   to the per-session Docker network (host port stays unpublished).
# --remote-allow-origins=*: Chrome 111+ blocks WebSocket upgrades from non-localhost
#   origins by default (DNS-rebinding protection). chrome-remote-interface connects
#   from the host so the upgrade is rejected ("socket hang up") without this flag.
# --user-data-dir: avoids permission issues in default profile location.
# --disable-blink-features=AutomationControlled: removes the "Chrome is being
#   controlled by automated test software" banner and the navigator.webdriver flag.
# Open LinkedIn login on startup so the modal user sees the right page immediately.
DISPLAY=:99 exec chromium \
	--no-sandbox \
	--remote-debugging-port=9222 \
	--remote-debugging-address=0.0.0.0 \
	--remote-allow-origins=* \
	--user-data-dir=/tmp/chrome-userdata \
	--disable-blink-features=AutomationControlled \
	--disable-features=Translate \
	--no-first-run \
	--no-default-browser-check \
	--window-size=1280,800 \
	https://www.linkedin.com/login
