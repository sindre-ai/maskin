Footprint pass 2026-08-23 after [Bet-based product planning: the anti-backlog doctrine](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/706be340-8630-4ded-99a0-2605768bead5) moved `published` → `live` at `/docs/bet-based-product-planning/` (event 444907). This closes the risk flagged by the now-discarded [insight a3bf2dff](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/a3bf2dff-eada-41cb-9980-1694ec727981): the two spokes finally cite an actually-shipped pillar.

DOCTRINE CLUSTER — SHIP STATE (3/3 LIVE):

```chart
{"type":"bar","x":"page","series":["live"],"data":[{"page":"Cornerstone (doctrine)","live":1},{"page":"Bet vs backlog","live":1},{"page":"How to run","live":1}],"caption":"Doctrine cluster — fully shipped 2026-08-23"}
```

1. [Bet-based product planning: the anti-backlog doctrine](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/706be340-8630-4ded-99a0-2605768bead5) — `live` at `/docs/bet-based-product-planning/`.
2. [Bet vs backlog](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/01851ab4-4a31-488b-bdbd-c8211e44d96f) — `live`.
3. [How to run bet-based planning](https://maskin.io/e2877e32-2c11-489e-96c8-a76200908ed4/objects/7d36f41f-c887-4424-b8f4-c4eb608e5e58) — `live`.

GAP FOUND (real, worth fixing) — **canonical/interlink drift on the two spokes.** Both live spokes point their in-body anchor links at `/bet-based-product-planning/` (no `/docs/` prefix), but the cornerstone shipped at `/docs/bet-based-product-planning/`. Bet vs backlog has 3 such anchors; How to run has 5. Either Publisher has a redirect stack in place (fine, but adds a hop) or these links break/404 (bad).
