/**
 * Pictogram avatars for agents (v16): every agent is drawn as a tinted tile with a small
 * geometric mark. The mark's *family* says which kind of work the agent does (circles for
 * sales, arcs for marketing, bars for content, ...) and one of six variants inside the
 * family tells agents of the same kind apart. Both choices are deterministic from the
 * agent's name, so the same agent looks the same on every surface and every device.
 *
 * Marks are plain vector shapes on a 24x24 grid, painted with `currentColor`; the tile's
 * tint comes from existing status tokens, so light and dark mode follow the theme.
 */

export type PictogramShape =
	| ['c', number, number, number] // filled circle: cx, cy, r
	| ['rg', number, number, number, number] // ring: cx, cy, r, stroke width
	| ['p', string] // filled path
	| ['l', string, number] // stroked line path: d, stroke width
	| ['r', number, number, number, number, number] // filled rect: x, y, w, h, rx
	| ['ro', number, number, number, number, number] // outlined rect: x, y, w, h, rx

export type AgentTeam =
	| 'Sales'
	| 'Marketing'
	| 'Content'
	| 'Support'
	| 'Operations'
	| 'Finance'
	| 'Product'
	| 'Development'
	| 'Legal'
	| 'People'
	| 'Recruiting'
	| 'Video'

const c = (x: number, y: number, r: number): PictogramShape => ['c', x, y, r]
const rg = (x: number, y: number, r: number, w: number): PictogramShape => ['rg', x, y, r, w]
const p = (d: string): PictogramShape => ['p', d]
const l = (d: string, w: number): PictogramShape => ['l', d, w]
const r = (x: number, y: number, w: number, h: number, rx: number): PictogramShape => [
	'r',
	x,
	y,
	w,
	h,
	rx,
]
const ro = (x: number, y: number, w: number, h: number, rx: number): PictogramShape => [
	'ro',
	x,
	y,
	w,
	h,
	rx,
]

