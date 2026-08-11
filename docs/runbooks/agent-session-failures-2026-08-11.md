# Agent session / browser failures — investigation (2026-08-11)

## Context

On 2026-08-11, multiple agent sessions in workspace `2b95807b-26f8-424c-8e35-8bee8ed57f7d` failed during a
~06:33–07:09 UTC (08:33–09:09 CEST) window. Investigation traced these through:

- **95.217.231.223** ("Finland box") — runs the `maskin-agent-server` systemd service (microsandbox/msb
  runtime, from PR #714). Confirmed via `journalctl -u maskin-agent-server` (after correcting for the box's
  `Europe/Berlin` timezone) that this **is** the real dispatch target for these sessions: it did `msb create`,
  spawned the sandbox, and for browser-required sessions attached a per-session `anko-browser-<sessionId>`
  sidecar over an SSH-relayed CDP connection.
- **46.225.131.164** (`ubuntu-sindre-backend-v1`) — the actual Coolify host for all three `sindre-ai/maskin`
  app stacks (prod `poa9z4x2sir81oldyup1zw1f`, staging `hfifvopyo6r9p22199mz9ymt`, staging-2
  `kjuf4hpe4iewkg916zznt965`). Also hosts ~260 `anko-session-*`/`anko-browser-*` containers, mostly
  historical, including a standing set of long-lived (8-week-old) `anko-browser-*` containers that were never
  torn down.
- **95.217.231.223 also runs its own separate Coolify install**, apparently unused for real deployments — its
  Traefik has zero routing rules for `maskin.io`/`maskin.sindre.ai`, and no app containers exist there. This
  is a source of confusion worth resolving on its own (not tracked as one of the 4 issues below, flagging for
  awareness).

Sessions used as primary evidence:
- `e4bebf0b-5279-479b-a22e-1043dd3b5489` (Visual Designer, non-browser-required) — logged normally for ~1 min,
  then 27 minutes of silence, then `exit code 1`.
- `4d1f3c8b-10bb-4835-9711-25ab1eeb7461` (TechBBQ Concierge, `browserRequired: true`, Brella login/recon task)
  — Maskin's own session record shows `result.exit_code: null`; msb's log shows it reported `exitCode: 1` to
  Maskin's completion endpoint.
- `24c4c621-d9d5-411b-b6dc-aab6c9d5613b` (TechBBQ Concierge, thread reply) — posted the comment: *"the browser
  session I use to reach Brella is failing to connect (server error, ECONNRESET on init)"*.

---

## Issue 1 — Log ingestion endpoint returning 400, silently dropping session log batches

**Symptom:** `maskin-agent-server` (msb, on 95.217.231.223) logs repeated:
```
"failed to POST logs to Maskin, will retry" ... "error":"Maskin log ingest responded with 400"
(after 3 attempts) "failed to POST logs to Maskin after all retries, batch dropped"
```
For session `e4bebf0b`, this fired at 06:34:11–06:34:15 UTC — exactly where that session's visible log stream
in Maskin's UI/API goes silent for the next 27 minutes before the session dies with exit code 1. The session
may not have actually been hung; its output may simply have stopped reaching Maskin.

**Also confirmed currently live** — the same `responded with 400` error was observed in msb's log tail for an
unrelated, concurrent session, well outside the incident window. This is an ongoing bug, not a one-off tied to
the incident.

**Route:** `apps/dev/src/routes/agent-server-reconcile.ts:101-164` (`sessions/:id/logs`).
**Client:** `apps/agent-server/src/index.ts:210-268` (`flushLogs()`, identical on the deployed box — no drift).

**Root cause (PLAUSIBLE, strong evidence):** the log-ingest Zod schema caps each line at
`content: z.string().max(65536)` (64KB). Coding-agent CLIs routinely emit a single NDJSON stdout line
containing a full tool result (large file read, big diff, base64 image) that exceeds 64KB with no embedded
newline — the client (`flushLogs`) batches up to 100 raw lines and sends them as one POST, so **one oversized
line fails validation for the entire batch**, all 3 retries 400, and the whole batch (up to 100 lines, not
just the offending one) gets dropped. Supporting evidence: Coolify's prod app logs show the *same session ID*
getting a mix of `200` and `400` responses interleaved over time — a systemic cause (bad auth, wrong field
name) would fail every call, not intermittently; this pattern is content-dependent. The DB column
(`session_logs.content`, `packages/db/src/schema.ts:305`) is an unbounded `text`, confirming the 64KB cap is
an arbitrary API-layer limit, not a real constraint. Also: the global `defaultHook` in
`apps/dev/src/app-factory.ts:110-122` swallows Zod validation errors into a generic 400 without logging the
actual issue — that's why nothing useful showed up in app logs when this happened.

