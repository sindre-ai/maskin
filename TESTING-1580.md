# Manual test — PR #1580 (Loops v4 polish)

Workspace `06a052f9-…` · actor `b81f6797-…` (magnus)
Loop A = **Bet discovery loop** `45ac63ac-8cdc-417d-8deb-fea9f2bd5015`
Loop B = **Knowledge Wiki → digest** `d8297683-7552-4840-a755-21539aa95954`

## Already done for you
- migrations 0069 / 0070 confirmed applied (4 new cols on `triggers`)
- `.env` now has `FF_TESTER_ACTOR_IDS` + all four `FF_TESTER_FEATURES`
- Loop B set to `paused`; workspace `credit_balance_cents` reads 0
- 3 targets written to Loop A `metadata.targets`
- child task **"Decide: pursue the self-serve onboarding bet?"** linked `in_loop` to Loop A,
  with 2 comments >7d old + 3 unread agent comments (one attention-4) → `waitingOnViewer=true`
- trigger **Shape the bet** given hands-off = you, escalates-to = Chief of Staff, `escalate_after_ms` = 60s
- trigger **Triage new insight** given hands-off = Strategist, escalate 24h (a step that should NOT escalate)
- placeholder `github` integration = connected (so D9 shows one green + one amber chip)

## Step 1 — restart apps/dev
Env is only read at boot. After restart:

    curl -s -H "Authorization: Bearer $KEY" http://localhost:3000/api/feature-flags

All four `loops-v4-polish*` must read `true`. If they don't, nothing below will render.

## Step 2 — walk it (do each at 375 / 768 / 1024)

| # | Where | Expect |
|---|-------|--------|
| D1 | `/loops` | **Knowledge Wiki → digest** row shows PAUSED + amber **NO CREDITS**; click opens billing top-up drawer |
| D2 | `/loops`, "Not tied to a loop" | rows have state label + toggle rail, **no chevron** |
| D3 | `/loops/45ac63ac…` | amber ask banner above the summary strip; **Decide ↓** scrolls to the flow; press **d** does the same; `ask_banner_decide_clicked` in the network tab |
| D4 | same page | 5 tiles incl. *Asks waiting* and *Next fire* (Loop A has a `0 8 * * *` cron); 2×2 grid at 375px |
| D5 | same page | **Targets & owners**: Bets shipped 3/10 (you, strict), Signals triaged 48/50, Discovery calls 1/12 (Strategist, window) — three different pace pills |
| D6c | same page | six-step spine; **Shape the bet** shows HANDS OFF → magnus and ESCALATES TO → Chief of Staff; the two cron steps show neither; scroll fires `flow_scroll_depth` at 25/50/75/100 |
| D6b | wait ~60s after boot | an attention-4 comment appears **on the loop object** mentioning Chief of Staff: *"Escalating: Shape the bet has been waiting … on magnus."* Then wait another 60s — it must **not** post twice. Check `select last_escalated_at from triggers where name='Shape the bet'` |
| D8 | loop detail → Timeline | red **NEW · 3 unread** divider + **Mark read**; **EARLIER** divider above the two 12/20-day-old comments; read rows dimmed; click Mark read → clears, fires `mark_read_clicked`, survives reload |
| D9 | `/loops/new` | type a plan mentioning slack and github, e.g. *"When someone posts in slack, open a github issue"* → github chip green ✓, slack chip amber **needs connecting** + working Connect link |

## Step 3 — rollback check
Drop `loops-v4-polish` from `FF_TESTER_FEATURES`, restart. Every surface above disappears
and the escalation reconciler stops ticking.

## Cleanup when done
    docker exec maskin-postgres-1 psql -U postgres -d maskin -c "
      delete from events where entity_id='11111111-1111-4111-8111-111111111111';
      delete from relationships where target_id='11111111-1111-4111-8111-111111111111';
      delete from objects where id='11111111-1111-4111-8111-111111111111';
      delete from integrations where credentials='manual-test-placeholder';
      update objects set status='learning' where id='d8297683-7552-4840-a755-21539aa95954';
      update objects set metadata = metadata - 'targets' where id='45ac63ac-8cdc-417d-8deb-fea9f2bd5015';
      update triggers set hands_off_to_actor_id=null, escalates_to_actor_id=null,
        escalate_after_ms=null, last_escalated_at=null where escalate_after_ms is not null;"
Then remove the two `FF_*` lines from `.env` and delete this file.