/** Six marks per team. Each is a list of shapes drawn together. */
const TEAM_MARKS: Record<AgentTeam, PictogramShape[][]> = {
	Sales: [
		[c(12, 12, 5.5)],
		[rg(12, 12, 6, 2.6)],
		[c(7.5, 12, 3.4), c(16.5, 12, 3.4)],
		[c(5.5, 12, 2.6), c(12, 12, 2.6), c(18.5, 12, 2.6)],
		[rg(12, 12, 7.5, 2.4), c(12, 12, 2.6)],
		[c(9, 12, 5), rg(15, 12, 5, 2.2)],
	],
	Marketing: [
		[p('M4 15a8 8 0 0 1 16 0z')],
		[p('M5 19V5a14 14 0 0 1 14 14z')],
		[l('M5 16a7 7 0 0 1 14 0', 2.8)],
		[l('M4 17a8 8 0 0 1 16 0', 2.4), l('M8 17a4 4 0 0 1 8 0', 2.4)],
		[p('M16.5 4.2A8.6 8.6 0 1 0 19.8 15 7 7 0 0 1 16.5 4.2z')],
		[p('M4 11a8 8 0 0 1 16 0z'), p('M4 14h16a8 8 0 0 1-16 0z')],
	],
	Content: [
		[l('M5 7h14M5 12h14M5 17h9', 2.8)],
		[r(4, 8.5, 16, 7, 3.5)],
		[r(4, 5.5, 16, 5, 2.5), r(4, 13.5, 11, 5, 2.5)],
		[l('M5 7h8M5 12h14M5 17h11', 2.8)],
		[r(4, 10, 16, 4, 2), c(7, 5.5, 1.8), c(7, 18.5, 1.8)],
		[r(4, 7, 11, 5, 2.5), c(18, 16.5, 2.5)],
	],
	Support: [
		[ro(4, 5, 16, 11, 4), p('M8 16l-1 4 5-4z')],
		[rg(12, 12, 7.5, 3)],
		[c(7, 12, 2), c(12, 12, 2), c(17, 12, 2)],
		[l('M5 14v-2a7 7 0 0 1 14 0v2', 2.6), r(3.5, 13, 3.5, 6, 1.6), r(17, 13, 3.5, 6, 1.6)],
		[rg(12, 12, 8, 2.4), c(12, 12, 2.6)],
		[l('M12 5v14M5 12h14', 3.2)],
	],
	Operations: [
		[rg(12, 12, 6, 2.6), l('M12 2.5v3M12 18.5v3M2.5 12h3M18.5 12h3', 2.6)],
		[l('M12 4l7 4v8l-7 4-7-4V8z', 2.6)],
		[l('M5 8h14M5 16h14', 2.4), c(9, 8, 2.4), c(15, 16, 2.4)],
		[r(4, 5, 16, 4.5, 2.2), r(4, 14.5, 16, 4.5, 2.2)],
		[l('M5 12a7 7 0 0 1 12-5M19 12a7 7 0 0 1-12 5', 2.8)],
		[c(5.5, 12, 2.4), c(12, 12, 2.4), c(18.5, 12, 2.4), r(5, 17, 14, 2, 1)],
	],
	Finance: [
		[c(12, 12, 7.5)],
		[r(5, 13, 4, 6, 1.4), r(10, 9, 4, 10, 1.4), r(15, 5, 4, 14, 1.4)],
		[rg(12, 12, 7.5, 2.4), l('M12 8.5v7', 2.4)],
		[c(12, 7.5, 3.5), c(12, 16.5, 3.5)],
		[l('M4 17l5-5 4 3 7-8', 2.8)],
		[p('M4 12a8 8 0 0 1 16 0z'), r(4, 14.5, 16, 4, 2)],
	],
	Product: [
		[r(6, 6, 12, 12, 3)],
		[ro(5.5, 5.5, 13, 13, 3)],
		[r(5, 5, 6, 6, 1.6), r(13, 5, 6, 6, 1.6), r(5, 13, 6, 6, 1.6), r(13, 13, 6, 6, 1.6)],
		[ro(4.5, 4.5, 15, 15, 3.5), r(9, 9, 6, 6, 1.5)],
		[r(5, 5, 14, 5, 2.5), r(5, 14, 14, 5, 2.5)],
		[r(5, 5, 14, 14, 3)],
	],
	Development: [
		[p('M12 4.5l7.5 7.5-7.5 7.5-7.5-7.5z')],
		[l('M12 5l7 7-7 7-7-7z', 2.6)],
		[l('M8 5l7 7-7 7', 3)],
		[l('M5 6l6 6-6 6M13 6l6 6-6 6', 2.8)],
		[p('M12 5l8 14H4z')],
		[l('M9 6L4 12l5 6M15 6l5 6-5 6', 2.8)],
	],
	Legal: [
		[r(5, 5, 3.6, 14, 1.4), r(10.2, 5, 3.6, 14, 1.4), r(15.4, 5, 3.6, 14, 1.4)],
		[p('M12 4l7 3v5c0 4-3 7-7 8-4-1-7-4-7-8V7z')],
		[l('M12 5v14M6 8h12', 2.6), c(6, 14, 2.6), c(18, 14, 2.6)],
		[ro(6, 4.5, 12, 15, 2.5), l('M9.5 10h5M9.5 14h5', 2.2)],
		[r(4, 18, 16, 2.6, 1.3), p('M6 6h12l-1 10H7z')],
		[l('M12 4v16', 2.6), r(5, 4, 14, 3, 1.5)],
	],
	People: [
		[c(12, 8, 3.6), p('M5 19a7 7 0 0 1 14 0z')],
		[c(8, 9, 3), c(16, 9, 3), p('M3.5 19a4.5 4.5 0 0 1 9 0zM11.5 19a4.5 4.5 0 0 1 9 0z')],
		[rg(12, 9, 3.2, 2.4), l('M5.5 19a6.5 6.5 0 0 1 13 0', 2.6)],
		[c(12, 6.5, 2.8), c(6.5, 15.5, 2.8), c(17.5, 15.5, 2.8)],
		[c(12, 12, 8)],
		[c(12, 9, 4), l('M5 19h14', 3)],
	],
	Recruiting: [
		[rg(10.5, 10.5, 6, 2.8), l('M15 15l5 5', 3)],
		[rg(12, 12, 8, 2.4), rg(12, 12, 4, 2.4)],
		[c(10, 9, 3.2), p('M4 18a6 6 0 0 1 12 0z'), l('M18 6v6M15 9h6', 2.4)],
		[c(12, 12, 8)],
		[l('M12 20s-6-5-6-10a6 6 0 0 1 12 0c0 5-6 10-6 10z', 2.6), c(12, 10, 2)],
		[rg(12, 12, 7.5, 2.4), c(12, 12, 3)],
	],
	Video: [
		[p('M8 5l11 7-11 7z')],
		[l('M8.5 5.5l10 6.5-10 6.5z', 2.6)],
		[p('M8 6.5q0-2 2-.8l8 5q1.6 1 0 2l-8 5q-2 1.2-2-.8z')],
		[rg(12, 12, 8, 2.4), p('M10 8.5l5.5 3.5-5.5 3.5z')],
		[p('M4 6l7 6-7 6z'), p('M13 6l7 6-7 6z')],
		[p('M4 5h10l6 7-6 7H4z')],
	],
}

