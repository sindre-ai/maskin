# Handoff — Option A: live agent logs via the microsandbox agentd channel (`msb logs`)

You are picking up a focused infra task. Read this whole file first. There are project
memories (`MEMORY.md` and `memory/msb-vm-host-log-streaming.md`, `memory/maskin-prod-staging-split.md`,
`memory/finland-agent-server-deploy.md`) with deeper background — read them too.

## Mission
Make **agent session logs stream live, line-by-line, into the Maskin UI** for sessions that
run on the remote **Finland microsandbox agent-server**. Today they don't appear at all.

## Why the current design fails (root cause — already proven, do NOT re-investigate)
microsandbox **0.5.7** has a bug in its VM→host (egress) TCP proxy: it never wakes the
smoltcp poll loop after draining guest→server data (`crates/network/lib/proxy.rs`, the
guest→server branch is missing a `proxy_wake.wake()` that the host→guest branch has). Effect:
a **held-open/streaming** HTTP upload from inside the VM delivers **nothing** until the
connection closes; a short self-closing POST eventually arrives but with 6–150s latency. The
fix was applied upstream only to the INBOUND direction (#915 v0.5.5, #930 v0.5.6) — never to
egress, and it's identical in `main`. So **no msb upgrade fixes it**, and the agent-base
`agent-run.sh` HTTP `log_tee` (push logs to the agent-server) can't work for interactive
sessions. Verified empirically: zero `:3001` connections, zero ingest, zero flush.

## The Option A approach (this branch)
Stop pushing from the VM. Run the agent as the microsandbox **agentd "primary session"** and
have the HOST **pull** its stdout/stderr live via **`msb logs <sid> -f --source stdout`**
(the agentd/vsock channel, which is NOT affected by the egress bug). This mirrors the old
local-Docker `run + attach + docker logs` model.

### Proven facts (I verified these on the Finland box — build on them, don't redo)
- `msb logs <sid> -f --source stdout` (pipe mode) and `--source output` (pty `-t` mode)
  **DO capture the primary session's output, live** (~real-time, line-by-line). Confirmed.
- The "primary session" is a command run via **`msb run -- <cmd>`**. Output from the Docker
  **entrypoint** is NOT captured (goes to PTY). Output from **`msb exec -- <cmd>`** is NOT
  captured either (every probe came back empty). **So you must use `msb run -- <cmd>`, not
  `msb create` + `msb exec`.** This is the single most important finding.
- `msb run` flags: confirm it supports `-v`, `--net-rule`, `--memory`, `--cpus`, `--name`,
  `--pull`, `-d`, `-t` (check `msb run --help`). NOTE: `msb run -d -- <cmd>` IGNORES the
  command (detach mode); the command must run in attached mode.
- The `msb run` process's OWN stdout was empty in my tests — capture via `msb logs -f`, not
  the run process's stdout.
- `msb exec` does NOT inherit env set at create. For Option A with `msb run -- <cmd>`, env
  passed to `msb run -e` should reach the command (verify), OR write env to a sourced file.
- The agent-base on THIS branch is already converted: `entrypoint.sh` boots idle
  (`sleep infinity`, non-fatal chown); `agent-run.sh` sources `/agent/.session-env.sh`
  (+ legacy `.env-overflow.sh`), drops all the HTTP hacks (`resolve_*`, `log_tee`,
  `report_complete`), writes agent output to stdout, and reads interactive stdin directly.

### What you must build (apps/agent-server)
The agent-server (`apps/agent-server/src/`, runs on Finland from `/opt/maskin/apps/agent-server/dist/index.js`)
currently spawns via `msb create` (see `services/microsandbox.ts: spawnSession`,
`buildMsbCreateArgs`) and pushes logs via the VM (the `/sessions/:id/logs/ingest` endpoint in
`index.ts: monitorSession`). Rework it to:
1. **Run the agent as the primary session.** Replace/augment `msb create` with
   `msb run [--name <sid>] [-v ...] [--net-rule ...] -- bash /agent-run.sh` run as user
   `agent` (use `-u agent` if `msb run` supports it, else have agent-run.sh `su agent`; check).
   Decide create-vs-run carefully: you likely want a long-lived child process the agent-server
   owns (like local Docker `ContainerManager`). The agent's env must reach it — simplest is to
   write the full session env to `<sessionDir>/.session-env.sh` (sourceable; reuse the
   `formatOverflowEnvFile` escaping for ALL keys) so `agent-run.sh` sources it. This also
   sidesteps libkrun's `-e` ASCII/1500-char limits — you can drop `sanitizeEnvForMicroVM`/overflow.
2. **Capture logs** with `msb logs <sid> -f --source stdout` (there's already a
   `streamMsbLogs()` stub in `microsandbox.ts` using `--source all`; change to `stdout`,
   wire it into the live path) and forward each line to Maskin via the existing
   `appendRemoteSessionLogs` flush (POST `${MASKIN_BASE_URL}/api/internal/agent-servers/sessions/:id/logs`).
3. **Interactive input:** write user turns to the `msb run` child's **stdin** (mirror local
   Docker `ContainerManager.attachStdin`). Replaces the `/sessions/:id/input/stream` endpoint.
   Verify claude's `--input-format stream-json` receives turns this way.
