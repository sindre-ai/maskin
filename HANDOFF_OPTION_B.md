# Handoff — Option B: patch microsandbox's VM→host (egress) wake bug, build & deploy

You are picking up a focused infra task. Read this whole file first. There are project
memories (`MEMORY.md` and `memory/msb-vm-host-log-streaming.md`, `memory/maskin-prod-staging-split.md`,
`memory/finland-agent-server-deploy.md`) with deeper background — read them too.

## Mission
Make **agent session logs stream live, line-by-line, into the Maskin UI** for sessions that
run on the remote **Finland microsandbox agent-server** — by FIXING microsandbox itself, so
the EXISTING HTTP-push log pipeline (already built) works. No agent-server re-architecture.

## Root cause (already proven — this is exactly what you will patch)
microsandbox **0.5.7**'s VM→host (egress) TCP proxy never wakes the smoltcp poll loop after
draining guest→server data, so VM→host bytes aren't forwarded until the connection closes (or
a slow `poll(2)` timeout). A held-open/streamed upload from inside the VM therefore delivers
nothing live; a short self-closing POST eventually arrives but with 6–150s latency. This breaks
the agent-base `agent-run.sh` log push to the agent-server's `/sessions/:id/logs/ingest`.

The symmetric fix exists for the INBOUND (host→VM) direction and is the template:
- **PR #915** (in v0.5.5): "wake poll loop after draining inbound relay channel" — adds
  `shared.proxy_wake.wake()` after a successful write in the host→guest relay, *"mirroring the
  pattern already used in the host-to-guest direction at proxy.rs:174."*
- **PR #930** (v0.5.6) hardened the same inbound path.
The **egress (guest→server) branch was never given the wake** — and it's byte-identical in
`v0.5.7` and `main`. (Issue #894/#905, shipped in 0.5.7, fix an unrelated first-TLS-handshake
hang, not this.)

## The fix
In the microsandbox source, `crates/network/lib/proxy.rs`, the per-connection relay task has a
`tokio::select!` loop with two branches:
- **server→guest** (~line 274): after queuing data it calls `shared.proxy_wake.wake()`.
- **guest→server** (egress): after `from_smoltcp.recv()` frees channel capacity it does
  `write_all`+`flush` to the host socket but **does NOT** call `proxy_wake.wake()`.
Add `shared.proxy_wake.wake()` to the guest→server branch after the recv/drain, mirroring the
server→guest branch and PR #915. That's the core change (verify exact symbol/where against the
current source — the research read it at tag `v0.5.7`). Also sanity-check `crates/network/lib/conn.rs`
(`relay_data()`, `CHANNEL_CAPACITY = 32`) to confirm the poll loop refills from the guest socket
once woken.

## Steps
1. **Confirm the bug location.** Clone `github.com/microsandbox/microsandbox` (may also be
   `superradcompany/microsandbox` / `zerocore-ai/microsandbox`), check out the tag matching the
   box's version (`/root/.microsandbox/bin/msb --version` → 0.5.7). Open `crates/network/lib/proxy.rs`,
   find the egress branch missing the wake. (Cross-ref PR #915's diff for the exact pattern.)
2. **Apply the one-line wake** in the egress branch. Keep the diff minimal.
3. **Build** the patched `msb` (and whatever runtime component embeds the network proxy — it may
   be the `msb` CLI and/or a microsandbox runtime/portal binary; check the build). This is Rust;
   it may need libkrun and platform deps — build ON the Finland box or a matching Ubuntu 24.04
   x86_64 env. Expect this to be the hard part; document what you do.
4. **Deploy to Finland:** back up the current binary (`cp /root/.microsandbox/bin/msb{,.0.5.7.bak}`),
   install the patched binary, `systemctl restart maskin-agent-server` (re-warms). Verify
   `msb --version` and `/health`.
5. **Test:** start an interactive session on `staging.maskin.sindre.ai`. The existing
   `log_tee` HTTP push should now stream live. If still laggy, the wake may need to also cover
   the blocked-write path (cf. #930) — iterate.
6. Optionally file the fix upstream (issue + PR referencing #914/#915/#930 as the inbound precedent).

## The existing log pipeline you're un-blocking (do NOT rewrite it)
agent-base `agent-run.sh` already streams the whole session to the agent-server via short
self-closing `--data-binary` POSTs every ~2s (`log_tee`/`flush_log_batch`) to
`/sessions/:id/logs/ingest`; the agent-server (`apps/agent-server/src/index.ts`) reads that and
flushes to `${MASKIN_BASE_URL}/api/internal/agent-servers/sessions/:id/logs`. Once egress
forwards promptly, these arrive live. (You could also simplify back to a single `curl -T -`
chunked stream once egress is fixed, but first just confirm the current batched push goes live.)

## Environment & how to deploy/test (CRITICAL — read `memory/finland-agent-server-deploy.md` + `maskin-prod-staging-split.md`)
- **Finland box:** `ssh root@95.217.231.223` (Ubuntu 24.04 x86_64, msb at `/root/.microsandbox/bin/msb`,
  v0.5.7). systemd `maskin-agent-server` → `/opt/maskin/apps/agent-server/dist/index.js`, listens
  `0.0.0.0:3001`, EnvironmentFile `/opt/maskin/apps/agent-server/.env`
  (`MASKIN_BASE_URL=https://staging.maskin.sindre.ai`, `WARM_POOL_IMAGE=magnusnoeddegaard/agent-base:latest`).
- **Test app:** `staging.maskin.sindre.ai` (Coolify app `hfifvopyo6r9p22199mz9ymt`, tracks `staging`,
  isolated DB, `AGENT_SERVERS=http://95.217.231.223:3001|<secret>`, `AGENT_BASE_IMAGE=magnusnoeddegaard/agent-base:latest`).
  PRODUCTION (`maskin.sindre.ai`) is rolled back to pre-infra and does NOT use Finland — don't touch it.
- **Test a session:** open `staging.maskin.sindre.ai`, create a workspace, import Claude Max creds
  (Settings → Keys), start an interactive session, watch logs. Read Finland: `msb list`. Check
  staging ingest via Coolify app logs (MCP `mcp__coolify__application_logs`, app `hfifvopyo6r9p22199mz9ymt`)
  — you want to see `POST /api/internal/agent-servers/sessions/<sid>/logs` arriving live.
- **Quick transport check** (no full session): you can validate egress streaming with a small VM
  test — there are scripts in `/root/streamtest/` on Finland (emit-lines + a probe HTTP server)
  from prior work; reuse them to confirm a held-open chunked POST now forwards mid-stream after
  the patch.

## Gotchas
- `msb` command args contain session SECRETS — avoid full `ps`/`journalctl` dumps; filter. Rotate pending.
- `--pull always` re-pulls Docker Hub; use `--pull never` for local test images.
- PowerShell shell; `$`/backtick inside `ssh "..."` get mangled — put remote logic in scp'd `.sh` scripts (`tr -d '\r'`).
- Keep prod :3001 working; you can run a second agent-server on :3002 for safe testing.
- Back up the original `msb` binary before swapping; keep a rollback path.

## Success criteria
Patched `msb` deployed to Finland; an **interactive** session on `staging.maskin.sindre.ai`
streams logs **live, line-by-line, within a few seconds**. Document the build/deploy so the
patched binary is reproducible. Commit any repo changes to this branch; open a PR to `staging`.

## Pre-commit (for any repo changes)
`pnpm lint`, `pnpm type-check`, `pnpm test -- --run` (see `.claude/rules/pre-commit.md`).
