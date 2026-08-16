# v2 mockup — sections and where they land

The v2 file (`maskin-app-v2.html`) is a `.dc` prototype packaged as a self-contained "bundled page." Open it in a browser to walk the mockup; read the raw markup with line-based navigation using the map below.

**Only lines 269–3306 are markup.** Everything from line 3307 onward is the prototype's `data-props` state blob and the `Component` class that drives the mockup runtime — fixture data and interaction glue, not a source for the rebuild. The parent bet's "Not doing" is explicit: *not porting the mockup markup, inline styles, or state blob*.

Line numbers refer to `maskin-app-v2.html` (the copy in this folder), which is the same bundle attached to the parent bet. The bundle prepends a 268-line runtime; the markup starts at 269.

## Sections

| Lines | Section | Owning bet | Route(s) it governs |
|---|---|---|---|
| 269–328  | Full sidebar | App shell | `components/layout/` — sidebar shown at ≥1024px |
| 330–359  | Icon rail (collapsed sidebar) | App shell | `components/layout/` |
| 364–486  | Shared top nav (per-view search, filters, "New" menu) | App shell | `components/layout/` |
| 488–531  | For you (with the "Today's brief" dark pill + `briefOpen` drawer) | For you — the brief feed | `routes/_authed/$workspaceId/index.tsx` |
| 533–864  | Chats — list + thread + typing/streaming, empty state, older-loaded | Chats (not in the 14 audit routes; keep on the app shell) | `components/chat/`, chat surfaces reused by other routes |
| 866–1044 | Objects — list, per-type filter chips, bulk-select bar | Objects — list and board | `routes/…/objects/index.tsx` |
| 1046–1516| Object detail — timeline + properties + related objects | Object detail | `routes/…/objects/$objectId.tsx` |
| 1518–1585| Loops — index | Loops — index and loop detail | `routes/…/loops/index.tsx` |
| 1587–1849| Trigger detail (a trigger that isn't part of a loop) | Trigger detail | `routes/…/triggers/$triggerId.tsx` |
| 1851–2050| Loop detail — "four sentences" reader | Loops — index and loop detail | `routes/…/loops/$loopId.tsx` |
| 2052–2293| New loop — language-only builder (shell, conversation, blueprint) | New loop — the language-only builder | `components/loops/` (opened from Loops) |
| 2295–2350| Agents — index | Agents — index, detail, instructions editor | `routes/…/agents/index.tsx` |
| 2352–2528| Agent detail | Agents — index, detail, instructions editor | `routes/…/agents/$agentId.tsx` |
| 2530–2580| Search (page-level) | Search view + command palette | `/search` route (also shares the palette overlay) |
| 2582–2613| Marketplace — catalog | Marketplace — catalog and detail | `routes/…/marketplace/index.tsx` |
| 2615–2723| Marketplace detail | Marketplace — catalog and detail | `routes/…/marketplace/$loopId/` |
| 2725–2964| Settings — workspace, members, billing tab | Settings — workspace, members, billing, checkout | `routes/…/settings/` |
| 2967–3028| Stripe checkout (`payOpen` overlay) | Settings — workspace, members, billing, checkout | `routes/…/settings/` |
| 3031–3057| Edit-instructions overlay (`aeOpen`) | Agents — index, detail, instructions editor | `components/agents/` |

## Overlays (3060–3306) — App shell bet

Every overlay in v2 renders behind a single 35%-black backdrop (`overlayOpen`, line 3060). Nothing else opens the backdrop.

| Lines | Overlay | State flag |
|---|---|---|
| 3064–3122 | Mobile nav drawer | `navOpen` |
| 3124–3148 | Command palette (also the Search bet's entry surface) | `paletteOpen` |
| 3150–3302 | Create picker (greeter, quick-add, typed preview) | `newOpen` |
| 3304–3306 | Toast | `toast` |

## The 14 audit routes — where each one reads from

The parent bet's Cross-cutting QA task 2 enumerates 14 routes to walk. Some of them map to a single v2 section; three don't have a dedicated section in v2 and must fall back to the shared vocabulary.

| # | Route | v2 section | Notes |
|---|---|---|---|
| 1  | For you             | 488–531 (+ brief drawer inline)         | The Today's brief pill is the primary hero. |
| 2  | Briefing            | 501–527 (inside For you)                | v2 folds Briefing into the For You header. If the shipped app has a separate Briefing page, that page must read as an expansion of the same pill — same dark surface, same waveform, same MENTIONED footer. |
| 3  | Objects list        | 866–1044                                | Filter chips + bulk-select bar. |
| 4  | Object detail       | 1046–1516                               | Timeline + properties. |
| 5  | Agents list         | 2295–2350                               | |
| 6  | Agent detail        | 2352–2528 (+ 3031–3057 edit overlay)    | |
| 7  | Loops list          | 1518–1585                               | |
| 8  | Loop detail         | 1851–2050                               | Read it in four sentences, change it by talking. |
| 9  | Triggers list       | *(no dedicated v2 section)*             | v2 shows a Trigger detail (1587–1849) but no separate Triggers list. Build the list from the shared object-list vocabulary (see Objects list, 866–1044) and use the same filter-chip + row density. |
| 10 | Trigger detail      | 1587–1849                               | |
| 11 | Marketplace list    | 2582–2613                               | |
| 12 | Marketplace item    | 2615–2723                               | |
| 13 | Files               | *(no dedicated v2 section)*             | v2 has no Files route. Build it as an Objects-list variant filtered to files, and open detail using the Object-detail shell. Flag any pattern in the shipped Files page that isn't in either as drift. |
| 14 | Settings (+ subs)   | 2725–2964 (+ 2967–3028 Stripe checkout) | |

## Not in scope

The v1 skill also carried the maskin.io docs source and iOS / Knowledge / Concepts / First Use prototypes. The parent bet excludes all of those (desktop web only, v2 replaces the docs source), so this v2 skill carries only the one file. Ask if the audit wants any of the retired sources back.
