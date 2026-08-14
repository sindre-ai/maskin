# Browser CDP sidecar — root cause of the WebSocket 500 and why the sidecar avoids it

Before this bet, agent sessions with the `bet_qa_required` flag tried to drive a
browser through `@playwright/mcp` running **inside** the session container.
Every attempt surfaced the same failure to the agent:

> Browser unavailable this session (Playwright WebSocket 500 error — infrastructure issue).

Two independent reports in `#customer-feedback` on 2026-06-25 confirmed the
pattern across different session types (general verification, design agent).
The insight `Agents cannot use Playwright browser for verification (WebSocket
500 error)` (`b0fd0e54-38c1-4aee-b4fb-6ba9a7b5fe6d`) captured it and informed
this bet.

## Root cause of the original 500

Playwright launched a Chromium instance inside the session microVM and opened
a CDP WebSocket against `http://<host>:<port>/devtools/browser/<id>`. Two
container-shaped constraints made that handshake fail:

1. **Chromium's DevTools endpoint rejects non-IP `Host` headers.** As a DNS
   rebinding defence, Chromium only accepts a CDP WebSocket upgrade when the
   `Host` header is an IP literal or `localhost`. When Playwright resolved a
   container/service hostname and passed it through, the DevTools handler
   returned `HTTP/1.1 500` on the upgrade request. The dev-path implementation
   still carries the load-bearing note for the same class of bug:
   `apps/dev/src/services/session-manager.ts:2148` — *"Chrome's CDP rejects
   Host headers that are hostnames, but accepts IP addresses and localhost."*
2. **No dedicated browser process to talk to.** The session container did not
   package Chromium and its runtime dependencies (Xvfb, socat, the shared
   libraries a headed browser needs), so any process Playwright did launch
   died before the CDP endpoint bound. `agent-run.sh` today explicitly refuses
   to fall back to a local Chrome launch when `${BROWSER_CDP_URL}` is unset —
   the pre-bet behaviour was the reverse.

Both are properties of running the browser *inside* the session container.
Nothing short of extracting the browser could fix them.

## Why the CDP sidecar avoids the failure by architecture

The bet lifts Chromium out of the session container into a purpose-built
sidecar and hands the session a URL that already satisfies Chromium's Host
check. The same shape holds on both provisioning paths.

### Local Docker path (T1, `apps/dev/src/services/session-manager.ts`)

`provisionBrowserSidecar` creates a per-session Docker network, runs the
`browser-sidecar` image on it, and reads the **container IP** on that network
via `containers.getIpOnNetwork`. That IP is what the session receives as
`BROWSER_CDP_URL=http://<browserIp>:9222` (`session-manager.ts:1210`). Because
it is a literal IP the Chromium `Host` check passes on the first upgrade.

### Production microsandbox path (T2, `apps/agent-server/src/services/microsandbox.ts`)

`provisionBrowserSidecar` allocates a free host TCP port on the msb bridge
gateway (default `10.0.1.1`), maps it into the sidecar VM with
`-p <bridgeGateway>:<hostPort>:9222`, fires `msb exec` to start
Xvfb + Chromium + socat, then polls `http://<bridgeGateway>:<hostPort>/json/version`
until CDP responds. The session VM gets `--net-rule allow@private` so it can
reach the bridge address, and receives
`BROWSER_CDP_URL=ws://<bridgeGateway>:<hostPort>` — again an IP literal, so
the Chromium `Host` check passes. See
`apps/agent-server/src/services/microsandbox.ts:475-660` for the current
implementation.

### The shared shape

- The browser lives in its own container/microVM sized for Chromium
  (`BROWSER_SIDECAR_MEMORY_MIB = 1536`), not the smaller session budget.
- The CDP endpoint is addressed by IP on every path — no hostname is ever
  presented to Chromium's DevTools upgrade handler.
- Playwright never launches Chrome in-container: `@playwright/mcp` runs with
  `--cdp-endpoint ${BROWSER_CDP_URL}` (see `docker/agent-base/agent-run.sh`).
  When `BROWSER_CDP_URL` is unset, the MCP entry is stripped rather than
  silently reverting to the old failing path.
- Sessions without `bet_qa_required` get no sidecar, no `BROWSER_CDP_URL`,
  and no Playwright MCP — nothing to fail (AC-T6).

## Follow-up bugs already fixed on the bet branch

Two bugs that would have kept the sidecar CDP unreachable on the msb path
were caught during shakeout and fixed in PR #890:

- `msb create` boots the microVM but does not run ENTRYPOINT/CMD; the code
  now fires `msb exec` to start the entrypoint (Xvfb + Chromium + socat).
- msb 0.5.7 returned `"ipv4_address": null` in `msb inspect`, so the earlier
  "reachable bridge IP" strategy always failed. The code now uses the
  bridge-gateway host-port-forward pattern above and polls
  `/json/version` for readiness.

## Validation

- **T4 re-run, 2026-08-12** (bet `Spec-to-shipped conformance…`): with the
  sidecar restored, `bet-qa` completed against `maskin.io` at 375×667 Chromium
  — hero, mobile nav, try-it form and pricing all rendered; no defects.
  Recorded on that bet as *"mechanism works when sidecar is up; original
  finding was an infra incident, not structural"*.
- CI: `browser-access-tests` matrix (`.github/workflows/ci.yml`, commits
  `8ea15db`, `20c9729`) runs the sidecar integration tests on both Docker and
  microsandbox legs. T7's CI matrix covers AC-T1–T5.

## Verdict

The WebSocket 500 failure mode is a property of trying to drive Playwright
against a same-container Chromium reached by hostname. The CDP-attached
sidecar (T1 Docker path, T2 microsandbox path) closes that failure by
architecture: separate container/microVM for Chromium, sized for it, with an
IP-addressed CDP endpoint that satisfies Chromium's Host check and no
in-container browser launch path left to regress into.
