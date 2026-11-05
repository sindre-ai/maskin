// Pure helpers for research-eval.ts (question list, run normalising, CSV, blind sets).
// Kept free of I/O so they can be unit tested.

export type Effort = 'simple' | 'comparison' | 'broad'

export const EFFORTS: readonly Effort[] = ['simple', 'comparison', 'broad']

export interface EvalQuestion {
	question: string
	effort: Effort
	/** Session id of the Researcher run that produced the baseline brief. */
	original_session_id: string
	context?: string
	max_cost_usd?: number
	/** Optional path to the baseline brief, so it joins the blind set next to the tool report. */
	baseline_report?: string
}

/** One finished (or failed) run, flattened to what the results CSV records. */
export interface RunRecord {
	index: number
	effort: Effort
	original_session_id: string
	research_id: string
	status: string
	capped: boolean
	cap_cents: number | null
	cost_cents: number | null
	over_cap_5pct: boolean
	tokens_in: number | null
	tokens_out: number | null
	searches: number | null
	extracts: number | null
	wall_clock_s: number | null
	researchers: number | null
	tier12_share: number | null
	warnings: string[]
	error: string
	report_md: string
}

type Json = Record<string, unknown>

function isRecord(v: unknown): v is Json {
	return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function parseQuestions(raw: unknown): EvalQuestion[] {
	if (!Array.isArray(raw) || raw.length === 0) {
		throw new Error('Question list must be a non-empty JSON array')
	}
	return raw.map((item, i) => {
		if (!isRecord(item)) throw new Error(`Question ${i + 1}: expected an object`)
		const { question, effort, original_session_id, context, max_cost_usd, baseline_report } = item
		if (typeof question !== 'string' || question.trim() === '' || question.length > 2000) {
			throw new Error(`Question ${i + 1}: "question" must be a string of 1 to 2000 characters`)
		}
		if (typeof effort !== 'string' || !EFFORTS.includes(effort as Effort)) {
			throw new Error(`Question ${i + 1}: "effort" must be one of ${EFFORTS.join(', ')}`)
		}
		if (typeof original_session_id !== 'string' || original_session_id === '') {
			throw new Error(`Question ${i + 1}: "original_session_id" is required`)
		}
		if (context !== undefined && (typeof context !== 'string' || context.length > 2000)) {
			throw new Error(`Question ${i + 1}: "context" must be a string of at most 2000 characters`)
		}
		if (max_cost_usd !== undefined && (typeof max_cost_usd !== 'number' || max_cost_usd <= 0)) {
			throw new Error(`Question ${i + 1}: "max_cost_usd" must be a positive number`)
		}
		if (baseline_report !== undefined && typeof baseline_report !== 'string') {
			throw new Error(`Question ${i + 1}: "baseline_report" must be a file path`)
		}
		return {
			question,
			effort: effort as Effort,
			original_session_id,
			context,
			max_cost_usd,
			baseline_report,
		}
	})
}

/** Spec section 12: 3 simple, 4 comparison, 3 broad. Returns problems, empty if the mix is right. */
export function checkMix(questions: EvalQuestion[]): string[] {
	const count = (e: Effort) => questions.filter((q) => q.effort === e).length
	const problems: string[] = []
	if (questions.length !== 10) problems.push(`expected 10 questions, got ${questions.length}`)
	if (count('simple') !== 3) problems.push(`expected 3 simple, got ${count('simple')}`)
	if (count('comparison') !== 4) problems.push(`expected 4 comparison, got ${count('comparison')}`)
	if (count('broad') !== 3) problems.push(`expected 3 broad, got ${count('broad')}`)
	return problems
}

function num(...candidates: unknown[]): number | null {
	for (const c of candidates) {
		if (typeof c === 'number' && Number.isFinite(c)) return c
	}
	return null
}

/**
 * Share of sources in tier 1 or 2 (spec 7.5). The route's own tier12_share wins; otherwise
 * count sources that carry a numeric tier. Null when neither is available.
 */
function tierShare(run: Json, sources: unknown): number | null {
	const direct = num(run.tier12_share)
	if (direct !== null) return direct
	if (!Array.isArray(sources) || sources.length === 0) return null
	const tiered = sources.filter((s) => isRecord(s) && typeof s.tier === 'number')
	if (tiered.length === 0) return null
	const good = tiered.filter((s) => isRecord(s) && (s.tier === 1 || s.tier === 2)).length
	return good / sources.length
}

/**
 * Flatten a GET /api/research/:id response (spec 7.7: status, report_md, sources, usage, cap,
 * warnings) into a RunRecord. Field names follow the research_runs columns; usage figures may
 * sit at the top level or inside "usage". If the route names differ, this is the one place to fix.
 */
export function normalizeRun(
	q: EvalQuestion,
	index: number,
	researchId: string,
	raw: Json,
	localWallClockS: number,
): RunRecord {
	const usage = isRecord(raw.usage) ? raw.usage : raw
	const cap = isRecord(raw.cap) ? raw.cap : {}
	const capCents = num(raw.cap_cents, cap.cap_cents, usage.cap_cents)
	const costCents = num(usage.cost_cents, raw.cost_cents)
	const started = typeof raw.started_at === 'string' ? Date.parse(raw.started_at) : Number.NaN
	const finished = typeof raw.finished_at === 'string' ? Date.parse(raw.finished_at) : Number.NaN
	const serverWallClock =
		Number.isNaN(started) || Number.isNaN(finished) ? null : (finished - started) / 1000
	const brief = isRecord(raw.brief) ? raw.brief : {}
	const subtopics = Array.isArray(brief.subtopics) ? brief.subtopics.length : null
	const status = typeof raw.status === 'string' ? raw.status : 'unknown'
	return {
		index,
		effort: q.effort,
		original_session_id: q.original_session_id,
		research_id: researchId,
		status,
		capped: status === 'capped',
		cap_cents: capCents,
		cost_cents: costCents,
		over_cap_5pct: capCents !== null && costCents !== null && costCents > capCents * 1.05,
		tokens_in: num(usage.tokens_in, raw.tokens_in),
		tokens_out: num(usage.tokens_out, raw.tokens_out),
		searches: num(usage.searches, raw.searches),
		extracts: num(usage.extracts, raw.extracts),
		wall_clock_s: serverWallClock ?? localWallClockS,
		researchers:
			num(raw.researchers, usage.researchers) ?? subtopics ?? (q.effort === 'simple' ? 1 : null),
		tier12_share: tierShare(raw, raw.sources),
		warnings: Array.isArray(raw.warnings) ? raw.warnings.map((w) => String(w)) : [],
		error: typeof raw.error === 'string' ? raw.error : '',
		report_md: typeof raw.report_md === 'string' ? raw.report_md : '',
	}
}

/** A run that never produced a row (POST refused, timed out locally). */
export function failedRun(
	q: EvalQuestion,
	index: number,
	researchId: string,
	status: string,
	error: string,
	localWallClockS: number,
): RunRecord {
	return {
		...normalizeRun(q, index, researchId, { status, error }, localWallClockS),
		researchers: null,
	}
}

export const CSV_COLUMNS = [
	'index',
	'blind_id',
	'effort',
	'original_session_id',
	'research_id',
	'status',
	'capped',
	'cap_usd',
	'cost_usd',
	'over_cap_5pct',
	'tokens_in',
	'tokens_out',
	'searches',
	'extracts',
	'wall_clock_s',
	'researchers',
	'tier12_share',
	'warnings',
	'error',
] as const

function csvCell(value: string | number | boolean | null): string {
	if (value === null) return ''
	const s = String(value)
	return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

const usd = (cents: number | null) => (cents === null ? null : Number((cents / 100).toFixed(4)))

export function buildCsv(runs: RunRecord[], blindIds: Map<number, string>): string {
	const rows = runs.map((r) => {
		const cells: Record<(typeof CSV_COLUMNS)[number], string | number | boolean | null> = {
			index: r.index,
			blind_id: blindIds.get(r.index) ?? '',
			effort: r.effort,
			original_session_id: r.original_session_id,
			research_id: r.research_id,
			status: r.status,
			capped: r.capped,
			cap_usd: usd(r.cap_cents),
			cost_usd: usd(r.cost_cents),
			over_cap_5pct: r.over_cap_5pct,
			tokens_in: r.tokens_in,
			tokens_out: r.tokens_out,
			searches: r.searches,
			extracts: r.extracts,
			wall_clock_s: r.wall_clock_s === null ? null : Number(r.wall_clock_s.toFixed(1)),
			researchers: r.researchers,
			tier12_share: r.tier12_share === null ? null : Number(r.tier12_share.toFixed(3)),
			warnings: r.warnings.join(' | '),
			error: r.error,
		}
		return CSV_COLUMNS.map((c) => csvCell(cells[c])).join(',')
	})
	return `${[CSV_COLUMNS.join(','), ...rows].join('\n')}\n`
}

/** Small seeded PRNG so a shuffle can be reproduced from the seed. */
function mulberry32(seed: number): () => number {
	let a = seed >>> 0
	return () => {
		a = (a + 0x6d2b79f5) >>> 0
		let t = a
		t = Math.imul(t ^ (t >>> 15), t | 1)
		t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296
	}
}

export interface BlindEntry {
	blind_id: string
	arm: 'tool' | 'baseline'
	index: number
}

/**
 * Shuffle every report (tool arm, plus baseline briefs where a file was given) and give each a
 * neutral id like R01. The returned key says which is which; keep it away from the scorer.
 */
export function assignBlindIds(
	items: { arm: 'tool' | 'baseline'; index: number }[],
	seed: number,
): BlindEntry[] {
	const order = [...items]
	const rand = mulberry32(seed)
	for (let i = order.length - 1; i > 0; i--) {
		const j = Math.floor(rand() * (i + 1))
		const a = order[i] as (typeof order)[number]
		order[i] = order[j] as (typeof order)[number]
		order[j] = a
	}
	const width = Math.max(2, String(order.length).length)
	return order.map((item, i) => ({
		blind_id: `R${String(i + 1).padStart(width, '0')}`,
		arm: item.arm,
		index: item.index,
	}))
}
