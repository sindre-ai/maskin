---
title: MCP protocol eras and conformance
slug: mcp-conformance
description: How the Maskin MCP endpoint serves legacy (2025-era) and modern (2026-07-28) clients, the MASKIN_MCP_MODERN flag, the deprecation timeline, and the conformance matrix that guards all of it.
last_updated: 2026-10-17
---

# MCP protocol eras and conformance

> Generated from `packages/mcp/src/__tests__/conformance/` by `pnpm --filter @maskin/mcp conformance:docs`. Do not edit by hand: change a row in `rows.ts` or the prose in `docs-content.ts`, then regenerate.

The Maskin MCP server at `POST /mcp` speaks two protocol eras from one URL:

- **Legacy (2025-era)**: the `initialize` handshake. Every client in use today speaks it, including the Claude Code version baked into the agent image.
- **Modern (2026-07-28)**: `server/discover`, a per-request `_meta` envelope, and the `MCP-Protocol-Version`, `Mcp-Method` and `Mcp-Name` headers. Served only when the `MASKIN_MCP_MODERN` flag is on.

A conformance matrix runs one table of cases against one running app with five kinds of client, in CI, so a gap between the two eras shows up before users see it.

## Client modes

The SDK v2 client picks its era from its negotiation mode. The table says what each mode does against this server.

| Mode | What the client does | Result against this server |
| --- | --- | --- |
| Default (legacy) | No option set. The client sends `initialize` exactly like a 2025 client. | Legacy era, always. Works with the flag on or off. |
| `auto` | The client probes with `server/discover` first and falls back to `initialize` unless the answer is definitely modern. | Modern era when the flag is on, legacy era when it is off. Safe to ship before the flag flips. |
| Pinned to `2026-07-28` | The client requires the modern era and does not fall back. | Modern era when the flag is on. With the flag off, connecting fails with a clear error. |
| No SDK (raw JSON-RPC) | A client that writes its own requests. Legacy clients send `initialize`; modern ones must send the required headers and the `_meta` envelope. | Same rules as above. The matrix replays recorded v1 requests to prove legacy answers did not change. |

## The MASKIN_MCP_MODERN flag

- Values: `off` or `on`. Read once at boot, so changing it needs a restart of `apps/dev`. There is no hot toggle.
- **Off (the first release default)**: the server serves legacy clients only. A modern request never gets a modern answer.
- **On**: modern requests are served by the SDK's modern handler. Legacy requests are unaffected.
- Plan: turn it on per environment after the soak, make `on` the default after one clean 14-day window, and keep the flag until the legacy deprecation decision below is made.
- Rolling back modern support is a flag flip plus a restart. It does not roll back the SDK upgrade itself; that is a redeploy of the previous image.

The flag has to be listed in the app environment block of `docker-compose.prod.yml` to reach the container.

## Deprecation timeline

Legacy support is documented, not enforced. Nothing in the server stops serving legacy clients at any of these points, and there is no sunset date.

| When | What |
| --- | --- |
| Month 0 | The modern leg is on in production (`MASKIN_MCP_MODERN` on). The date is added to the changelog below when this happens. |
| Months 0 to 12 | Legacy is fully supported. This is the minimum, the 12 months the spec gives legacy clients. |
| Month 9 | Review point. Look at how much traffic is still legacy (the `mcp_era` label on analytics events) and decide whether to plan a sunset. The review can conclude "keep supporting legacy". |
| After month 12 | Legacy may be deprecated, but only through a new decision with a date announced here first. Until then legacy keeps working. |

## Changelog

### Unreleased: dual-era MCP endpoint

- The MCP server moves to TypeScript SDK v2. Legacy clients see no change: same tools in the same order, same status codes, JSON responses stay `application/json`, still stateless (no MCP session id).
- Added the modern (2026-07-28) leg behind `MASKIN_MCP_MODERN`, default off.
- Modern `tools/list` and `server/discover` carry a 5 minute private cache hint (`ttlMs` 300000, `cacheScope` private). `tools/list` is deterministic and byte-identical across calls and restarts.
- Added an Origin check in report-only mode: it never rejects during the report-only phase.
- Added the conformance matrix (this page) and a CI job that runs it against the built server.
- Known wording change for legacy clients: with the new SDK, argument-validation errors can lose their `MCP error -32602:` prefix (the modern leg already does). The text still says `Invalid arguments for tool <name>`.

