// Canonical source-item IDs and metadata for the Knowledge Wiki marketplace
// flow. The bundle is a single agent, the Knowledge Curator. Trigger and skill
// IDs are not listed as constants: they are derived per actor via
// `triggerIdsForActor` / `skillIdsForActor` in
// apps/dev/src/lib/marketplace-loops/loop-data.

export const KNOWLEDGE_WIKI_ACTOR_CURATOR = 'ffcade3f-6e30-4809-9df8-47bb41eeeccb'

export const KNOWLEDGE_WIKI_LOOP_SLUG = 'knowledge-wiki-loop'
export const KNOWLEDGE_WIKI_LOOP_NAME = 'Knowledge Wiki'
export const KNOWLEDGE_WIKI_LOOP_VERSION = '1.1.0'
export const KNOWLEDGE_WIKI_LOOP_USE_CASE = 'Context'
export const KNOWLEDGE_WIKI_LOOP_DESCRIPTION =
	'Keeps the business context your agents and people decide from complete, fresh and readable. A Knowledge Curator folds every new knowledge page into the wiki as it lands, merging near-duplicates and wiring what replaces or contradicts what. Twice a week it refreshes a home page and a status page, grades coverage against a short list of what a company needs to know, and posts a digest that names the open gaps. Once a week it prunes drafts and stale pages, and every day an owner check chases whatever is stuck. Two tabs show the health of the wiki and what it says about the business. Works with whatever knowledge you already have, and the more you connect, the more it can fold.'
