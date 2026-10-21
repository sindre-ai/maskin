# desktop

The agent computer: an msb microVM image that shows a live desktop in a browser
(Xvfb, XFCE, Chromium, x11vnc and noVNC).

## How it ships

Merging a change under `docker/desktop/` to `main` runs
`.github/workflows/desktop-docker.yml`, which builds the image and pushes it to
Docker Hub as `latest` and `sha-<commit>` (repository in the `DESKTOP_IMAGE` GitHub
Actions variable, default `magnusnoeddegaard/maskin-desktop`). The agent-server
creates every new desktop with `--pull always`, so new desktops use the newest
`latest` with no restart or redeploy. A desktop that already exists keeps the image
it was created from until it is deleted (`DELETE /desktops/:id`) and re-opened.
`DESKTOP_IMAGE` in the agent-server environment overrides the image (default
`magnusnoeddegaard/maskin-desktop:latest`).

## Build by hand (from a machine with Docker)

    docker build -t <registry>/maskin-desktop:latest docker/desktop
    docker push <registry>/maskin-desktop:latest

## Run on the msb server

    # 6080 is published on the bridge only
    msb create --name desktop-test --memory 2048M --cpus 2 --pull always \
      -p 10.0.1.1:16080:6080 --net-rule allow@public \
      --net-rule allow@any:udp:53 --net-rule allow@any:tcp:53 \
      <registry>/maskin-desktop:latest
    msb exec desktop-test      # starts the entrypoint (create does not)
    msb exec desktop-test -- cat /tmp/vnc-password

Open `http://10.0.1.1:16080/vnc.html` from the server (or an SSH tunnel:
`ssh -L 16080:10.0.1.1:16080 <server>` then `http://localhost:16080/vnc.html`).

## What to check

- Does the desktop appear and respond to mouse and keyboard?
- Memory use (`msb` stats / `free -m` in the VM) idle and with Chromium open.
- `xdotool` and `scrot` work in the VM (`DISPLAY=:99`) so an agent can drive it.

## Agent control (desktopd)

`desktopd.py` serves a small bearer-authenticated HTTP API on guest port 6081
(`POST /screenshot`, `/input`, `/exec`; `GET /healthz`), published on the msb
bridge next to noVNC. The agent-server proxies to it; apps/dev exposes it as
`/api/desktop/{screenshot,input,exec}` and the Maskin MCP as `desktop_*` tools.

It exists because `msb exec <vm> -- <cmd>` hangs (even `echo hi`) while the
entrypoint's own `msb exec` holds the VM — verified on msb 0.5.7 — so the host
cannot run `xdotool`/`scrot` by exec'ing into the VM. `/healthz` returns 200
only once X and noVNC are up; the agent-server waits on it, because a TCP connect
to a published port succeeds before anything listens in the guest.

## Users and the browser sandbox

The desktop runs as an ordinary user (`user`), not root, because Chromium refuses
to enable its security sandbox as root. `user` has passwordless `sudo`, so anything
needing administrator rights (`sudo apt-get install ...`, editing system files)
still works; it is just explicit. `entrypoint.sh` starts as root and drops to
`user` before launching anything, so desktopd (and therefore every `desktop_run`
command) is `user` too. Verified on msb 0.5.7: unprivileged user namespaces are
available in the microVM, so the sandbox works without `--no-sandbox`.

## Suspend and wake (msb >= 0.7)

Set `DESKTOP_SNAPSHOTS=1` on the agent-server and an idle desktop is suspended to a
full memory snapshot, then restored the next time anything needs it: the open windows,
browser tabs and half-typed text come back exactly as they were. It needs msb 0.7 or
later, so it is off by default and a desktop on msb 0.5.x is created the old way.

- `DESKTOP_IDLE_MINUTES` (default 10): minutes with no noVNC viewer and no agent call
  (`desktop_*`) before a desktop is suspended. `0` never suspends automatically.
- A suspend writes a standalone archive, `<AGENT_SESSION_ROOT>/.workspace-desktop-snapshots/<name>.msb`
  (about 240 MB for a desktop with Chromium open), then stops and removes the VM. A wake
  restores it on the same ports and deletes the archive.
- Any control call, a stream, or `PUT /desktops/:workspaceId/:agentId` wakes a suspended desktop.
  `GET /desktops/:workspaceId/:agentId` reports `suspended` without waking it; `GET /desktops/:workspaceId` lists the workspace's agent computers.
- If a restore fails, the archive is kept and the desktop stays suspended. `DELETE
  /desktops/:id` discards it and the next `PUT` provisions a fresh desktop.

The desktop must be started with `msb run -d` for this to work: msb refuses a full
snapshot while any managed job is active, and `msb create` + `msb exec` makes the
entrypoint one. The agent-server does this automatically when snapshots are on.

Measured on msb 0.7.8, 3 GiB / 2 CPU, Chromium with three tabs open: snapshot 9 s,
restore 5.5 s, archive 237 MB (zstd). Each wake restores the exact state, outbound
network and clock included. Live connections are not saved, so a noVNC viewer
reconnects after a wake.

## One computer per agent

A desktop belongs to one agent, identified by (workspace, agent), and shares no disk,
memory or browser profile with any other: a login on one agent's computer is invisible
to the rest. Computers are created the first time they are opened. An agent can only
reach its own (naming another is a 403); a person names the agent whose computer they
mean. The access rule is in `apps/dev/src/lib/desktop-access.ts`.

The VM name is `anko-desktop-<32 hex of sha256(workspace:agent)>`, not the two UUIDs:
msb uses the name as the guest hostname, and a label over 63 characters makes desktopd
fail (`gethostbyaddr: label too long`) so the desktop never becomes ready.
