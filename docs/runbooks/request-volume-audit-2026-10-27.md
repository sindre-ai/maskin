# Request volume audit — who calls what, and why (2026-10-27)

Written after the 2026-10-27 database overload, when the Cloudflare Worker request counts looked
far higher than the team size justified. This is a read-only audit: it lists every timer-driven and
event-driven refetch in the web app and the iOS app, with the measured traffic next to it. It
changes no code.

## What the Worker logs showed (last 7 days, `maskin.io`)

| Endpoint | Client (`x-client-source`) | Requests | From the busiest IP |
|---|---|---|---|
| `GET /api/sessions/:id` | `ui` | 56,183 | 41,402 (74%) |
| `GET /api/actors?limit=100&offset=0` | `ios` | 40,875 | 28,032 (69%) |
| `GET /api/sessions?verbose=true&conversation_id=…` | `ui` | 35,910 | 18,262 (51%) |

The busiest IP is an ordinary Danish ISP customer line, not a hosting provider. In
7 days it made about 284k requests: 182k from one desktop Chrome and 102k from the iOS app (nine app
builds across iOS 27.0 and 27.2, so several devices or installs). That is about 0.5 requests a
second on average and about 1.5 a second in working hours. Traffic is quiet at night and busy in
working hours, so this is people using the app, not a bot.

`POST /mcp` (27k) comes from agents, not from either UI.

**The volume is not the problem on its own.** A properly sized API handles hundreds of requests a
second. What hurt was the cost of each request and the background scans (see PR #2592, "Stop
the session self-heal scan re-probing 7 days of sessions every minute"). The concern that matters is that the
request count grows linearly with devices and open tabs, and most of it re-reads data that has not
changed.

## Timer-driven polls

| Surface | Interval | Where | Notes |
|---|---|---|---|
| Web: chat session list (`GET /api/sessions?verbose=true&conversation_id=`) | 5s while a session is active, 30s idle, per open chat | `apps/web/src/hooks/use-sessions.ts:21-22,199` | A floor under SSE, added after a dropped connection froze a transcript. |
| Web: session activity logs (`GET /api/sessions/:id/logs`) | 2s active, 5s idle, per visible session | `apps/web/src/hooks/use-session-activity-logs.ts:44-51,201` | The comment there says this is the single largest source and that the server's `GET /api/sessions/:id/logs/stream` has no frontend consumer. Wiring it up is named as "the real fix". |
| Web: raw session logs | 3s while live | `use-sessions.ts:251,316` | |
| Web: desktop status | 15s | `hooks/use-desktop.ts:29` | |
| Web: extensions, imports, relaunch progress | 5s / 15s / 2s, only while waiting | `use-extensions.ts`, `use-imports.ts`, `use-relaunch-progress.ts` | Bounded by a waiting state. |

## Event-driven refetches

Every server event reaches every connected client. The event carries ids only, so the client
refetches.

### Web (`apps/web/src/lib/sse-invalidation.ts`)

- **Every event:** invalidates the events history and the events of that entity.
- **A `session` event:**
  - refetches the messages of every open conversation;
  - refetches that session's detail (`GET /api/sessions/:id`), logs, and the by-actor and
    by-conversation lists;
  - refetches the workspace session list, throttled to once per 5s, and the paged list, once per 30s;
  - refetches loop activity.
  - A completion event also issues one `GET /api/sessions/:id` for analytics.
- **A `conversation` event** (every posted message): refetches all conversation lists in the
  workspace and that conversation's detail and messages, with no throttle.
- **Object events:** refetch the object lists, detail and graph.

A running chat session emits many events, and each one refetches its own detail. That is the most
likely source of the 56k `GET /api/sessions/:id` calls, together with the 2-5s timers.

### iOS (`apps/apple/Sources/MaskinCore`)

`AgentsStore` and `WorkingAgentsFeed` each subscribe to the event hub independently. On **any**
session or actor event, each one schedules a 1s-debounced refetch of both:

- `GET /api/actors?limit=100&offset=0`
- `GET /api/sessions?verbose=true&limit=100`

Consequences:

- A session event does not change the actor list, but it refetches it anyway.
- Two stores do the same fetch, so every burst is paid twice.
- On a busy workspace (dozens of session events a minute) each device makes several requests a
  second while the app is foregrounded or a Live Activity is running.

This matches the `actors?limit=100` count (40,875 from `ios`, mostly from one location with several
devices).

I read `AgentsStore` and `WorkingAgentsFeed` only. `LoopsStore`, `LoopDetailStore`, `ForYouStore`
and the chat stores use the same debouncer and I have not audited what they refetch.

## What I would change, in order of effect

| # | Change | Expected effect | Risk |
|---|---|---|---|
| 1 | iOS: refetch actors only on actor events, not session events | Removes most of the 40k actor calls | Low |
| 2 | iOS: one shared fetch for `AgentsStore` and `WorkingAgentsFeed`; raise the debounce from 1s to ~5s | Roughly halves the remaining iOS calls | Low |
| 3 | Web: consume `GET /api/sessions/:id/logs/stream` instead of polling logs every 2-5s | Removes the timer as the code comment already recommends | Medium: needs a catch-up path for dropped connections |
| 4 | Web: throttle the per-session detail refetch (the trailing-window pattern already used for the session list) | Cuts `GET /api/sessions/:id` | Low |
| 5 | Web: throttle the `conversation` event fan-out | Cuts conversation list and messages refetches | Low |
| 6 | Server: ETag / `304` on the hot reads, with a cheap version check, plus a short shared cache that merges identical requests | Makes the requests that remain cheap for the database | Medium |
| 7 | Events carry the changed fields and the client patches its cache instead of refetching | The structural fix | Larger |

## How to measure the result

- Worker logs, grouped by `x-client-source` and by `user-agent`, for the three endpoints above,
  before and after each change.
- Requests per minute from a single client over a 30-minute working-hours window. 12 a minute is a
  5s poll, 30 a minute a 2s poll.
- Per-endpoint database time, once instrumented.

## Not verified

- The exact split between timers and event-driven refetches for each endpoint. The counts and the
  code point at both, but I have not instrumented a client.
- Which of the nine iOS builds make the calls, and how many devices that is.
- The behaviour of the iOS stores listed above that I did not read.
