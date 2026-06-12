# agent-server — Bare-Metal Host Setup

This is the host-prep recipe for a Maskin `agent-server` box: a Hetzner (or
equivalent) bare-metal server running Ubuntu 24.04 + KVM + libkrun +
microsandbox v0.5.4, with `agent-server` itself running as a systemd service.

Run it once on the Finland host. To add a second box later, repeat top-to-bottom
and insert a row into the `agent_servers` table — no code change.

> microsandbox boots OCI images as KVM-backed microVMs. The host **must** be
> bare metal (or a KVM-enabled VM with hardware-assisted nesting — not the
> default on most cloud providers). microVMs do not run reliably inside Docker
> even with `--device /dev/kvm --cap-add SYS_ADMIN`.

## 0. Pre-flight

| Requirement | Why | Verify |
|---|---|---|
| Bare metal (or nested-virt enabled) | libkrun needs KVM directly | `egrep -c '(vmx\|svm)' /proc/cpuinfo` returns ≥ 1 |
| Ubuntu 24.04 LTS | microsandbox NAPI prebuilt needs glibc 2.39 | `ldd --version \| head -1` |
| `/dev/kvm` present + r/w | All sandbox boots go through KVM | `ls -l /dev/kvm` |
| Root or sudo | Service runs as root | `id` |
| Public IPv4 | microVMs reach back to apps/dev over the public internet | `ip -4 addr` |

Ubuntu 22.04, Debian Bookworm, or `node:20-slim` all fail at startup with
`GLIBC_2.38 not found`. Do not substitute the OS.

## 1. System packages

```bash
apt-get update
apt-get install -y \
  libdbus-1-3 \
  build-essential \
  ca-certificates \
  curl \
  jq \
  qemu-kvm
```

`libdbus-1.so.3` is a hard runtime dependency of the microsandbox CLI; without
it, `msb` exits immediately with `libdbus-1.so.3: cannot open shared object`.

## 2. Confirm KVM

```bash
ls -l /dev/kvm                       # must exist, mode 660
lsmod | grep -E 'kvm_intel|kvm_amd'  # one of these must be loaded
```

If `/dev/kvm` is missing on a Hetzner AX box, KVM is almost always disabled in
BIOS — open a ticket with Hetzner support to enable VT-x/AMD-V. Do not proceed
until `/dev/kvm` is readable.

## 3. Node.js 20 + pnpm

```bash
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
corepack enable
corepack prepare pnpm@9.15.0 --activate
```

## 4. Install microsandbox CLI (pin v0.5.4)

```bash
curl -fsSL https://install.microsandbox.dev | bash -s -- --version 0.5.4
# installs to ~/.microsandbox/bin/msb
msb --version    # expect: microsandbox 0.5.4
```

Pin the version. v0.5.4 is the first release with the `--net-rule` flag we
depend on (see §7); earlier versions silently drop traffic to RFC1918
addresses, which forced the older v0.3.12 deploy into a public-IP hairpin
hack. If a newer version ships, validate the network rules and the
`Sandbox.create()` handshake before bumping.

## 5. Pre-create `/agent` workspace tree (per host)

Bind-mounting `/agent` into a microVM wipes the image's WORKDIR, so the
subdirectories that the agent harness reads (`workspace/`, `skills/`,
`learnings/`, `memory/`) must exist on the host **before** any sandbox boots —
otherwise the entrypoint fails with `workdir does not exist in guest`. This is
operational constraint #3 from the bet.

The runtime per-session tree lives under `/agent/sessions/<session-id>/`. Pre-
create the base path with the four subdirs so the first sandbox boot has
something to bind:

```bash
install -d -m 0755 \
  /agent \
  /agent/sessions \
  /agent/skel/workspace \
  /agent/skel/skills \
  /agent/skel/learnings \
  /agent/skel/memory
```

T2 (`apps/agent-server` spawn path) copies `/agent/skel` → the session tree
before each boot. Keep the skeleton owned by root; sessions get their own
directory per `agent_servers.id`.

## 6. Clone, build, env file

```bash
git clone https://github.com/sindre-ai/maskin.git /opt/maskin
cd /opt/maskin
pnpm install --frozen-lockfile
pnpm --filter @maskin/agent-server build
```

Drop a `.env` at `/opt/maskin/apps/agent-server/.env`:

```
PORT=3001
RUNTIME_BACKEND=microsandbox

# Auth shared with apps/dev. Generate with: openssl rand -hex 32
AGENT_SERVER_SECRET=...

# Postgres reached by agent-server for session reconciliation
DATABASE_URL=postgres://...

# S3-compatible storage for persistent /agent files (T8)
S3_ENDPOINT=...
S3_BUCKET=maskin-agent-files
S3_ACCESS_KEY=...
S3_SECRET_KEY=...

# microsandbox CLI binary (override if not at the default path)
# MSB_BIN=/root/.microsandbox/bin/msb

# Public hostname or IP this box is reachable at from a microVM.
# Used to compose --net-rule. See §7.
MASKIN_AGENT_SERVER_PUBLIC_HOST=agent-finland.maskin.sindre.ai
```