4. **Completion:** the agent process exiting = completion (drop the `/complete` HTTP signal).
5. Adapt pause/snapshot/resume and the reconciler to the run-based model. Keep S3 workspace
   pull/push.
6. Remove the now-dead VM-facing endpoints (`/logs/ingest`, `/input/stream`, `/complete`) once
   the new path works.

## Environment & how to deploy/test (CRITICAL — read `memory/finland-agent-server-deploy.md` + `maskin-prod-staging-split.md`)
- **Finland box:** `ssh root@95.217.231.223` (Ubuntu, msb at `/root/.microsandbox/bin/msb`, v0.5.7).
  systemd service `maskin-agent-server` → `/opt/maskin/apps/agent-server/dist/index.js`,
  listens `0.0.0.0:3001`, EnvironmentFile `/opt/maskin/apps/agent-server/.env`
  (`MASKIN_BASE_URL=https://staging.maskin.sindre.ai`, `WARM_POOL_IMAGE=magnusnoeddegaard/agent-base:latest`,
  `AGENT_SERVER_SECRET`, S3 creds). agent-server-id is `ed513a06-77a9-4672-8d0a-3a32381e77d0`.
- **Test app:** `staging.maskin.sindre.ai` (Coolify app `hfifvopyo6r9p22199mz9ymt`, tracks the
  `staging` branch, own isolated Postgres, `AGENT_SERVERS=http://95.217.231.223:3001|<secret>`,
  `AGENT_BASE_IMAGE=magnusnoeddegaard/agent-base:latest`, `MASKIN_BACKEND_URL`/`FRONTEND_URL`
  set to the staging URL). PRODUCTION (`maskin.sindre.ai`) is rolled back to pre-infra and does
  NOT use Finland — do not touch it.
- **Deploying the agent-server change to Finland:** Finland runs a bundle at
  `/opt/maskin/apps/agent-server/dist/index.js` (NOT auto-deployed from this branch). Build the
  agent-server bundle (`pnpm --filter @maskin/agent-server build`), scp `dist/index.js` to
  Finland, `systemctl restart maskin-agent-server`. Or run a second instance on PORT=3002 for
  safe testing (source the .env, override PORT/MASKIN_BASE_URL). Keep prod :3001 working.
- **Deploying agent-base:** build `docker/agent-base` → push `magnusnoeddegaard/agent-base:latest`
  (the box's dockerd is logged in as `magnusnoeddegaard`; spawn does `--pull always`/warm uses
  `--pull missing`, so push to Docker Hub then restart the agent-server to re-warm). For local
  iteration build an overlay image + `docker save | msb load -t <tag>` + spawn `--pull never`.
- **Test a session:** open `staging.maskin.sindre.ai`, create a workspace, import Claude Max
  creds (Settings → Keys), start an interactive session, watch logs. Or read Finland directly:
  `msb list`, `msb logs <sid> -f --source stdout`. Check staging ingest via the Coolify app
  logs (MCP `mcp__coolify__application_logs`, app `hfifvopyo6r9p22199mz9ymt`).
- There is a `/root/streamtest/` dir on Finland with prior test scripts (emit-lines, probes) you
  can reuse/adapt.

## Gotchas
- `msb create`/exec command args contain session SECRETS (Claude OAuth, API keys) — they leak
  into `ps`/systemd transient unit names. Avoid full `ps`/`journalctl` dumps; filter. Rotate is pending.
- `--pull always` re-pulls Docker Hub and clobbers a locally `msb load`ed image — use `--pull never` for local test images.
- A bind-mount `/agent` chown can fail ("Operation not permitted") on some host filesystems — keep it non-fatal. Host session dirs under `/agent/sessions` (the prod AGENT_SESSION_ROOT) behaved correctly.
- PowerShell is the shell here; `$`, backtick inside `ssh "..."` get mangled — put remote logic in a scp'd `.sh` script (strip CRLF with `tr -d '\r'`).
- If stuck sessions show "running" in staging after you kill VMs, reconcile: POST `${MASKIN_BASE_URL}/api/internal/agent-servers/reconcile` with `{agent_server_id, sandboxes:[]}` and the bearer secret (run from Finland so the secret isn't printed).

## Success criteria
Start an **interactive** session on `staging.maskin.sindre.ai` → its logs appear in the UI
**live, line-by-line, within a few seconds**, and interactive input works. Then clean up dead
code/endpoints and the agent-base HTTP hacks. Commit to this branch; open a PR to `staging`.

## Pre-commit
`pnpm lint`, `pnpm type-check`, `pnpm test -- --run` (see `.claude/rules/pre-commit.md`).
