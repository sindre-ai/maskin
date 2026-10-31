/**
 * Source-quality rules for deep_research (spec section 7.5). The rule text goes
 * into the researcher and writer prompts verbatim; the denylist and the source
 * types are applied again in code, so a model that ignores the prompt still
 * cannot get a blocked page into the ledger.
 */

export const SOURCE_TYPES = ['primary', 'secondary', 'weak', 'blocked'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/**
 * Domains whose pages never come back: passed to the search provider as excluded
 * domains and checked again on every finding. Seed this from the vendor and
 * affiliate blogs the Researcher has flagged; it is config, not code, and the
 * provider takes at most 150.
 */
export const RESEARCH_DOMAIN_DENYLIST: readonly string[] = []

/** True when the URL's host is a denylisted domain or a subdomain of one. */
export function isDenylistedUrl(
	url: string,
	denylist: readonly string[] = RESEARCH_DOMAIN_DENYLIST,
): boolean {
	let host: string
	try {
		host = new URL(url).hostname.toLowerCase()
	} catch {
		return false
	}
	return denylist.some((d) => {
		const domain = d.toLowerCase()
		return host === domain || host.endsWith(`.${domain}`)
	})
}

/** Tier 1 and 2 count toward success criterion 3 (the share of primary or reputable sources). */
export function isTier12(type: SourceType): boolean {
	return type === 'primary' || type === 'secondary'
}

export const SOURCE_QUALITY_RULES = `Source quality rules:
Tier 1, primary (source_type "primary"): official documentation and release notes, the company's own site or repo, standards and legal texts, government and statistics bodies, filings, peer-reviewed papers and arXiv, original datasets.
Tier 2, reputable secondary (source_type "secondary"): established news and trade press with a named author and date, well-known engineering blogs, recognised industry bodies.
Tier 3, weak (source_type "weak"): vendor marketing, aggregators, forums and social posts, undated or unsigned pages. Usable as a lead or an opinion, never as the only proof of a fact.
Blocked (source_type "blocked"): SEO content farms, "best X in 2026" listicles, affiliate and review farms, scraped or AI-generated pages, search-result pages. Never use these.
Start from tier 1 and follow a secondary source back to the original. Prefer the less-ranked authoritative page (a paper, a personal blog by the author) over a highly-ranked content farm: search engines rank farms high, and you must not pick a page because it ranks first. Every load-bearing claim needs at least one tier 1 or tier 2 source, or is marked low confidence. Say so when only tier 3 sources exist.`
