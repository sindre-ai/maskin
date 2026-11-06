// Canonical source-item IDs and metadata for the Market & Competitor Watch
// marketplace loop. The actors are the Market Researcher, Market Strategist and
// Briefing Owner. Trigger and skill IDs are not listed as constants: they are
// derived per actor via `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

export const MARKET_WATCH_ACTOR_RESEARCHER = 'b8a5aee6-b884-4fdb-82fe-1968c3dbd0bb'
export const MARKET_WATCH_ACTOR_STRATEGIST = '7668f065-8179-461e-a908-77d80ecd54c0'
export const MARKET_WATCH_ACTOR_OWNER = '6617273e-ce12-4b6e-9108-949b07cc06a9'

export const MARKET_WATCH_LOOP_SLUG = 'market-competitor-watch-loop'
export const MARKET_WATCH_LOOP_NAME = 'Market & Competitor Watch'
export const MARKET_WATCH_LOOP_VERSION = '1.0.0'
export const MARKET_WATCH_LOOP_USE_CASE = 'Discovery'
export const MARKET_WATCH_LOOP_DESCRIPTION =
	'Keeps a living picture of where your category is heading and what your competitors, learn-from products and customers are doing. Every week a researcher scans the web, files sourced insights and rewrites one briefing page. Every month the competitor list is re-checked and a strategist refreshes the long view. It runs on a schedule with no end state. An insight is done once it has been routed: clustered, scored, parked with a reason or discarded.'
