# Microsandbox v0.3.12 Upgrade — Handover

Branch: `feat/microsandbox` (do **not** merge to `main` until production-polish below is done)
Working commit: `2314817` — "Use KillMode=process so systemd doesn't kill msb's VM subprocess"
Verified end-to-end on the Finland Hetzner AX server: a real session booted, ran the entrypoint, exited 0, and was cleaned up.

## TL;DR — What works

A Hetzner bare-metal host (Ubuntu 24.04, KVM available) runs:

1. `agent-server` as a **systemd service** (not in Docker — microVMs cannot run nested in containers reliably).
2. The service shells out to the **`msb` CLI** to boot sandboxes via `systemd-run` with `KillMode=process`, then **reconnects** with the v0.3.12 SDK to get an `exec`/`shellStream`/`fs` handle.

The SDK's `Sandbox.create()` works from a fresh shell, but it consistently fails the VMM handshake when called from inside the agent-server process tree. The CLI route is a workaround that we never fully bottomed out — see "What didn't work" for the dead ends we ruled out.

---

## The minimum viable setup on a fresh Hetzner box

1. **Ubuntu 24.04** (glibc 2.39 — required by the prebuilt NAPI binary). 22.04 / Debian Bookworm fail with `GLIBC_2.38 not found`.
2. **KVM enabled** (`/dev/kvm` present, group `kvm`).
3. Install: `apt-get install libdbus-1-3 build-essential` + Node.js 20 via nodesource + pnpm.
4. Install microsandbox CLI to `/root/.microsandbox/bin/msb` (their installer).
5. Clone repo, `pnpm install`, `pnpm build`.
6. Drop in `/etc/systemd/system/maskin-agent-server.service`:

   ```ini
   [Unit]
   Description=Maskin Agent Server
   After=network-online.target
   Wants=network-online.target

   [Service]
   Type=simple
   User=root
   WorkingDirectory=/opt/maskin
   EnvironmentFile=/opt/maskin/apps/agent-server/.env
   Environment=NODE_ENV=production
   Environment=PORT=3001
   ExecStart=/usr/bin/node apps/agent-server/dist/index.js
   Restart=on-failure
   RestartSec=5

   [Install]
   WantedBy=multi-user.target
   ```

7. `systemctl daemon-reload && systemctl enable --now maskin-agent-server`.

---

## Boot sequence (apps/agent-server/src/services/microsandbox-backend.ts)

```ts
const MSB_BIN = '/root/.microsandbox/bin/msb'

execFileSync(
  '/usr/bin/systemd-run',
  [
    '--quiet',
    '--property=KillMode=process',   // <-- the magic. Don't cgroup-kill the VM.
    '--property=ExecStopPost=',      // clear inherited cleanup actions
    MSB_BIN,
    'create',
    '--name', name,
    '--memory', `${memoryMib}M`,
    '--cpus', String(cpus),
    '--replace',
    '--pull', 'always',
    '--quiet',
    ...envFlags,                     // -e KEY=VAL ...
    ...volumeFlags,                  // -v HOST:GUEST ...
    image,
  ],
  { timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'] },
)

// Then poll `msb list --format json` until status === 'running' (capitalized in CLI output).
// Then reconnect:
const sandbox = await (await Sandbox.get(name)).connect()
```

Why `KillMode=process`? `msb create` is a short-lived parent that spawns the long-lived `msb sandbox` VM subprocess. With systemd's default `KillMode=control-group`, when the parent exits the entire transient unit's cgroup is killed — including the VM. `KillMode=process` only tracks the main PID for liveness; the subprocess survives reparented to PID 1.

---

## Constraints we discovered the hard way

| Constraint | Symptom when violated | Fix |
|---|---|---|
| **Env var values must be printable ASCII** | libkrun panics with `InvalidAscii` (e.g. Norwegian `æøå` in SYSTEM_PROMPT) | `value.replace(/[^\x20-\x7E]/g, '')` |
| **Env var values >~1500 chars break the handshake** | Boot hangs / handshake reset | Spill long values to `/agent/.env-overflow.sh` and `source` it in `agent-run.sh` |
| **Bind-mounting `/agent` wipes WORKDIR** | `workdir does not exist in guest: /agent/workspace` | Pre-create `workspace`, `skills`, `learnings`, `memory` subdirs on the host before boot |
| **Cannot run microVMs in Docker** | SIGABRT during VM boot inside Coolify container, even with `--device /dev/kvm --cap-add SYS_ADMIN` | Run agent-server as a **bare-metal systemd service** |
| **Glibc < 2.38 breaks the NAPI prebuilt** | `GLIBC_2.38 not found` | Ubuntu 24.04 (do not use `node:20-slim` / Bookworm) |
| **Missing libdbus** | `libdbus-1.so.3 not found` at startup | `apt-get install libdbus-1-3` |

