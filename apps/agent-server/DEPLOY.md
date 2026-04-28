# agent-server — Bare-Metal Deployment (microsandbox backend)

The microsandbox backend runs OCI images as KVM-backed microVMs. The host **must** be bare metal (or a KVM-enabled VM): microVMs cannot run reliably nested in Docker. The reference deploy is a Hetzner AX server.

## Host requirements

- **Ubuntu 24.04** — required for `glibc 2.39`. The microsandbox NAPI prebuilt fails on 22.04 / Debian Bookworm with `GLIBC_2.38 not found`. Do **not** use `node:20-slim`.
- **KVM enabled** — `/dev/kvm` must exist and be readable by the service user. Verify: `ls -l /dev/kvm` and `kvm-ok` if available.
- **Node.js ≥ 20** (install via NodeSource).
- **pnpm 9.15.0**.
- **System packages**: `apt-get install -y libdbus-1-3 build-essential`. The `libdbus-1.so.3` library is required at startup.

## Install microsandbox CLI

```bash
curl -sSL https://install.microsandbox.dev | bash
# installs to ~/.microsandbox/bin/msb
```

If you install it somewhere else, set `MSB_BIN=/path/to/msb` in the service env file.

## Clone & build

```bash
git clone <repo> /opt/maskin
cd /opt/maskin
pnpm install
pnpm build
```

## Environment file

Drop a `.env` at `/opt/maskin/apps/agent-server/.env` with at least:

```
DATABASE_URL=postgres://...
AGENT_SERVER_SECRET=...
PORT=3001
RUNTIME_BACKEND=microsandbox

# S3-compatible storage
S3_ENDPOINT=...
S3_BUCKET=agent-files
S3_ACCESS_KEY=...
S3_SECRET_KEY=...

# Optional: override microsandbox CLI path
# MSB_BIN=/root/.microsandbox/bin/msb

# Optional: extra flags for `msb create` (generic escape hatch).
# MSB_EXTRA_ARGS=--idle-timeout 1h

# Optional: override the host address microVMs use to reach this server.
# By default agent-server picks the first non-internal, non-RFC1918 IPv4
# from os.networkInterfaces(). Set this if auto-detection picks the wrong
# interface, or pass MASKIN_API_URL to bypass it entirely.
# MASKIN_HOST_ADDRESS=95.217.231.223
# MASKIN_API_URL=https://agent.example.com
```

## Networking note (microsandbox v0.3.12)

`msb` v0.3.12 has **no CLI flag** to change the default network policy (verified by `msb create --help`). The default policy is `publicOnly`, which **silently drops** connections to RFC1918 ranges (10/8, 172.16/12, 192.168/16) and link-local 169.254/16.

Empirically (Hetzner AX, Apr 2026):
- microVM → host's **public IP** (e.g. `95.217.231.223:3001`) **works** via krun's hairpin NAT
- microVM → `docker0` / `br-*` private gateway **blocked**
- microVM → external public IPs (e.g. `1.1.1.1:443`) **works**

So `MASKIN_API_URL` (or auto-detected `MASKIN_HOST_ADDRESS`) **must** be the host's public IP. agent-server's auto-detection skips RFC1918 addresses for exactly this reason. Make sure the agent-server port is bound to `0.0.0.0` (the default) so the public-IP route reaches it. You can keep the port firewalled from the public internet if needed — the microVM's traffic comes back through the host's loopback after NAT, not via the public network.

## systemd unit

Write `/etc/systemd/system/maskin-agent-server.service`:

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
ExecStart=/usr/bin/node apps/agent-server/dist/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
systemctl daemon-reload
systemctl enable --now maskin-agent-server
```

## Operational notes

- **Logs**: `journalctl -u maskin-agent-server -f`
- **List sandboxes**: `msb list --format json`
- **Force-remove a sandbox**: `msb remove -f <name>`
- **Recovery if `msb` SQLite drifts** (`index idx_manifest_layers_unique already exists`): stop the service, `rm ~/.microsandbox/state.db`, restart.

agent-server reconciles two things on startup:
1. Removes leftover sandboxes (zombie cleanup).
2. Marks any sessions stuck in `running`/`starting`/`pending`/`snapshotting` as `failed`.

So a clean restart is enough to recover from a crash — no manual SQL is needed.

## Why bare metal?

microVMs rely on KVM, which doesn't work reliably inside an unprivileged Docker container even with `--device /dev/kvm --cap-add SYS_ADMIN`. Coolify-style container deployments fail with SIGABRT during VM boot. Run agent-server directly on the host as a systemd service.

## Why a transient systemd service for `msb create`?

The microsandbox SDK's `Sandbox.create()` fails the VMM handshake when called from within agent-server's process tree. The workaround is to invoke `msb create` via `systemd-run` so the process reparents to systemd PID 1 and then reconnect with `Sandbox.get().connect()`. See `MICROSANDBOX_HANDOVER.md` for the full investigation.
