# v2 frontend — backend follow-ups

Everything here was **deliberately not built** during the v2 frontend rebuild
(`bet/frontend-v2-master`), because the data or endpoint it needs does not exist.
None of these is an oversight. Each was found by walking the v2 mockup
(`.claude/skills/maskin-design/maskin-app-v2.dc.html`) against the code, and each
is recorded at its call site too, so a future coverage audit reads them as
settled rather than missing.

The v2 mockup is a **prototype backed by fixtures** — it renders things
confidently because a fixture supplied them. Where it disagrees with the app, the
app is sometimes right. That is why the list below is scoped to real gaps rather
than "everything the mockup shows".

---

## Billing and payments

| Needs | Unblocks | Mockup |
|---|---|---|
| `paymentMethod { brand, last4, expMonth, expYear, name }` on the billing summary | Card-on-file display. Today the card-present state is inferred from `plan.status === 'active'`, which is the only honest signal available — a Stripe Customer exists only after `POST /billing/complete` succeeds. | 2894–2899 |
| An included-usage / allowance field | The two-segment usage meter, "of $X included", and the amber overage segment. Nothing on the `billing` table, `summaryResponseSchema` or `resolvePlan()` carries a ceiling, so the figure ships with no bar rather than an invented denominator. | 2803–2813 |
| A plan catalogue (price, per, tagline, features) | The `PLANS` card grid and the in-checkout plan chooser. The instance resolves exactly one plan from `STRIPE_PRICE_ID`, so there is no grid to draw. | 2816–2839, 3021–3023 |
| An endpoint that writes a workspace spend cap | The "Stop additional usage at $N a month" control. A limit that appears to save and does not is worse than its absence. | 2861–2880 |
| "Included usage" / "Beyond that" fields | The checkout summary lines. | 3026–3027 |
| A single workspace usage endpoint | `useWorkspaceModelUsage` currently issues **one request per agent actor** — an N+1 on every Billing page load. | — |

**Out of scope for v1 by product decision, not blocked:** per-invoice Download
(2929). `invoices` carries only a `stripePaymentIntentId`, no hosted URL or PDF.

---

## Objects

| Needs | Unblocks |
|---|---|
| An `attention` query param on `GET /objects` | The Attention axis currently filters **client-side over loaded pages only**. The infinite-scroll sentinel is kept mounted as an interim, but counts and paging are not truthful. "Waiting on you" is a pending `needs_input` notification and "agent working" is a live session — both are server facts and the filter belongs in the query. |
| A loop association on `ObjectResponse` | Loop name on list rows and board cards, and the `Loop` GROUP BY / FILTER BY axis. |
| A `note` field (or a written `metadata.note`) | The trailing-tag note fallback when grouped by State. |
| Per-status descriptions in workspace settings | Board column captions ("awaiting you", "building", "shipped, watching"). The note slot currently carries the real loaded-of-total reading instead. |

**Product decision pending:** bulk Archive is gated to types that support
`Show archived` (bet-only), because archiving a task or insight otherwise
stranded it with no way back. Widening `supportsIncludeArchived` to all types is
a one-line change plus its chip test — a product call, not a defect fix.

---

## Loops and triggers

| Needs | Unblocks |
|---|---|
| A server-side "describe this loop as a plan" endpoint, or `metadata.plan` on Marketplace/MCP-created loops | The `PROPOSED EDIT` card for **all** loops. It works today off the `metadata.plan` snapshot `/loops/new` writes; loops created elsewhere fall back silently to the chat hand-off. |
| Counters on `loopSummarySchema` | The "ran alone" and "your time · 30d" summary tiles. Not derivable from sessions or events without inventing a definition. |
| A per-loop stage field on `loopSummarySchema` | A real loop stage. The row currently reads `LOOP_PILL_STYLES[pill].label`. |
| An in-place language-patch contract for triggers | `CHANGES` as the operator's utterance transcript. There is nowhere the operator's words are stored to read back, so utterances hand off to `/chats/new` and `CHANGES` shows the event log. |
| Anything that writes `config.writes`, `config.stops_for_you`, `config.skill` | `WHAT IT WRITES`, `IT STOPS FOR YOU WHEN`, and the skill chip on trigger detail. The render paths exist and are gated; they light up when data arrives. |
| A `PlanIntegration[]` field plus a real detection rule | `NEEDS THESE CONNECTED` on New loop. Omitted rather than guessing keyword→provider, which would confidently name the wrong integration. |

---

## Chats and For You

| Needs | Unblocks |
|---|---|
| `chips` on `messageMetadataSchema` and `MessageMetadata` | Inline ask blocks on chat messages. The schema is a **closed** Zod object, so `chips` on a message is stripped server-side. No render path was built for it. Object comments already support chips via `safeMetadataSchema`, which is what the composer's "Attach a decision" writes. |
| A loop association and tags on `conversations` | The thread-header loop chip and the conversation-row tag pill. |
| A scheduled brief job plus `next_brief_at` on the briefing response | "Next brief tomorrow, 08:30" on the caught-up state. `GET /briefing` is generated on demand; nothing schedules one. |

---

## Frontend follow-up (no backend needed)

- `components/shared/create-picker.tsx` needs a `seed` prop
  (`{ title?, fields?, contextSummary?, sourceLabel?, sourceHref? }`) to become
  the mockup's FROM-THIS-CHAT panel (per-field provenance badges, CONTEXT IT
  INHERITS, "Lands in ⟨loop⟩"). The chat composer is already built up to it and
  currently seeds only the object type.
- The trigger-detail breadcrumb's middle crumb (`Loops › Not tied to a loop ›
  ⟨name⟩`, mockup 1584) needs the **page** to publish its own crumb. `header.tsx`
  derives crumbs from the route and cannot know a trigger's owning loop, so a
  hardcoded middle crumb would be wrong on every loop-owned trigger.

---

## Verification status

Unit and type coverage is green (285 test files / 2938 tests, `tsc` and Biome
clean). **No Playwright spec has been executed**: installing the browser failed
repeatedly on this machine because concurrent agent sessions contend for the
shared `~/Library/Caches/ms-playwright` cache, killing each extraction partway.
The specs are written against `SHIP_GATE_VIEWPORTS` (375 / 768 / 1024). CI's
`verify-e2e` job is their first real run — expect stale selectors, given how much
markup moved.

To run them locally, do it with no other Claude session active:

```sh
pkill -f oopDownloadBrowserMain
rm -rf ~/Library/Caches/ms-playwright/__dirlock ~/Library/Caches/ms-playwright/chromium*
cd apps/e2e && npx playwright install chromium-headless-shell && npx playwright test
```