## Client styles in the matrix

| Style | What it is |
| --- | --- |
| raw legacy | Raw legacy JSON-RPC (fixtures recorded from v1 main) |
| SDK legacy | SDK v2 Client, default (legacy) mode |
| SDK auto | SDK v2 Client, mode auto |
| SDK modern | SDK v2 Client, pinned to 2026-07-28 |
| raw modern | Raw modern JSON-RPC, no SDK |

## The conformance matrix

28 rows. Each row is one behaviour of `/mcp`, run against every client style listed for it.

### Handshake

| Row | What a pass guarantees | Client styles | Needs |
| --- | --- | --- | --- |
| `handshake`: Connect and agree a protocol era | Legacy clients get the 2025-era handshake, pinned modern clients get 2026-07-28, and a client in auto mode lands in whichever era the server offers. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `discover`: server/discover returns the capability manifest | A modern client can ask what the server supports and gets 2026-07-28, honest capabilities (no change notifications we never send) and a complete result. | raw modern | modern leg (flag on) |
| `modern-refused-when-flag-off`: Flag off: modern requests are refused, legacy keeps working | With MASKIN_MCP_MODERN off, a modern request never gets a modern answer, a pinned modern client cannot connect, auto falls back to legacy, and legacy clients are unaffected. | raw modern, SDK modern, SDK auto, raw legacy | flag off |

### Tools

| Row | What a pass guarantees | Client styles | Needs |
| --- | --- | --- | --- |
| `tools-list`: tools/list returns the same tools, in the same order, as v1 | Every client style sees exactly the tool list recorded from v1 main (names and order), and the raw styles also match every description, annotation and input schema (the schema dialect URI is the one allowed difference). | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `tools-list-stable`: tools/list is byte-identical across calls and restarts | Calling tools/list twice returns the same bytes, and a later run against a restarted server returns the same digest, so no tool description is built from runtime data. | raw legacy, raw modern | modern leg (flag on) |
| `tools-list-legacy-clean`: Legacy responses carry no modern fields | A legacy tools/list result has no cache hints, no resultType and no server info envelope, so a 2025-era client never sees a field it does not know. | raw legacy | - |
| `tools-list-cache-hints`: Modern tools/list and server/discover carry a 5 minute private cache hint | Modern clients are told they may cache the tool list for 5 minutes (ttlMs 300000) for this caller only (cacheScope private). | raw modern | cache hints, modern leg (flag on) |
| `tools-call-ok`: tools/call runs a tool | A normal tool call succeeds and returns the tool output for the right workspace. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `tools-call-bad-arguments`: Bad arguments come back as a tool error naming the tool | A call with an argument of the wrong type returns an error result (not a crash) that says which tool and that the arguments were invalid. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `tools-call-unknown-tool`: An unknown tool is reported as not found | Calling a tool that does not exist fails with an error that names the tool and says it was not found (invalid params, -32602, when it comes back as a protocol error). | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `oversize-response-cap`: Oversize list responses are trimmed and say how to fetch the rest | When a list result would exceed the response token cap, rows are dropped from the tail, the result is marked truncated and points at get_objects for the omitted rows. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | lowered response cap, modern leg (flag on) |

### Resources

| Row | What a pass guarantees | Client styles | Needs |
| --- | --- | --- | --- |
| `resources-list`: resources/list includes the ui:// app views | The rich-view resources are listed with the MCP app mime type. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `resources-templates`: resources/templates/list returns the object, actor and trigger templates | The three link templates clients use to open Maskin objects are listed. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `resources-read-ui`: A ui:// resource reads back as HTML with the app mime type | Reading ui://maskin/objects returns an HTML document with the MCP app mime type. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |

### Transport