`AGENT_SERVER_SECRET` is the shared bearer token for the `apps/dev` →
`apps/agent-server` dispatch call. Mirror the same value into the
`agent_servers.secret` column for this host's row (T5 owns the schema).

`chmod 600 /opt/maskin/apps/agent-server/.env` — it contains credentials.

## 7. Networking — v0.5.4 `--net-rule` (replaces the v0.3.12 hairpin hack)

microsandbox v0.5.4 added per-sandbox network allow-list rules. agent-server
will pass `--net-rule allow@host:tcp:<port>` to `msb create` so each microVM
can reach the host on `localhost` directly — no public-IP hairpin, no
`MASKIN_HOST_ADDRESS` autodetection, no firewall hole-punching.

Operational consequence on the host:

- agent-server binds to `0.0.0.0:3001` (the systemd unit's default).
- The firewall **must allow** `127.0.0.1` ↔ host loopback unconditionally.
- The agent-server port does not need to be reachable from the public
  internet — apps/dev reaches it over the tunnel, microVMs reach it over the
  host loopback. If your provider's firewall fronts the box, only allow the
  dispatch source IP for 3001.

If a microVM needs to reach an arbitrary external host (e.g. third-party APIs
called by tools), agent-server will compose additional `--net-rule` entries
per session. That logic lives in T2.

## 8. systemd unit

Copy the unit from this repo and enable it:

```bash
cp /opt/maskin/apps/agent-server/systemd/maskin-agent-server.service \
   /etc/systemd/system/maskin-agent-server.service
systemctl daemon-reload
systemctl enable --now maskin-agent-server
systemctl status maskin-agent-server --no-pager
```

The unit (`apps/agent-server/systemd/maskin-agent-server.service` in the
repo):

- `Type=simple` — agent-server itself stays in the foreground.
- `Restart=on-failure`, `RestartSec=5` — five-second backoff on crash.
- `User=root` — required to bind-mount `/agent` and shell out to `msb`.

Why the unit does **not** set `KillMode=process` on `maskin-agent-server`
itself: that flag is only needed on the *transient* unit that `msb create`
gets wrapped in (so the long-lived microVM subprocess isn't killed when the
short-lived `msb create` parent exits). The transient unit is created by
agent-server at session-start via `systemd-run --property=KillMode=process …`,
not by the static unit shipped here. See `MICROSANDBOX_HANDOVER.md` on
`feat/microsandbox` for the full investigation.

## 9. Verify the box is ready

```bash
# 1. Service is up
systemctl is-active maskin-agent-server
# expect: active

# 2. agent-server health endpoint
curl -fsS http://127.0.0.1:3001/health
# expect: {"ok":true,"backend":"microsandbox","msb_version":"0.5.4"}

# 3. msb can boot a sandbox end-to-end
msb create --name probe --memory 512M --cpus 1 --replace \
  --pull always alpine:3.20 -- sh -c 'echo hello && uname -a'
msb list --format json | jq '.[] | select(.name=="probe")'
msb remove -f probe

# 4. Recent logs are clean
journalctl -u maskin-agent-server -n 50 --no-pager
```

The box is provisioned when (1)–(4) succeed.

## 10. Operations & recovery

- **Tail logs**: `journalctl -u maskin-agent-server -f`
- **List sandboxes**: `msb list --format json`
- **Force-remove a sandbox**: `msb remove -f <name>`
- **Restart cleanly**: `systemctl restart maskin-agent-server` — agent-server
  reconciles two things on boot (T9 owns this code): zombie sandboxes
  (`msb list` → `msb remove -f` each) and DB rows stuck in
  `running`/`starting`/`pending`/`snapshotting` (mark `failed`).
- **`msb` SQLite drift** — if the CLI complains about
  `index idx_manifest_layers_unique already exists`, stop the service,
  `rm /root/.microsandbox/state.db`, restart.

## 11. Adding a second host

Repeat §1–§9 on the new box, then insert a row into `agent_servers` (T5):

```sql
INSERT INTO agent_servers (id, url, secret, max_concurrent_sessions, status)
VALUES (
  gen_random_uuid(),
  'https://agent-<region>.maskin.sindre.ai:3001',
  '<the AGENT_SERVER_SECRET from this box>',
  64,
  'active'
);
```

`SessionDispatcher` (T6) will start routing work to the new host on its next
capacity check. No application redeploy needed.

## 12. References

- Bet: [Scalable Agent Session Infrastructure](https://maskin.sindre.ai/fe944fe6-7b45-478c-afc7-b889cea63c08/objects/8b88c5bc-8767-42e4-8efd-68a074de7dee) — operational constraints #1–#7 are the authoritative list.
- `apps/agent-server/MICROSANDBOX_HANDOVER.md` on `feat/microsandbox` (PR #342) — the v0.3.12 investigation that produced the constraints. Read for context, do not merge.
- `apps/agent-server/DEPLOY.md` on `feat/microsandbox` — earlier v0.3.12 deploy notes. Superseded by this file once v0.5.4 lands on `main`.
