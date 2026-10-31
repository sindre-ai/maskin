/**
 * The source-quality config (spec 7.5): one file for what is blocked and what is
 * trusted, so changing either never touches run code.
 */

/**
 * Domains whose pages never come back. Passed to the search provider as excluded
 * domains (it takes at most 150) and checked again on every finding. Seeded from
 * the vendor and affiliate blogs the Researcher flagged in its review of the
 * Danish trades report (the five named there). The TLDs are best guesses from the
 * site names: the Researcher should confirm them.
 */
export const RESEARCH_DOMAIN_DENYLIST: readonly string[] = [
	'usecarly.com',
	'vellum.ai',
	'myquoteiq.com',
	'chatpalbot.com',
	'apexautomate.com',
]

/**
 * Hosts that are primary sources by nature: a finding from one is never ranked
 * below "primary" because the model was unsure. A pattern is a domain
 * (retsinformation.dk, which also covers its subdomains) or a top-level suffix
 * starting with a dot (.gov).
 */
export const RESEARCH_PRIMARY_ALLOW_PATTERNS: readonly string[] = [
	'retsinformation.dk',
	'dst.dk',
	'erst.dk',
	'skat.dk',
	'virk.dk',
	'eur-lex.europa.eu',
	'arxiv.org',
	'.gov',
	'.gov.uk',
	'.edu',
]
