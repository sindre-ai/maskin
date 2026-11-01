import { z } from 'zod'
import {
	SOURCE_TYPES,
	type SourceType,
	effectiveSourceType,
	isDenylistedUrl,
	isTier12,
} from './source-quality'

/**
 * The evidence ledger (spec sections 7.1 and 7.4). The researcher returns
 * structured findings; code keeps only the ones that hold up (the quote is in the
 * fetched text, the source is not blocked), numbers the sources, and later checks
 * the writer's report against that numbering. No unsupported claim ships.
 */

/** A researcher returns at most this many findings, so the writer's input stays bounded. */
export const MAX_FINDINGS_PER_RESEARCHER = 15

const findingSchema = z.object({
	claim: z.string().min(1),
	quote: z.string().min(1),
	url: z.string().min(1),
	title: z.string().default(''),
	publisher: z.string().default(''),
	date: z.string().nullable().default(null),
	source_type: z.enum(SOURCE_TYPES),
	confidence: z.number().min(0).max(1).default(0.5),
})

const unreadSchema = z.object({
	url: z.string().min(1),
	reason: z.string().default('could not be read'),
})

export type ResearcherFinding = z.infer<typeof findingSchema>
export interface UnreadSource {
	url: string
	reason: string
}

export interface ResearcherOutput {
	findings: ResearcherFinding[]
	unread: UnreadSource[]
	gaps: string[]
	/** Findings in the JSON that did not match the contract and were skipped. */
	malformedFindings: number
}

/** Pulls the JSON object out of a reply that may be wrapped in a code fence or prose. */
function extractJsonObject(text: string): unknown {
	const start = text.indexOf('{')
	const end = text.lastIndexOf('}')
	if (start === -1 || end <= start) return undefined
	try {
		return JSON.parse(text.slice(start, end + 1))
	} catch {
		return undefined
	}
}

/**
 * Parses the researcher's final reply. Returns null when it is not the JSON
 * contract at all (there is no repair call, so the run fails with a plain
 * reason). Findings that break the contract one by one are skipped and counted.
 */
export function parseResearcherOutput(text: string | null): ResearcherOutput | null {
	if (!text) return null
	const raw = extractJsonObject(text)
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null
	const obj = raw as Record<string, unknown>
	if (!Array.isArray(obj.findings)) return null

	const findings: ResearcherFinding[] = []
	let malformedFindings = 0
	for (const f of obj.findings) {
		const parsed = findingSchema.safeParse(f)
		if (parsed.success) findings.push(parsed.data)
		else malformedFindings += 1
	}
	const unread: UnreadSource[] = []
	for (const u of Array.isArray(obj.unread) ? obj.unread : []) {
		const parsed = unreadSchema.safeParse(u)
		if (parsed.success) unread.push(parsed.data)
	}
	const gaps = (Array.isArray(obj.gaps) ? obj.gaps : []).filter(
		(g): g is string => typeof g === 'string' && g.trim().length > 0,
	)
	return { findings, unread, gaps, malformedFindings }
}

/**
 * A URL as a lookup key: the provider may hand back the page with a trailing
 * slash or a fragment the model dropped, or the reverse.
 */
export function normalizeUrl(url: string): string {
	try {
		const u = new URL(url)
		u.hash = ''
		return u.toString().replace(/\/$/, '')
	} catch {
		return url.trim()
	}
}

const normalizeWhitespace = (s: string): string => s.replace(/\s+/g, ' ').trim()

/** The quote check: the quote must appear in the fetched text, whitespace aside. */
export function quoteInText(quote: string, pageText: string): boolean {
	const q = normalizeWhitespace(quote)
	return q.length > 0 && normalizeWhitespace(pageText).includes(q)
}

export interface LedgerSource {
	n: number
	url: string
	title: string
	publisher: string
	date: string | null
	source_type: SourceType
}

export interface LedgerFinding {
	/** The source number the claim is cited with. */
	n: number
	claim: string
	quote: string
	confidence: number
}

export interface Ledger {
	sources: LedgerSource[]
	findings: LedgerFinding[]
	/** Why findings were dropped, for the run's warnings. */
	dropped: { quoteNotFound: number; blocked: number; notFetched: number; malformed: number }
}

/** One researcher's findings with the page text it fetched, which is all its quotes may rest on. */
export interface LedgerPart {
	output: ResearcherOutput
	/** Maps a normalized URL to the page text the provider's extract returned. */
	fetchedText: ReadonlyMap<string, string>
}

/**
 * Keeps the findings that hold up and numbers their sources by first appearance.
 * A finding is dropped when its source is blocked or denylisted, when its page was
 * never fetched by the researcher that cites it, or when its quote is not on that
 * page. Several researchers share one numbering: the same URL is one source.
 */
export function buildMergedLedger(
	parts: readonly LedgerPart[],
	denylist?: readonly string[],
): Ledger {
	const dropped = { quoteNotFound: 0, blocked: 0, notFetched: 0, malformed: 0 }
	const sources: LedgerSource[] = []
	const numberByUrl = new Map<string, number>()
	const findings: LedgerFinding[] = []

	for (const { output, fetchedText } of parts) {
		dropped.malformed += output.malformedFindings
		for (const f of output.findings.slice(0, MAX_FINDINGS_PER_RESEARCHER)) {
			if (f.source_type === 'blocked' || isDenylistedUrl(f.url, denylist)) {
				dropped.blocked += 1
				continue
			}
			const key = normalizeUrl(f.url)
			const text = fetchedText.get(key)
			if (text === undefined) {
				dropped.notFetched += 1
				continue
			}
			if (!quoteInText(f.quote, text)) {
				dropped.quoteNotFound += 1
				continue
			}
			let n = numberByUrl.get(key)
			if (n === undefined) {
				n = sources.length + 1
				numberByUrl.set(key, n)
				sources.push({
					n,
					url: f.url,
					title: f.title || f.url,
					publisher: f.publisher,
					date: f.date,
					source_type: effectiveSourceType(f.url, f.source_type),
				})
			}
			findings.push({ n, claim: f.claim, quote: f.quote, confidence: f.confidence })
		}
	}
	return { sources, findings, dropped }
}

