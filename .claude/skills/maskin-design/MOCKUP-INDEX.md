# The HITL app mockup — which file to open, and where each screen lives

Two copies of the same mockup sit in this directory. Pick by what you need:

- **`maskin-app.html`** — self-contained single file, no external runtime. **Open this
  one in a browser** to look at the screens. This is the copy for design review and
  for any judgement about how a page actually reads.
- **`maskin-app.dc.html`** + `support.js` — the original `.dc` prototype. Does not
  render standalone. Use it when you want the line map below to jump straight to one
  screen's markup.

The line numbers in this document refer to `maskin-app.dc.html`.

## Line map

So an agent working one page reads only that page's markup instead of the whole
9,043-line file.

**Only lines 1–3469 are markup.** Lines 3470–9040 are the prototype's `data-props`
state blob — fixture data for the prototype runtime, not a source for the rebuild.
The parent Bet's "Not doing" is explicit: *not porting the mockup markup or state blob*.
Read the mockup for layout, hierarchy, copy and states; build with the shared library.

The file is a `.dc` prototype (`<sc-if>`, `{{ binding }}`, inline `style-hover`).
It does not render standalone in a browser — `support.js` is its runtime. Read it as
markup, which is how the Designer has been extracting from it.

## Sections

| Lines | Section | Owning Bet | Where it lands |
|---|---|---|---|
| 39–119 | Full sidebar | App shell | `components/layout/` |
| 120–151 | Icon rail | App shell | `components/layout/` |
| 155–279 | Shared top nav | App shell | `components/layout/` |
| 280–516 | For you | For you — the brief feed | `routes/_authed/$workspaceId/index.tsx` |
| 517–849 | Chats | Chats — list and conversation | `components/chat/` |
| 850–1028 | Objects | Objects — list and board | `routes/…/objects/index.tsx` |
| 1029–1502 | Object detail | Object detail | `routes/…/objects/$objectId.tsx` |
| 1503–1578 | Loops | Loops — index and loop detail | `routes/…/loops/index.tsx` |
| 1579–1842 | Trigger detail | Trigger detail | `routes/…/triggers/$triggerId.tsx` |
| 1843–2043 | Loop detail | Loops — index and loop detail | `routes/…/loops/$loopId.tsx` |
| 2044–2056 | New loop — shell | New loop — the language-only builder | `components/loops/` |
| 2057–2135 | New loop — the conversation | New loop — the language-only builder | `components/loops/` |
| 2136–2286 | New loop — the blueprint | New loop — the language-only builder | `components/loops/` |
| 2287–2343 | Agents | Agents — index, detail, instructions editor | `routes/…/agents/index.tsx` |
| 2344–2521 | Agent detail | Agents — index, detail, instructions editor | `routes/…/agents/$agentId.tsx` |
| 2522–2573 | Search (page-level) | Search view + command palette | new `/search` route |
| 2574–2606 | Marketplace | Marketplace — catalog and detail | `routes/…/marketplace/index.tsx` |
| 2607–2716 | Marketplace detail | Marketplace — catalog and detail | `routes/…/marketplace/$loopId/` |
| 2717–2954 | Settings | Settings — workspace, members, billing, checkout | `routes/…/settings/` |
| 3009–3072 | Stripe checkout | Settings — workspace, members, billing, checkout | `routes/…/settings/` |
| 3073–3101 | Edit instructions | Agents — index, detail, instructions editor | `components/agents/` |

### Overlays (3102–3469) — App shell Bet

| Lines | Overlay |
|---|---|
| 3107–3176 | `navOpen` — mobile nav drawer |
| 3177–3233 | `railNever` — rail hover-expand |
| 3234–3259 | `paletteOpen` — command palette (shared with the Search Bet) |
| 3260–3413 | `newOpen` — create picker |
| 3414–3463 | `briefOpen` — briefing drawer |
| 3464–3468 | `toast` |

### Retired

| Lines | Section | Status |
|---|---|---|
| 2955–3008 | Inline rail | Retired in the mockup itself — detail pages open directly. Do not build. |

## Not in scope

The zip also carried `Maskin iOS`, `Maskin Knowledge v2/v3`, `Maskin Concepts` and
`Maskin First Use` prototypes. The parent Bet excludes all of them — desktop web only —
so they are not committed here. Screenshot renders (~5 MB) and sketch uploads were
also left out to keep the repo light; ask if a page-by-page review wants them.
