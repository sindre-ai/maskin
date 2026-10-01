# desktop-test

Throwaway image to check that an msb microVM can show a live desktop in a
browser. Mirrors `docker/browser-sidecar` (Xvfb + Chromium) and adds openbox,
x11vnc and noVNC. Not built by CI and not used by the session launcher.

## Build and push (from a machine with Docker)

    docker build -t <registry>/desktop-test:latest docker/desktop-test
    docker push <registry>/desktop-test:latest

## Run on the msb server

    # 6080 is published on the bridge only, like the sidecar's CDP port
    msb create --name desktop-test --memory 2048M --cpus 2 --pull always \
      -p 10.0.1.1:16080:6080 --net-rule allow@public \
      --net-rule allow@any:udp:53 --net-rule allow@any:tcp:53 \
      <registry>/desktop-test:latest
    msb exec desktop-test      # starts the entrypoint (create does not)
    msb exec desktop-test -- cat /tmp/vnc-password

Open `http://10.0.1.1:16080/vnc.html` from the server (or an SSH tunnel:
`ssh -L 16080:10.0.1.1:16080 <server>` then `http://localhost:16080/vnc.html`).

## What to check

- Does the desktop appear and respond to mouse and keyboard?
- Memory use (`msb` stats / `free -m` in the VM) idle and with Chromium open.
- Does it still work over the `allow@private` or SSH-relay path
  (see issue #1327 notes in `microsandbox.ts`)?
- `xdotool` and `scrot` work in the VM (`DISPLAY=:99`) so an agent can drive it.
