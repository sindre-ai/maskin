/**
 * The search data-use rule for deep_research (spec 7.9, CTO ruling 2026-10-31).
 * Search queries go to a third-party provider that may keep and train on them, so
 * they carry the public topic only. The text goes word for word into the lead
 * prompt, the researcher prompt and the deep_research tool description. Tests pin
 * all three, so an edit cannot silently drop it from one of them.
 */
export const SEARCH_DATA_USE_RULE =
	'Search queries go to a third-party provider that may keep and train on them. Write queries about the public topic only. Never include a client name, contact name, deal, customer data or anything copied from a private workspace object. For a client-specific question, do not use this tool.'
