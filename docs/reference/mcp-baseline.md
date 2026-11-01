---
title: MCP baseline
slug: mcp-baseline
description: Repeatable, read-only measurements of the Maskin MCP surface (tool list size, response sizes, event paging, workspace schema probe), one dated section per run.
last_updated: 2026-11-01
---

# MCP baseline

`scripts/mcp-baseline.mjs` measures the production MCP surface without writing anything, so each phase of the MCP work can be compared with the one before. Spec: the MCP leftovers tech spec, section 1.

```
MASKIN_API_KEY=... MASKIN_WORKSPACE_ID=... node scripts/mcp-baseline.mjs          # table
MASKIN_API_KEY=... MASKIN_WORKSPACE_ID=... node scripts/mcp-baseline.mjs --json   # for diffing
```

Optional env: `MASKIN_MCP_URL` (default `https://maskin.io/mcp`), `MASKIN_BASELINE_ACTOR_IDS` (comma list; pins which actors `get_actor` is measured on), `MASKIN_BASELINE_KEY_ACTOR_TYPE` (`human` or `agent`; MCP does not tell a caller what it is, so say it here).

## How to read a run

- Read-only by construction: only `tools/list`, `list_workspaces`, `list_actors`, `get_actor`, `list_sessions`, `get_events` and `get_workspace_schema` can be called. Anything else throws and the process exits with code 2. Exit 1 is any other failure.
- Response bodies are measured and dropped. Only byte counts, tool names, key names, numbers and booleans are printed or stored. The key is read from env and never echoed.
- The script reports what production serves and never fails on a count.
- A key that sees fewer workspaces than the audit account is labelled by its workspace count. Compare bytes per row, not totals.
- Unpinned runs choose actors from `list_actors` (3 with a description, 1 without), so the `get_actor` rows can move between runs. Set `MASKIN_BASELINE_ACTOR_IDS` for runs that must be comparable.
- On a live workspace, byte sizes of live data (events, sessions) drift between back-to-back runs because other sessions keep writing. Counts, tool names and the classification do not.
- The heroCard figure is the size of the `heroCard` key inside `content[0].text` (0 when absent), as the spec defines it. On production today the heroCard sits in `structuredContent`, so this reads 0.

## 12 Oct 2026 audit (copied from the audit, not from this script)

Source: [MCP tool surface audit (Oct 2026)](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/78590216-b923-4e17-9954-fa4518317b27). Account with 12 workspaces.

| Measure | Audit figure |
| --- | --- |
| Tools | 65 |
| `tools/list` size | about 130 KB, about 34k tokens (characters / 4) |
| Tools with a title, annotations or outputSchema | 0 of 65 |
| Descriptions over 2,048 characters | 1 named (`create_loop`, 2,761) |
| `list_workspaces`, 12 workspaces | 88 KB (41 KB content, 47 KB structuredContent) |
| `list_actors` | 24 KB, all in `structuredContent.heroCard` |
| `get_actor` | about 30 to 130 KB for agents with a system prompt |
| `get_events` | newest 100 events only; limits 3, 10, 25, 50 return no cursor |
| `get_workspace_schema`, unknown id | returned another workspace's schema |

## Run 2026-11-01: after (PR 2011 is on main)

- Run date: 2026-11-01, from the Developer's agent session against `https://maskin.io/mcp`.
- Server commit: not reported by the server (`serverInfo` says name `maskin`, version `0.1.0`).
- Key: an agent key that sees 1 workspace (not the 12-workspace audit account). Actors unpinned.
- Rate limited: no.

```
measure                                         audit 12 Oct (copied)      now                      delta
----------------------------------------------  -------------------------  -----------------------  -------
tools (count)                                   65                         102                      +37
tools/list bytes                                130000                     235488                   +105488
tools/list tokens (chars/4)                     34000                      58786                    +24786
tools with title                                0                          102                      +102
tools with annotations                          0                          102                      +102
tools with outputSchema                         0                          0                        0
descriptions over 2,048 chars                   1                          0                        -1
top description 1: get_actor                    -                          1549
top description 2: request_keychain_credential  -                          1468
top description 3: create_loop                  -                          1461
top description 4: ask_user_question            -                          1437
top description 5: add_mcp_server               -                          1411
workspaces (count)                              12                         1                        -11
list_workspaces bytes (content+structured)      88000                      757                      -87243
list_workspaces bytes per row                   7333                       757                      -6576
list_workspaces content bytes                   -                          278
list_workspaces structured bytes                -                          479
list_workspaces heroCard bytes                  -                          0
list_workspaces_limit_1 content bytes           -                          277
list_workspaces_limit_1 structured bytes        -                          478
list_workspaces_limit_1 heroCard bytes          -                          0
list_actors content bytes                       -                          0
list_actors structured bytes                    24000                      26693                    +2693
list_actors heroCard bytes                      -                          0
get_actor_1 content bytes                       -                          27751
get_actor_1 structured bytes                    -                          39988
get_actor_1 heroCard bytes                      -                          0
get_actor_2 content bytes                       -                          18123
get_actor_2 structured bytes                    -                          21585
get_actor_2 heroCard bytes                      -                          0
get_actor_3 content bytes                       -                          23545
get_actor_3 structured bytes                    -                          32435
get_actor_3 heroCard bytes                      -                          0
get_actor_4 content bytes                       -                          541
get_actor_4 structured bytes                    -                          933
get_actor_4 heroCard bytes                      -                          0
list_sessions_lean content bytes                -                          6795
list_sessions_lean structured bytes             -                          6808
list_sessions_lean heroCard bytes               -                          0
list_sessions_verbose content bytes             -                          21892
list_sessions_verbose structured bytes          -                          21892
list_sessions_verbose heroCard bytes            -                          0
get_events content bytes                        -                          112045
get_events structured bytes                     -                          112228
get_events heroCard bytes                       -                          0
get_events limit 3: rows                        3                          3                        0
get_events limit 3: cursor returned             no                         yes
get_events limit 10: rows                       10                         10                       0
get_events limit 10: cursor returned            no                         yes
get_events limit 25: rows                       25                         25                       0
get_events limit 25: cursor returned            no                         yes
get_events limit 50: rows                       50                         50                       0
get_events limit 50: cursor returned            no                         yes
get_events limit 100: rows                      99                         99                       0
get_events limit 100: cursor returned           yes                        yes
get_events reachable distinct ids               100                        4950                     +4850
get_events walk pages                           -                          50
get_events walk stopped by                      -                          page_cap
get_workspace_schema unknown id                 returns-another-workspace  errors-and-names-the-id

```

Reading it:

- `tools/list` grew from 65 to 102 tools and from about 130 KB to about 235 KB. Every tool now has a title and annotations; none has an outputSchema; no description is over 2,048 characters (the longest is 1,549).
- `get_events` now reaches 4,950 distinct events over the 50-page cap, so the 100-event ceiling is gone. Limits 3 to 50 now return a cursor.
- `get_workspace_schema` with an unknown id now errors and names the id.
- `list_workspaces` per row is 757 bytes against about 7.3 KB per row in the audit.
- Two back-to-back runs had the same counts, tool names and classifications. Only the byte sizes of live events and sessions differed (other sessions were writing), which is the drift described above.