/**
 * Tile tint per team, from the existing status tokens (a tint fill plus a deep ink for the
 * mark; both are tokens, so dark mode inverts correctly). Twelve teams share ten tints, so
 * the mark family, not the colour alone, carries the meaning.
 */
const TEAM_TINT: Record<AgentTeam, string> = {
	Sales: 'bg-[var(--st-processing-bg)] text-[var(--st-processing-text)]',
	Marketing: 'bg-[var(--st-define-bg)] text-[var(--st-define-text)]',
	Content: 'bg-[var(--st-clustered-bg)] text-[var(--st-clustered-text)]',
	Support: 'bg-[var(--st-qualified-bg)] text-[var(--st-qualified-text)]',
	Operations: 'bg-[var(--st-parked-bg)] text-[var(--st-parked-text)]',
	Finance: 'bg-[var(--st-active-bg)] text-[var(--st-active-text)]',
	Product: 'bg-[var(--st-in_progress-bg)] text-[var(--st-in_progress-text)]',
	Development: 'bg-[var(--st-archived-bg)] text-[var(--st-archived-text)]',
	Legal: 'bg-[var(--st-opportunity-bg)] text-[var(--st-opportunity-text)]',
	People: 'bg-[var(--st-blocked-bg)] text-[var(--st-blocked-text)]',
	Recruiting: 'bg-[var(--st-in_review-bg)] text-[var(--st-in_review-text)]',
	Video: 'bg-[var(--st-scored-bg)] text-[var(--st-scored-text)]',
}

const TEAM_BY_NAME: Record<string, AgentTeam> = {
	'chief of staff': 'Operations',
	strategist: 'Product',
	developer: 'Development',
	'code reviewer': 'Development',
	'seo analyst': 'Marketing',
	'seo researcher': 'Marketing',
	'seo writer': 'Content',
	'seo editor': 'Content',
	'seo publisher': 'Content',
	prospector: 'Sales',
	qualifier: 'Sales',
}

// First match wins, so the order is the priority.
const TEAM_PATTERNS: [RegExp, AgentTeam][] = [
	[/legal|contract|compliance/i, 'Legal'],
	[/financ|account|invoice|bookkeep/i, 'Finance'],
	[/recruit|candidate|hiring/i, 'Recruiting'],
	[/\bhr\b|people|onboard/i, 'People'],
	[/support|help|triage/i, 'Support'],
	[/video|film|edit/i, 'Video'],
	[/market|seo|social|brand/i, 'Marketing'],
	[/content|write|copy/i, 'Content'],
	[/sales|lead|prospect/i, 'Sales'],
	[/product|design|roadmap/i, 'Product'],
	[/dev|code|engineer/i, 'Development'],
]

/** The kind of work an agent does, read from its name; unknown names land in Operations. */
export function getAgentTeam(name: string): AgentTeam {
	const trimmed = (name ?? '').trim()
	const known = TEAM_BY_NAME[trimmed.toLowerCase()]
	if (known) return known
	// A bracketed qualifier ("Sales Rep (Sebk)") never changes what the agent does.
	const bare = trimmed.replace(/\(.*?\)/g, ' ')
	return TEAM_PATTERNS.find(([pattern]) => pattern.test(bare))?.[1] ?? 'Operations'
}

function hashName(name: string): number {
	let hash = 7
	for (let i = 0; i < name.length; i++) {
		hash = (Math.imul(hash, 31) + name.charCodeAt(i)) >>> 0
	}
	return hash
}

export type AgentPictogram = {
	team: AgentTeam
	/** 0-5: which of the team's six marks. */
	variant: number
	shapes: PictogramShape[]
	/** Tile fill and mark colour, as semantic token classes. */
	tintClass: string
}

/** The pictogram for an agent: same name in, same pictogram out. */
export function getAgentPictogram(name: string): AgentPictogram {
	const normalized = (name ?? '').trim()
	const team = getAgentTeam(normalized)
	const marks = TEAM_MARKS[team]
	const variant = hashName(normalized) % marks.length
	return {
		team,
		variant,
		shapes: marks[variant] ?? marks[0] ?? [],
		tintClass: TEAM_TINT[team],
	}
}