| Row | What a pass guarantees | Client styles | Needs |
| --- | --- | --- | --- |
| `get-delete-405`: GET and DELETE are refused with 405 | The server opens no server-to-client stream and keeps no session to delete, so GET and DELETE answer 405 "Method Not Allowed" without touching the database. | raw legacy, raw modern | modern leg (flag on) |
| `origin-check`: Origin: allowed, denied and absent are all served (report-only) | During the report-only phase the Origin check logs but never rejects: an allowed origin, an unknown origin and no Origin at all all get a normal answer. Switching to enforcement changes the denied case and this row. | raw legacy, raw modern | modern leg (flag on) |
| `modern-header-checks`: Modern requests: missing or mismatched headers are rejected | A modern request whose Mcp-Method or Mcp-Name header is absent or disagrees with the body is refused with -32020, and one that claims a version in the header but sends no envelope is refused with -32602. | raw modern | modern leg (flag on) |
| `unsupported-version`: An unsupported protocol version is refused with the supported list | A request claiming a protocol version the server does not speak gets -32022 and a list of the versions it does speak, so a client can correct itself. | raw modern | modern leg (flag on) |
| `notification-ack`: Notifications are acknowledged with an empty 202 | A notification (no id) gets 202 and no body, in both eras. | raw legacy, raw modern | modern leg (flag on) |
| `batch-array-legacy`: Legacy JSON-RPC batches are answered with an array, in order | A legacy client that sends several requests in one POST gets one array back, matched by id. | raw legacy | - |
| `malformed-json`: A body that is not JSON gets the same 400 in both eras | Malformed JSON is refused before the era is decided, with the same 400 BAD_REQUEST answer for every client. | raw legacy, raw modern | modern leg (flag on) |
| `missing-authorization`: No Authorization header: current behaviour, pinned | Today the endpoint itself does not require a key: the handshake and tools/list work, and a tool call comes back as a tool-level "Not authenticated" message. This row pins that so changing it (the OAuth work) is a deliberate edit. | raw legacy, SDK legacy, SDK auto, SDK modern, raw modern | modern leg (flag on) |
| `legacy-json-content-type`: Legacy responses stay application/json | Even when a legacy client says it accepts event streams, its answers are plain JSON, never an event stream. | raw legacy | - |
| `stateless-contract`: The server is stateless: no session id minted or echoed | No response carries an MCP session id (even when the client sends one), each POST is served by a fresh server (a second initialize is fine, and tools/list works with no handshake first), so nothing is held per connection. | raw legacy, raw modern | modern leg (flag on) |

### Compatibility

| Row | What a pass guarantees | Client styles | Needs |
| --- | --- | --- | --- |
| `legacy-exact-replay`: Recorded v1 requests get the same status, content type and body | A fixed set of legacy requests (handshake, notification, ping, unknown tool, bad arguments, no key, batch, GET, DELETE, malformed JSON) is replayed and the answers match what v1 main sent, byte for byte after JSON parsing. | raw legacy | - |
| `era-parity-tools-list`: Era parity: modern tools/list matches legacy | A modern client and a legacy client see identical tool definitions in identical order (only the schema dialect URI may differ). | raw modern | modern leg (flag on) |
| `era-parity-tool-call`: Era parity: the same tool call gives the same answer | The same call made by a legacy and a modern client returns the same text. | SDK modern, raw modern | modern leg (flag on) |
| `era-parity-resources`: Era parity: resources match | Both eras list the same resources and templates. | SDK modern, raw modern | modern leg (flag on) |

## Running the matrix

- **In-process** (what the `integration-tests` job runs): `apps/dev/src/__tests__/integration/mcp-conformance.test.ts` serves the real app on a local port with a real database and runs every row.
- **Against a built server** (what the `mcp-conformance` job runs): start the built server, then
  `pnpm --filter @maskin/mcp conformance --base-url http://localhost:3000 --api-key <key> --workspace-id <id> --flag on`
- **Regenerate this page** after editing a row: `pnpm --filter @maskin/mcp conformance:docs`. CI fails if the committed page is out of date.

A row reports **pending** when the server does not have a feature it needs yet (for example the modern leg) and **n/a** when the run is for a different flag state. In CI, pending counts as a failure, so a feature that never lands cannot hide.

Recorded legacy fixtures live in `packages/mcp/src/__tests__/conformance/fixtures/`. Re-record them only from a checkout of v1 main (`record-legacy.ts`), never from the upgraded server, or the upgrade stops being held to what v1 did.