**Suggested fix:** (1) chunk/truncate any oversized line client-side before buffering (e.g. split at ~60KB
with a `[truncated]` marker); (2) raise or remove the server-side cap, since the DB column has none; (3) make
batch validation partial-failure-tolerant instead of all-or-nothing; (4) log the Zod issue detail on 400 in
`defaultHook` so this is diagnosable from app logs alone next time.

**Status:** ROOT CAUSE IDENTIFIED (plausible, not yet confirmed against an actual captured 400 response body —
recommended next step: pull `session_logs` around a failed batch to confirm an oversized line was present).

---

## Issue 2 — ECONNRESET connecting to the browser sidecar

**Symptom:** Session `24c4c621` posted: *"the browser session I use to reach Brella is failing to connect
(server error, ECONNRESET on init)"*.

**Context from msb logs:** msb attaches a per-session browser sidecar via an SSH-relayed tunnel to a CDP
(Chrome DevTools Protocol) port inside an `anko-browser-<sessionId>` container, e.g.:
```
"ssh relay established" targetGuestPort: 9222, relayPort: ...
"browser sidecar started" cdpUrl: "http://host.microsandbox.internal:<relayPort>"
"browser sidecar attached to session"
```
The agent's Playwright MCP tooling inside the sandbox presumably connects to that `cdpUrl`. An ECONNRESET on
init suggests either: the sidecar container wasn't ready/listening yet when the agent tried to connect (race
condition), the SSH relay/tunnel dropped, or the sidecar process itself crashed before or during the
handshake.

Separately (found while investigating Issue 4's box): ~40+ historical `anko-browser-*` containers on
46.225.131.164 show `OOMKilled: true`, `ExitCode: 133`, memory capped at 512MB, `RestartPolicy: no`. That's a
real fragility, but doesn't directly explain THESE three sessions — their sidecars tore down cleanly
(~290ms each) right when the session ended, not mid-session. May or may not be related; worth checking whether
any anko-browser OOM events happened in the exact 06:33–07:09 UTC window.

**Confirmed via the session's own transcript.** The `mcp__playwright__browser_navigate` call failed with the
exact error `Error: async initializeServer: write ECONNRESET` while "retrieving websocket url from
`http://host.microsandbox.internal:42765`" — **three times**, at 07:07:13, 07:07:17, and 07:08:41 UTC (an
88-second span). During that entire window, the agent-server's own journal on `.223` shows **zero errors** for
this session's relay/sidecar — no process exits, no crash; clean teardown only fires at session end
(07:09:31). This rules out a boot-time readiness race (the host-side readiness poll in `provisionBrowserSidecar`,
`apps/agent-server/src/services/microsandbox.ts:962-966`, succeeded in ~1s — well before the failures) and a
sidecar/Chrome crash (nothing exited). It also rules out the ~40+ `OOMKilled` legacy `anko-browser-*`
containers on `.164` — those are a **different, unrelated subsystem** (`chromedp/headless-shell`, created
2026-06-15, pre-msb architecture); this session's browser sidecar was an msb-provisioned microVM on `.223`
using `browser-sidecar:latest`, never touching `.164` at all.

**Root cause (CONFIRMED symptom, PLAUSIBLE mechanism):** the connection path is session VM →
`host.microsandbox.internal:<relayPort>` (permitted via a per-session `--net-rule allow@host:tcp:<relayPort>`
baked into `msb create` args) → host loopback → SSH tunnel → `msb ssh serve` → sidecar guest → Chrome's real
CDP port. Host side stayed healthy throughout; the guest side got connection-reset mid-write, repeatedly, on
this dynamically-allocated port. This looks like an msb networking issue specific to per-session
dynamically-added net-rules not reliably persisting across a session's full lifetime (as opposed to
statically-configured ports at boot) — a comparatively new code path per comments in `microsandbox.ts`
("verified against production msb 0.5.7") that replaced an older `allow@private` grant.