export function buildLedger(
	output: ResearcherOutput,
	fetchedText: ReadonlyMap<string, string>,
	denylist?: readonly string[],
): Ledger {
	return buildMergedLedger([{ output, fetchedText }], denylist)
}

/** Share of ledger sources in tier 1 or 2, 0 to 1. Zero when there are no sources. */
export function tier12Share(sources: readonly LedgerSource[]): number {
	if (sources.length === 0) return 0
	return sources.filter((s) => isTier12(s.source_type)).length / sources.length
}

/** Rough token estimate (about 3 characters per token), deliberately on the high side. */
export function estimateTokens(text: string): number {
	return Math.ceil(text.length / 3)
}

/**
 * Drops the lowest-confidence findings until the ledger text fits `maxTokens`.
 * Deterministic: ties keep the earlier finding.
 */
export function fitFindings(
	findings: readonly LedgerFinding[],
	maxTokens: number,
	render: (f: LedgerFinding) => string,
): LedgerFinding[] {
	const order = findings
		.map((f, i) => ({ f, i }))
		.sort((a, b) => b.f.confidence - a.f.confidence || a.i - b.i)
	const kept = new Set<number>()
	let used = 0
	for (const { f, i } of order) {
		const cost = estimateTokens(render(f))
		if (used + cost > maxTokens) continue
		used += cost
		kept.add(i)
	}
	return findings.filter((_, i) => kept.has(i))
}

export interface PostCheckedReport {
	markdown: string
	warnings: string[]
	/** Ledger numbers the report cites. */
	cited: number[]
}

const CITATION_RE = /\[(\d{1,3})\]/g
const DIGIT_RE = /\d/

/**
 * Checks the writer's report against the ledger: strips a [N] that is not a
 * ledger number, lists ledger sources the report never cites, and flags
 * sentences that carry a number but no [N]. The report text is not otherwise
 * rewritten.
 */
export function postCheckReport(
	report: string,
	sources: readonly LedgerSource[],
): PostCheckedReport {
	const valid = new Set(sources.map((s) => s.n))
	const warnings: string[] = []
	let stripped = 0
	// The space before a stripped [N] goes with it, so "see also [9]." reads "see also."
	const markdown = report.replace(/(\s*)\[(\d{1,3})\]/g, (match, _space: string, num: string) => {
		if (valid.has(Number(num))) return match
		stripped += 1
		return ''
	})
	if (stripped > 0)
		warnings.push(`Removed ${stripped} citation(s) that point at no source in the ledger.`)

	const cited = new Set<number>()
	for (const m of markdown.matchAll(CITATION_RE)) cited.add(Number(m[1]))

	const uncited = sources.filter((s) => !cited.has(s.n)).map((s) => s.n)
	if (uncited.length > 0) {
		warnings.push(`Sources read but never cited: ${uncited.map((n) => `[${n}]`).join(', ')}.`)
	}

	// A sentence with a figure and no citation is a claim nobody can check. Headings,
	// list markers and the Sources section are skipped so they do not trip it.
	const body = markdown.split(/^#{1,6}\s*Sources\b/im)[0] ?? markdown
	let uncitedNumbers = 0
	for (const line of body.split('\n')) {
		if (/^\s*#{1,6}\s/.test(line)) continue
		for (const sentence of line.split(/(?<=[.!?])\s+/)) {
			if (DIGIT_RE.test(sentence) && !/\[\d{1,3}\]/.test(sentence)) uncitedNumbers += 1
		}
	}
	if (uncitedNumbers > 0) {
		warnings.push(`${uncitedNumbers} sentence(s) contain a number but no citation.`)
	}
	return { markdown, warnings, cited: [...cited].sort((a, b) => a - b) }
}

export interface MethodInfo {
	effort: string
	researchers: number
	queries: string[]
	sourcesRead: number
	unread: UnreadSource[]
	costCents: number
	capCents: number
	/** Share of ledger sources in tier 1 or 2, 0 to 1 (success criterion 3). */
	tier12Share: number
	sourceCount: number
	/** Searches the workspace-name check refused. A count only, never the names. */
	scrubRejections: number
}

const usd = (cents: number): string => `$${(cents / 100).toFixed(2)}`

/** The Method section code appends to the report (spec 7.1 step 6). */
export function buildMethodSection(info: MethodInfo): string {
	const lines = [
		'## Method',
		`- Effort: ${info.effort} (${info.researchers} researcher${info.researchers === 1 ? '' : 's'})`,
		`- Searches run: ${info.queries.length}${info.queries.length > 0 ? `. Queries: ${info.queries.map((q) => `"${q}"`).join('; ')}` : ''}`,
		`- Sources read: ${info.sourcesRead}`,
		`- Sources not read: ${info.unread.length}${info.unread.length > 0 ? `. ${info.unread.map((u) => `${u.url} (${u.reason})`).join('; ')}` : ''}`,
		`- Tier 1 and 2 sources: ${info.sourceCount > 0 ? `${Math.round(info.tier12Share * 100)}% of ${info.sourceCount}` : 'none'}`,
		`- Searches refused by the workspace-name check: ${info.scrubRejections}`,
		`- Budget used: ${usd(info.costCents)} of a ${usd(info.capCents)} cap`,
	]
	return lines.join('\n')
}
