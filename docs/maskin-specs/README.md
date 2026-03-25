# Maskin UI Improvement Specs

Feature specs based on the prototype in `maskin-ui (3).jsx`. Each spec is a standalone change that can be implemented independently, though some have dependencies.

## Specs

| # | Feature | Scope | Dependencies |
|---|---------|-------|--------------|
| 01 | [Objects: Group by Bets](01-objects-grouped-by-bets.md) | Frontend | — |
| 02 | [Agent Working Indicators](02-agent-working-indicators.md) | Frontend + possibly backend | — |
| 03 | [Object Detail: Unified Related Section](03-unified-related-section.md) | Frontend | — |
| 04 | [Object Detail: Activity & Comments](04-object-detail-activity-and-comments.md) | Frontend + backend | — |
| 05 | [Object Detail: Action Banner](05-object-detail-action-banner.md) | Frontend | — |
| 06 | [Activity Page: Filters & Descriptive Entries](06-activity-page-improvements.md) | Frontend | — |
| 07 | [Agents Page: Status Filters & Richer Cards](07-agents-page-status-filters.md) | Frontend | — |
| 08 | [Agent Detail: Instruction Log](08-agent-detail-instruction-log.md) | Frontend | — |
| 09 | [Agent Detail: Collapsible Config](09-agent-detail-collapsible-config.md) | Frontend | 08 (layout depends on instruction log placement) |
| 10 | [Agent Detail: Improved Sessions](10-agent-detail-sessions.md) | Frontend | — |
| 11 | [Chat Drawer](11-chat-drawer.md) | Frontend + backend | — |

## Suggested Implementation Order

**Phase 1 — Quick wins (frontend only, no backend changes)**
- 01 Objects grouped by bets
- 03 Unified related section
- 06 Activity page filters
- 07 Agents page status filters
- 09 Collapsible agent config

**Phase 2 — Agent detail rework**
- 08 Instruction log
- 10 Improved sessions

**Phase 3 — Object detail rework**
- 04 Activity & comments (needs backend for comment storage + @mention handling)
- 05 Action banner

**Phase 4 — Cross-cutting**
- 02 Agent working indicators (needs decision on how agents report progress)

**Phase 5 — Chat drawer**
- 11 Chat drawer (most complex, can be built incrementally)