---

## What didn't work (don't waste time re-trying these)

All the following still produced the handshake failure when invoked from agent-server's process tree:

- Plain `execFileSync(MSB_BIN, [...])` — child still inherits cgroup/FDs.
- `bash -c 'exec $fd>&-; ...'` to close inherited file descriptors. Also accidentally ate stderr.
- `setsid` to escape the process group.
- `env -i` to start with a clean environment.
- `systemd-run --scope` — keeps the process in the caller's session.
- `systemd-run --service-type=forking --wait` — msb doesn't daemonize in a way systemd's forking detection accepts; timed out.

The breakthrough was a transient service (default `Type=simple`) **plus** `KillMode=process` so the VM subprocess isn't taken down with the short-lived parent.

We never fully proved *why* being a descendant of agent-server breaks the handshake. Hypotheses (untested): inherited file descriptors poisoning libkrun's vsock setup, signal mask inheritance, or some Node-specific stdio fd state. Worth a deeper dive if microsandbox upstream cares.

---

## Production-polish to-do list (handing over)

These are intentionally left as cleanup work — the current code is working but rough.

1. **Remove diagnostic logging** — the env-var sanitization warnings are useful, but the older verbose env-dump logging from earlier debugging may still be reachable. Audit `microsandbox-backend.ts` and surrounding services.
2. **Fix `getHostAddress()`** — currently hardcoded `172.17.0.1` (the Docker bridge gateway). On a bare host without Docker, this is wrong. Should be the host's LAN IP that the microVM can reach. Probably needs to be wired through `MASKIN_API_URL` directly.
3. **Network policy** — the msb CLI default is `publicOnly`, which blocks private IPs. Sessions need to reach the host API (currently at `MASKIN_API_URL`). Either:
   - Run a public ingress that proxies to the host API, or
   - Switch msb to `allowAll` (we'd need to verify the CLI flag is `--network-policy allow-all` or similar — check `msb create --help`).
4. **Configurable MSB_BIN path** — currently hardcoded `/root/.microsandbox/bin/msb`. Should be `process.env.MSB_BIN ?? '/root/.microsandbox/bin/msb'`.
5. **Simplify `onExit`** — since we never own the VM lifecycle (we connect to a detached sandbox), `sandbox.wait()` always falls back to log-stream-driven exit detection. The fallback works; the dead path can go.
6. **msb SQLite drift** — on the Finland host we hit `index idx_manifest_layers_unique already exists`. Manageable today; document a `rm -rf ~/.microsandbox/state.db` recovery step or file an upstream issue.
7. **Zombie-sandbox cleanup at boot** — leftover sandboxes from crashed agent-server runs occupy capacity. Either `msb remove --all` on startup, or query and reconcile.
8. **Stale-session DB cleanup** — sessions stuck in `running`/`starting`/`pending` from prior crashes block the queue. Currently fixed by hand:
   ```sql
   UPDATE sessions SET status='failed' WHERE status IN ('running','starting','pending');
   ```
   Should be a startup reconciler.
9. **`Sandbox.create()` regression test** — periodically retry the SDK path. If upstream fixes the handshake bug, drop the CLI workaround and `systemd-run` plumbing entirely.
10. **Docs**: deployment guide for the Finland host (systemd unit, env file, KVM check, `msb` install, log/journalctl pointers).

---

## Files changed by this work

- `apps/agent-server/package.json` — `microsandbox: ^0.1.0` → `^0.3.12` (optionalDependencies)
- `apps/dev/package.json` — same version bump for consistency
- `apps/agent-server/src/services/microsandbox-backend.ts` — full rewrite around the v0.3.12 SDK + msb-CLI boot
- `apps/agent-server/Dockerfile` — Ubuntu 24.04 base + libdbus-1-3 (kept for the alternative Docker deployment path, though we don't use it)
- `docker/agent-base/agent-run.sh` — sources `/agent/.env-overflow.sh` if present (image rebuilt + pushed as `magnusnoeddegaard/agent-base:latest`)

## Operational notes

- **Logs**: `journalctl -u maskin-agent-server -f` on the Finland host.
- **Manual test**: `curl -X POST http://<host>:3001/sessions -H "Authorization: Bearer <AGENT_SERVER_SECRET>" -d '{...}'` — exact payload in the route handler.
- **Cleaning up sandboxes**: `msb list --format json`, then `msb remove -f <name>`.

## Security follow-up

A Supabase pooler credential was pasted into the chat during debugging. Rotate it before this branch goes anywhere near production.