**Suggested fix:** add guest-side retry/backoff around the CDP discovery GET (in the agent-base image's
Playwright MCP wrapper or entrypoint) so a transient reset doesn't fail the whole browser tool call; separately,
instrument/verify whether `allow@host:tcp:<port>` net-rules for dynamically-allocated ports actually persist
reliably on the guest NIC for a session's full duration.

**Status:** ROOT CAUSE IDENTIFIED for the symptom (confirmed via transcript + host-side log correlation); the
underlying msb networking mechanism is plausible but not confirmed via guest-side packet capture.

**Follow-up (2026-08-11, later same day) — live reproduction + two confirmed findings.**

Ran two live diagnostic sessions (`4f6d4b0b-e0be-4246-b2ab-30325cfc3e0f`, `3d4ffd65-c2b8-4909-a7b5-8b2aac592308`)
against this same workspace, each doing nothing but browser navigations. **Both reproduced the bug with a 100%
failure rate** — every single navigation attempt (4/4 and 1/1) failed with the identical
`async initializeServer: write/read ECONNRESET ... retrieving websocket url from
http://host.microsandbox.internal:<relayPort>` error, immediately, from the very first attempt. This is no
longer an intermittent/rare issue as far as this workspace's browser sessions go — it reproduces every time.

**Finding A — confirmed architectural mechanism.** Read `apps/agent-server/src/services/microsandbox.ts` in
full. The browser sidecar's CDP path depends on `--net-rule allow@host:tcp:<relayPort>`, a narrow per-port grant
that lets the session's guest VM reach a dynamically-allocated host-loopback port (the SSH-relay tunnel into the
sidecar). The code's own comment on `launchSessionExec` (line ~481) states explicitly: **"microsandbox's TCP
proxy (allow@host:tcp:PORT) is only active while an exec session is in progress — not during the VM's
create-time boot."** Both the main session and the browser sidecar rely on a fire-and-forget `spawn(msbBin,
['exec', name]).unref()` process (`launchSessionExec` / `launchSidecarExec`) to keep this proxy alive for the
whole session lifetime. For the clean repro (`4f6d4b0b`), the main session's own exec process was confirmed
still running (no exit logged) throughout all 4 failed navigation attempts — so a simple "exec process died
early" isn't the direct explanation here; the proxy's "in progress" liveness evidently isn't sufficient on its
own to guarantee traffic actually gets through to this specific dynamically-allocated port for the full session
duration. This narrows the bug to microsandbox's own `allow@host:tcp:<port>` TCP proxy implementation for
per-session dynamic ports — consistent with the "comparatively new code path... verified against production msb
0.5.7" note already in the code (replacing an older `allow@private` blanket grant). Searched the upstream
`superradcompany/microsandbox` GitHub issues (canonical repo, confirmed via `gh api`) for matching reports —
no exact match found for this scenario as of 2026-08-11; closest related issues (#1192 "allow@public not
honoured", #745 "forwarded port starves concurrent inbound connections", #914 "missing proxy_wake in inbound
relay" — already fixed pre-0.5.7) are all adjacent but not identical.

**Finding B — separate, confirmed, real bug: `docker/browser-sidecar/entrypoint.sh` is not idempotent.**
While inspecting a live sidecar mid-session (`msb exec anko-browser-3d4ffd65-c2b8-49 -- ps aux` and similar
diagnostic commands), every invocation triggered the sidecar's actual ENTRYPOINT script to run again from
scratch — `msb exec` on this image apparently re-invokes ENTRYPOINT/CMD rather than attaching to the
already-running process tree. The script (`Xvfb :99 & ... chromium --remote-debugging-port=9223 & ...
until socat ... 9223; exec socat TCP-LISTEN:9222,fork,reuseaddr TCP:127.0.0.1:9223`) has no check for
"already running" — the second invocation's Xvfb immediately fails (`Server is already active for display
99`), and the final `exec socat TCP-LISTEN:9222,...` fails with `bind ... Address already in use` since the
first invocation's socat is still holding port 9222. Because the script ends on `exec socat ...` (replacing the
shell process) under `set -e`, this failure very plausibly tears down or corrupts the live CDP forwarding path
for whichever client was connected at that moment — a directly plausible mechanism for spontaneous ECONNRESET,
separate from (but compounding) Finding A. This specific trigger (repeated `msb exec` into an already-booted
sidecar) does not appear to be part of the normal production code path today — `launchSidecarExec` is called
exactly once per sidecar — but it's a real landmine: any future code path, retry logic, or manual debugging
that calls `msb exec` into an already-running sidecar a second time will reproduce this immediately and
deterministically.

**Suggested fix for Finding B (safe, well-scoped, ready to implement):** make `entrypoint.sh` idempotent —
check whether Xvfb/chromium/socat are already running (e.g. a lock file, or checking whether port 9222 is
already bound) before attempting to (re)start them; if already running, exit 0 (or block/sleep) instead of
racing the existing processes.

**Suggested fix for Finding A (needs more investigation before implementing):** no safe, confident code fix
yet — the exact condition under which microsandbox's exec-gated TCP proxy stops forwarding traffic for an
already-established dynamic port isn't pinned down. Reasonable next steps: (1) file/search more specifically
upstream once a minimal non-Maskin repro is built, (2) add retry/backoff on the Playwright CDP discovery call
as a mitigation band-aid regardless of root cause, (3) instrument `provisionBrowserSidecar`/`startSshRelay`
with periodic post-attach health checks (not just the one-time readiness poll) to see whether the tunnel
degrades over time versus being broken from the very first real connection attempt.

**Status:** Finding A — mechanism narrowed to microsandbox's own exec-gated TCP proxy for dynamic
`allow@host:tcp:<port>` rules; exact trigger condition still OPEN. Finding B — ROOT CAUSE CONFIRMED via direct
reproduction, fix is straightforward, not yet implemented.

**Follow-up (2026-08-11, later still) — Finding B fixed and verified; Finding A narrowed further with a clean
minimal repro that rules out microsandbox's core relay mechanism entirely.**

*Finding B fix, implemented and verified.* `docker/browser-sidecar/entrypoint.sh` now checks whether something
is already listening on `127.0.0.1:9222` (via `socat /dev/null TCP:127.0.0.1:9222`) before attempting to start
Xvfb/Chromium/socat; if so, it blocks (`exec sleep infinity`) instead of racing the already-running instance.
Verified locally: built the image, started one instance, confirmed CDP reachable, then manually re-invoked the
entrypoint against the same running container (`docker exec <container> /entrypoint.sh`) — the second invocation
correctly detected the running instance, printed the guard message, and blocked; the original instance's CDP
port remained reachable throughout, confirming the crash this fix prevents no longer occurs.

*Finding A — built a minimal, Maskin-code-free reproduction of the exact production mechanism, directly on
95.217.231.223, using nothing but raw `msb` CLI commands and generic `alpine` images (no Maskin orchestration
code involved at all):*
1. A generic `alpine` sandbox (`repro-test2`) with a loop listener (`nc -l -p 9222`) standing in for the
   browser sidecar.
2. `msb ssh serve repro-test2 --host 127.0.0.1 --port <sshPort>` + `ssh -N -L 127.0.0.1:<relayPort>:127.0.0.1:9222
   -p <sshPort> -i <the real production relay key> ...` — the exact command construction `startSshRelay()` uses,
   reproduced by hand.
3. A second generic `alpine` sandbox (`repro-client`) with `--net-rule allow@host:tcp:<relayPort>`, standing in
   for the session VM, running `nc host.microsandbox.internal <relayPort>` — the exact connection pattern the
   session's Playwright MCP uses.

**Result: it worked cleanly on the first attempt, no reset, full response received.** This is a clean, decisive
negative result — the raw `allow@host:tcp:<port>` mechanism, the SSH-relay-tunnel construction, and guest-to-guest
communication via the host relay **all work correctly** when reproduced exactly as Maskin's own code constructs
them, with no Maskin orchestration code in the loop at all. This rules out a generic bug in microsandbox's core
proxy/relay implementation as the explanation.

**This redirects Finding A's open question**: since the mechanism itself is sound in isolation, the real trigger
must be something specific to actual production conditions that this minimal repro didn't include — most likely
candidates, roughly in order of suspicion:
- **Concurrent load**: while running this repro, `msb list` showed 6+ real production sessions and their browser
  sidecars actively running on the same box at the same time (confirmed timestamps 12:25–12:32 UTC alongside the
  repro). The minimal repro was the only thing running when it succeeded. Worth testing whether failures
  correlate with how many concurrent `browserRequired` sessions are active at once (CPU steal, msb's own
  internal connection/resource limits, or contention in the relay/tunnel machinery under real concurrency).
- **Real Chromium/socat behavior under actual use**: the repro's stand-in listener was a trivial `nc` loop
  handling one plain request at a time — not real Chromium serving genuine CDP traffic (WebSocket upgrade,
  concurrent connections via socat's `fork` option, actual page-load-driven traffic volume). The failure could be
  specific to Chromium/socat's behavior under real load that a toy listener doesn't exercise.
- **The main session's own resource usage**: the real session VM is busy running the full Claude Code CLI loop
  (heavy CPU/memory/I/O) while making the CDP connection attempt, unlike the idle `repro-client` sandbox.

**Suggested next step**: since a clean isolated repro didn't reproduce the bug, the next productive step is
reproducing it *with realistic concurrent load* — e.g., run several simultaneous `browserRequired` diagnostic
sessions (matching the earlier live repro pattern) and see if the failure rate changes with concurrency, or
instrument `provisionBrowserSidecar`/`startSshRelay` with timing/resource metrics during a real failure to
directly observe what's different about the failing condition.

**Status:** Finding B — FIXED and verified (built, tested double-invocation collision, confirmed resolved).
Finding A — microsandbox's core relay mechanism CLEARED via clean minimal repro; real trigger condition still
OPEN, now narrowed to concurrency/real-load conditions rather than the relay mechanism itself.

---

## Issue 3 — Inconsistent exit code between msb's own log and Maskin's stored session record

**Symptom:** For session `4d1f3c8b`:
- Maskin's `get_session` API shows `result.exit_code: null`.
- msb's own log shows: `"completion signal received", sessionId: 4d1f3c8b..., exitCode: 0` (inner agent signal),
  then `"msb exec process exited", code: 1`, then `"session completion reported to Maskin", exitCode: 1`.

So msb believes it reported `exitCode: 1` to Maskin's completion endpoint, but Maskin's stored record shows
`null`. Either the completion POST didn't actually persist the exit code correctly, or there's a race/second
write that clobbers it, or the `/complete` handler has a bug in how it maps msb's payload to the stored
`sessions.result` field.

**Suspected area:** `POST /api/internal/agent-servers/sessions/:id/complete` handler in `apps/dev`.

**Route/storage:** `apps/dev/src/routes/agent-server-reconcile.ts:166-222` (`sessionCompleteBodySchema`, `exitCode: z.number().int().nullable().default(null)`) calls `sessionManager.markRemoteSessionComplete(id, exitCode)` (`apps/dev/src/services/session-manager.ts:3149-3354`). That function does a compare-and-swap `UPDATE ... WHERE id = sessionId AND status NOT IN (<terminal statuses>)`; if the session is already terminal, 0 rows match and it **silently no-ops** (`if (!updated) return`, line 3297) — no error, no log.

**Root cause (CONFIRMED — race condition):** there are only two callers of `markRemoteSessionComplete` in the codebase. Besides the route above, `stopSession()` (`session-manager.ts:698-765`) — after calling the agent-server's `/sessions/:id/stop` — **unconditionally** calls `markRemoteSessionComplete(sessionId, null)` (line 764), treating an explicit stop as authoritative regardless of what actually happened. For `4d1f3c8b`, the stored session's own terminal log literally reads **"Session failed with exit code null"**, written from that same code path (line 3331) — proof the `null` call from `stopSession()` won the race. `completedAt` and that log line are ~250ms apart — one call, not two. The genuine `/complete` POST carrying `exitCode: 1` arrived *after* the session was already marked `failed`, matched 0 rows in the CAS update, and silently no-op'd — exactly the "msb sent 1, DB has null" gap. (No `stop_session` MCP call appears in the agent's own tool-call transcript, so something in Maskin issued the stop concurrently with the agent's natural exit — not the agent stopping itself.)

**On the inner-0-vs-outer-1 mismatch (secondary, PLAUSIBLE):** these are two *different* values, not the same "1" twice. In `apps/agent-server/src/index.ts:282-350`, the reported `exitCode` starts at the completion-signal value (0 here) but gets force-bumped to 1 (line 304) if `pushSessionWorkspace()` fails after retries. Separately, `"msb exec process exited...code:1"` (`microsandbox.ts:500`) is the unix exit code of the fire-and-forget `msb exec` CLI wrapper itself — unrelated to the app-level `exitCode` variable, and plausibly a side effect of the forced `msb stop` from the `/stop` handler tearing the exec session down mid-flight.

**Suggested fix:** in `stopSession()`, don't unconditionally write `null` — fetch the agent-server's actual last-known exit code (or briefly wait for it) before writing, or at minimum use a distinguishable sentinel so "explicitly stopped" isn't indistinguishable from "we never got an exit code." Also check `res.ok` on the completion-report `fetch` in `agent-server/src/index.ts` (currently unchecked) so a rejected POST triggers a retry instead of silently logging false success.

**Status:** ROOT CAUSE IDENTIFIED (confirmed for the null-vs-1 race; plausible for the inner/outer exit-code mismatch).

---

## Issue 4 — "agent-base" container present and crashing on the Coolify prod box (46.225.131.164), when session execution should be delegated entirely to the remote agent-server (95.217.231.223)

**Symptom:** User observed in Coolify's UI that an "agent-server"-looking container had disappeared/crashed on
the production app stack (46.225.131.164), redeployed to fix it. Per the architecture (`AGENT_SERVERS` env var
on the prod app points at 95.217.231.223's msb service), session execution should be fully delegated to the
remote agent-server — the prod app itself shouldn't need its own local agent-execution container.

**Evidence found:** `docker ps -a` on 46.225.131.164 shows a container `agent-base-poa9z4x2sir81oldyup1zw1f-*`
(image `agent-base:latest`), created fresh at every deploy of the prod app (same timestamp as the
`app-`/`postgres-`/`seaweedfs-` containers in that docker-compose stack), and it exits with code 0 shortly
after each deploy — looks like a one-shot job (image warmup/pull?) rather than a long-running service, but
its presence in the compose stack at all is the open question given `AGENT_SERVERS` should mean the prod app
doesn't run sessions locally.

**To investigate:** find this service's definition in `docker-compose.prod.yml` (or wherever it's defined),
determine what it's actually for (legacy fallback from before the msb migration? intentional local warm image
pull? dead weight?), and whether its exit/restart behavior is what the user saw as "crashed."

**Definition:** `docker-compose.prod.yml:28-33` (repo root) — a one-shot service, `entrypoint: ["echo", "agent-base image built"]`, `restart: "no"`, that builds `docker/agent-base` into the local image cache. `app` has `depends_on: agent-base: condition: service_completed_successfully` (`docker-compose.prod.yml:68-72`) — it's a build-gate, not a persistent service. Confirmed live via `docker inspect`/`docker logs` on `.164`: runs 0.28s, exits 0, prints "agent-base image built" — exactly matching what's in compose.

**Root cause (CONFIRMED code path, PLAUSIBLE explanation for what the user saw):** this is legacy scaffolding from commit `f08d4692` ("fixes", 2026-03-27) — **before** the remote agent-server/msb architecture (PR #714) existed. Its only real consumer, `SessionManager.launchContainer()` (`apps/dev/src/services/session-manager.ts:1708`), is explicitly commented **"Local-dev only — production goes through the dispatch queue to apps/agent-server."** In `apps/dev/src/index.ts:132-155`, when `NODE_ENV === 'production'`, all session starts route through `SessionDispatchQueue` to the remote `.223` box — `launchContainer()`, and therefore this locally-built `agent-base:latest` image, is **never invoked in production**. This container is rebuilt on every single prod deploy but is functionally dead weight — it just gates app startup and warms an image nothing uses.

Most likely explanation for what was seen: Coolify's dashboard lists every container in the stack, and `agent-base` — near-identical name to "agent-server," normally sitting in a transient "Exited" state by design, immediately after every deploy — is a very plausible source of the "agent-server disappeared/crashed" read. The real agent-server (the systemd service on `.223`) was, per Issues 1-3 above, healthy and actively processing sessions the entire time.

**Suggested fix:** rename the service (e.g. `agent-base-build`) and add a compose comment clarifying it's an intentional one-shot warm/gate step — cheap fix for the naming confusion alone. Consider removing it entirely, since production never uses the image it builds.

**Status:** ROOT CAUSE IDENTIFIED (confirmed via compose file + live container inspection; the "this is what looked like a crash" read is plausible but not independently verified against what was actually shown in the Coolify UI at the time).

**Follow-up (2026-08-11, later same day) — user pushed back with a sharper observation:** the container doesn't just sit there in an "Exited" state — it periodically *disappears entirely* from Coolify's container list, requiring a redeploy to bring it back. None of the other 3 containers in the same stack (`app`, `postgres`, `seaweedfs`) ever do this.

**New finding — CONFIRMED root mechanism, PLAUSIBLE as the specific explanation:** Coolify runs its own scheduled `App\Jobs\DockerCleanupJob` every night at **00:00 UTC** (confirmed via `docker logs coolify`, visible identically on 2026-08-09, 08-10, and 08-11 — this is the `docker_cleanup_frequency: "0 0 * * *"` / `force_docker_cleanup: true` setting on the server). On 2026-08-11 this job ran **anomalously long — 62 seconds**, versus 13s (08-10) and 10s (08-09). During that exact window, `dockerd`'s own log shows precisely **one** container-deletion event (`00:01:06 UTC`, right at the job's tail end) — isolated, not part of any deploy cluster (deploy-related deletions come in clusters of 3-4 events close together, matching the 3-4 containers replaced per deploy; this one stood alone).

`agent-base` is the **only** container in this stack with `restart: "no"` that sits permanently stopped after building — `app`/`postgres`/`seaweedfs` are always "Up" and would never be a candidate for a stopped-container prune. This lines up as the most likely explanation: Coolify's nightly cleanup is reaping the stopped `agent-base` container specifically because it's the only stopped thing in the stack, while a fresh `docker compose up` (i.e. the next deploy) recreates it, making it "reappear."

**Not fully proven at the exact-command level** — Coolify's Horizon queue log only shows job timing (`RUNNING`/`...DONE`), not the literal remote command it executed; no `laravel.log` exists in the container to check, and the audit log has no matching entries (background jobs don't appear to write there). The timing correlation across 3 consecutive nights and the "only-ever-stopped-container" argument are strong circumstantial evidence, not a captured smoking-gun command.

**Suggested fix:** the cleanest fix is unrelated to proving the exact mechanism — since `agent-base` is confirmed dead weight (Issue 4 original finding: production never uses the image it builds), either (a) remove the service from `docker-compose.prod.yml` entirely, or (b) if it must stay for some reason not yet identified, give it `restart: "no"` → keep as-is but this is exactly what makes it prunable, so if the disappearing-container behavior itself is undesirable (vs. just confusing), consider changing its entrypoint to `sleep infinity` after the build step so it stays "Up" and stops being a cleanup target — though removing it outright is simpler and avoids wasting resources on a container that does nothing.

**Status:** ROOT MECHANISM IDENTIFIED (Coolify's nightly `DockerCleanupJob`, confirmed running); specific attribution to `agent-base` is well-evidenced but not 100% proven at the command level.

---

## Next steps

All four issues have identified (confirmed or well-evidenced) root causes as of this investigation — see
each issue's "Status" above. None have been fixed yet; this doc is diagnosis only. Suggested priority:

1. **Issue 3 (exit-code race)** — genuine data-integrity bug (silently corrupts session records), fix is small
   and localized (`stopSession()` in `session-manager.ts`).
2. **Issue 1 (log-ingest 400s)** — actively ongoing (observed live outside the incident window), actively
   destroys observability into session behavior, fix is small and localized.
3. **Issue 4 (agent-base naming/dead weight)** — cheap rename+comment fix, resolves the recurring "is the
   agent-server down?" false alarm.
4. **Issue 2 (ECONNRESET on browser sidecar)** — real user-facing failure, but the underlying mechanism
   (msb per-session dynamic net-rule reliability) needs more investigation before a confident fix — start with
   guest-side retry/backoff as a mitigation while the deeper msb networking question is chased separately.
