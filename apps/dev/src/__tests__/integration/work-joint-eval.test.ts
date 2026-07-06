import { randomUUID } from 'node:crypto'
import { objects } from '@maskin/db/schema'
import { and, eq, ilike, or, sql } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'
import {
	WORK_JOINT_CORPUS,
	WORK_JOINT_EVAL_PAIRS,
	type WorkEvalPair,
	type WorkFilterDimension,
	type WorkObjectType,
} from './work-joint-eval-fixture'

// Per-type joint retrieval diagnostic — runs the 30 pairs (10 per bet, task,
// insight) through the current `search_objects` MCP path against a real
// Postgres, records the returned rows, and prints a per-type miss-rate
// breakdown so the parent bet can prove or disprove its central assumption:
// that missing metadata filters — not text-match quality — cap today's
// cross-type retrieval.
//
// Two retrieval paths run per pair, both against the same seeded workspace:
//   1. **search_objects (real).** The exact behaviour of `GET /objects/search`
//      today — whole-question ILIKE against `objects.title` OR
//      `objects.content`, filtered by `type`. Default sort: `createdAt` desc,
//      `id` asc. This is what the DoD asks us to record.
//   2. **Per-token ILIKE baseline.** Matches the parent knowledge-metadata
//      bet's baseline shape from `knowledge-eval.test.ts` — one ILIKE per
//      question token (stopwords stripped), score = token-match count,
//      rank by score desc → title asc. Included so the Product Analyst can
//      pool this fixture into the live joint eval without re-implementing
//      the baseline.
//
// Miss classification (per DoD):
//   - Every pair carries `candidateField` (the field on this type a filter
//     would need) and `hypothesisedAttributable` (Y/N) written into the
//     fixture at design time.
//   - A miss is `attributable = Y` when the pair was designed as a
//     metadata-shaped question (any dimension other than `content_only`).
//     Content-only pairs are the control — a miss there is a text-match
//     problem, not a metadata problem (`N`).
//   - The console report aggregates: per-type hit rate, per-type miss rate,
//     per-type share of misses attributable to a missing metadata filter,
//     and the top field candidates per type.

const STOPWORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'been',
	'but',
	'by',
	'can',
	'could',
	'did',
	'do',
	'does',
	'for',
	'from',
	'has',
	'have',
	'how',
	'i',
	'if',
	'in',
	'into',
	'is',
	'it',
	'its',
	'just',
	'not',
	'of',
	'on',
	'or',
	'over',
	'past',
	'per',
	'should',
	'so',
	'than',
	'that',
	'the',
	'their',
	'them',
	'then',
	'there',
	'they',
	'this',
	'to',
	'up',
	'was',
	'we',
	'were',
	'what',
	'when',
	'where',
	'which',
	'while',
	'who',
	'why',
	'will',
	'with',
	'you',
	'your',
])

function tokenize(text: string): string[] {
	const raw = text
		.toLowerCase()
		.replace(/[^a-z0-9\s_-]+/g, ' ')
		.split(/\s+/)
		.filter(Boolean)
	const seen = new Set<string>()
	const out: string[] = []
	for (const word of raw) {
		if (word.length < 3) continue
		if (STOPWORDS.has(word)) continue
		if (seen.has(word)) continue
		seen.add(word)
		out.push(word)
	}
	return out
}

type Row = { id: string; title: string | null; content: string | null }

type PairContext = {
	pair: WorkEvalPair
	workspaceId: string
	expectedIds: string[]
	trapIds: string[]
}

type PathOutcome = {
	pair: WorkEvalPair
	pathName: 'search_objects' | 'tokenized_ilike'
	hit: 0 | 1
	candidatesReturned: number
	topId: string | null
	topWasTrap: boolean
}

// ── Retrieval paths ────────────────────────────────────────────────────────

/**
 * The exact code path `GET /objects/search` runs today when `type != knowledge`
 * — see `apps/dev/src/routes/objects.ts` search handler and its
 * `buildObjectListConditions` helper. Whole-question ILIKE against title OR
 * content, filtered by workspace + type, ordered by `createdAt` desc.
 */
async function runSearchObjectsReal(
	workspaceId: string,
	type: WorkObjectType,
	question: string,
): Promise<Row[]> {
	const escaped = question.replace(/[%_\\]/g, '\\$&')
	const pattern = `%${escaped}%`
	const textMatch = or(ilike(objects.title, pattern), ilike(objects.content, pattern))
	if (!textMatch) return []

	const rows = (await db
		.select({
			id: objects.id,
			title: objects.title,
			content: objects.content,
		})
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, type), textMatch))
		.orderBy(sql`${objects.createdAt} DESC`, sql`${objects.id} ASC`)
		.limit(10)) as Row[]

	return rows
}

/**
 * Per-token ILIKE baseline that matches the parent knowledge-metadata bet's
 * `runJsonbIlikeBaseline` shape. One ILIKE per question token, score = number
 * of tokens the row matches. Sort by score desc → title asc.
 */
async function runTokenizedIlike(
	workspaceId: string,
	type: WorkObjectType,
	question: string,
): Promise<Row[]> {
	const tokens = tokenize(question)
	if (tokens.length === 0) return []

	const scoreById = new Map<string, { row: Row; score: number }>()
	for (const token of tokens) {
		const escaped = token.replace(/[%_\\]/g, '\\$&')
		const pat = `%${escaped}%`
		const clause = or(ilike(objects.title, pat), ilike(objects.content, pat))
		if (!clause) continue

		const rows = (await db
			.select({
				id: objects.id,
				title: objects.title,
				content: objects.content,
			})
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, type), clause))) as Row[]

		for (const row of rows) {
			const existing = scoreById.get(row.id)
			if (existing) existing.score += 1
			else scoreById.set(row.id, { row, score: 1 })
		}
	}

	return Array.from(scoreById.values())
		.sort((a, b) => {
			if (b.score !== a.score) return b.score - a.score
			return (a.row.title ?? '').localeCompare(b.row.title ?? '')
		})
		.map((c) => c.row)
		.slice(0, 10)
}

// ── Scoring ────────────────────────────────────────────────────────────────

function scoreHitAt1(pair: WorkEvalPair, ctx: PairContext, results: Row[]): PathOutcome['hit'] {
	if (results.length === 0) return 0
	const top = results[0]
	if (!top) return 0
	const expectedSet = new Set(ctx.expectedIds)
	if (!expectedSet.has(top.id)) return 0

	// Excerpt check — top row must actually contain the expected excerpt.
	if (pair.expectedExcerpt) {
		const haystack = `${top.title ?? ''}\n${top.content ?? ''}`.toLowerCase()
		if (!haystack.includes(pair.expectedExcerpt.toLowerCase())) return 0
	}
	return 1
}

function summariseByType(
	outcomes: PathOutcome[],
	pathName: PathOutcome['pathName'],
): {
	lines: string[]
	perTypeMisses: Map<WorkObjectType, PathOutcome[]>
} {
	const lines: string[] = []
	lines.push(`  ${pathName}:`)

	const perType = new Map<WorkObjectType, PathOutcome[]>()
	for (const t of ['bet', 'task', 'insight'] as const) {
		perType.set(
			t,
			outcomes.filter((o) => o.pair.type === t),
		)
	}

	const perTypeMisses = new Map<WorkObjectType, PathOutcome[]>()

	for (const [t, list] of perType) {
		const hits = list.reduce((acc, o) => acc + o.hit, 0)
		const total = list.length
		const misses = list.filter((o) => o.hit === 0)
		perTypeMisses.set(t, misses)

		const missRatePct = total === 0 ? 0 : (misses.length / total) * 100
		const attributable = misses.filter((o) => o.pair.hypothesisedAttributable === 'Y')
		const attrPct = misses.length === 0 ? 0 : (attributable.length / misses.length) * 100

		lines.push(
			`    ${t.padEnd(8)} hit@1 = ${hits}/${total}   miss rate = ${missRatePct.toFixed(0)}%   share of misses attributable to a missing metadata filter = ${attributable.length}/${misses.length} (${attrPct.toFixed(0)}%)`,
		)
	}

	return { lines, perTypeMisses }
}

function candidateFieldRollup(perTypeMisses: Map<WorkObjectType, PathOutcome[]>): string[] {
	const lines: string[] = []
	for (const [t, misses] of perTypeMisses) {
		const attributable = misses.filter((m) => m.pair.hypothesisedAttributable === 'Y')
		if (attributable.length === 0) {
			lines.push(`    ${t.padEnd(8)} <no attributable misses>`)
			continue
		}
		const counts = new Map<string, { count: number; dimensions: Set<WorkFilterDimension> }>()
		for (const miss of attributable) {
			const field = miss.pair.candidateField
			if (field === null) continue
			const cur = counts.get(field) ?? { count: 0, dimensions: new Set() }
			cur.count += 1
			cur.dimensions.add(miss.pair.dimension)
			counts.set(field, cur)
		}
		const rollup = Array.from(counts.entries())
			.sort((a, b) => b[1].count - a[1].count)
			.map(
				([field, meta]) => `${field} (×${meta.count} — ${Array.from(meta.dimensions).join('/')})`,
			)
			.join(', ')
		lines.push(`    ${t.padEnd(8)} ${rollup}`)
	}
	return lines
}

function perPairTable(outcomes: PathOutcome[]): string[] {
	const lines: string[] = []
	lines.push(
		`    ${'pair'.padEnd(6)} ${'type'.padEnd(8)} ${'dimension'.padEnd(20)} ${'hit'.padEnd(5)} ${'top'.padEnd(28)} ${'candidateField'.padEnd(24)} attributable`,
	)
	for (const o of outcomes) {
		const hit = o.hit === 1 ? 'HIT' : 'MISS'
		const topLabel = o.topId ? (o.topWasTrap ? '<trap>' : '<expected>') : '<empty>'
		const candidate = o.pair.candidateField ?? '-'
		const attr = o.hit === 1 ? '-' : o.pair.hypothesisedAttributable === 'Y' ? 'Y' : 'N'
		lines.push(
			`    ${o.pair.pairId.padEnd(6)} ${o.pair.type.padEnd(8)} ${o.pair.dimension.padEnd(20)} ${hit.padEnd(5)} ${topLabel.padEnd(28)} ${candidate.padEnd(24)} ${attr}`,
		)
	}
	return lines
}

// ── Test ────────────────────────────────────────────────────────────────────

describe('Per-type joint retrieval diagnostic (bet / task / insight)', () => {
	it('runs the 30 per-type pairs through search_objects and records per-type miss rates + top field candidates', async () => {
		// Seed one workspace per pair — matches the metadata-10 topology from the
		// parent knowledge-metadata bet: peripheral ILIKE bleed from other pairs'
		// trap rows would poison the per-pair signal.
		const workspaceCorpusById = new Map(WORK_JOINT_CORPUS.map((c) => [c.fixtureId, c]))
		const contexts: PairContext[] = []

		for (const pair of WORK_JOINT_EVAL_PAIRS) {
			const actor = await insertActor(db, {
				name: `Work Eval Actor ${pair.pairId}`,
				email: `work-eval-${pair.pairId.toLowerCase()}@test.com`,
			})
			const workspace = await insertWorkspace(db, actor.id, {
				name: `Work Joint Eval Workspace ${pair.pairId}`,
			})

			const fixtureIds = new Set<string>([...pair.expectedFixtureIds, ...pair.trapFixtureIds])
			const expectedIds: string[] = []
			const trapIds: string[] = []
			const rows: Array<{
				id: string
				workspaceId: string
				type: string
				title: string
				content: string
				status: string
				metadata: null
				createdBy: string
			}> = []

			for (const fixtureId of fixtureIds) {
				const entry = workspaceCorpusById.get(fixtureId)
				if (!entry) throw new Error(`fixtureId not in corpus: ${fixtureId}`)
				const id = randomUUID()
				if (pair.expectedFixtureIds.includes(fixtureId)) expectedIds.push(id)
				if (pair.trapFixtureIds.includes(fixtureId)) trapIds.push(id)
				rows.push({
					id,
					workspaceId: workspace.id,
					type: entry.type,
					title: entry.title,
					content: entry.content,
					status: 'active',
					metadata: null,
					createdBy: actor.id,
				})
			}

			await db.insert(objects).values(rows)

			contexts.push({
				pair,
				workspaceId: workspace.id,
				expectedIds,
				trapIds,
			})
		}

		// ── Run both paths per pair. ──
		const searchOutcomes: PathOutcome[] = []
		const tokenizedOutcomes: PathOutcome[] = []

		for (const ctx of contexts) {
			const { pair } = ctx

			const searchRows = await runSearchObjectsReal(ctx.workspaceId, pair.type, pair.question)
			const searchHit = scoreHitAt1(pair, ctx, searchRows)
			searchOutcomes.push({
				pair,
				pathName: 'search_objects',
				hit: searchHit,
				candidatesReturned: searchRows.length,
				topId: searchRows[0]?.id ?? null,
				topWasTrap: searchRows[0] ? ctx.trapIds.includes(searchRows[0].id) : false,
			})

			const tokRows = await runTokenizedIlike(ctx.workspaceId, pair.type, pair.question)
			const tokHit = scoreHitAt1(pair, ctx, tokRows)
			tokenizedOutcomes.push({
				pair,
				pathName: 'tokenized_ilike',
				hit: tokHit,
				candidatesReturned: tokRows.length,
				topId: tokRows[0]?.id ?? null,
				topWasTrap: tokRows[0] ? ctx.trapIds.includes(tokRows[0].id) : false,
			})
		}

		// ── Build the joint report. ──
		const lines: string[] = []
		lines.push('')
		lines.push(
			'=== Per-type joint retrieval diagnostic — bet / task / insight (n=30, 10 per type) ===',
		)
		lines.push('')
		lines.push(
			'--- Path 1: search_objects (real — whole-question ILIKE on title/content, type-filtered) ---',
		)
		const searchSummary = summariseByType(searchOutcomes, 'search_objects')
		lines.push(...searchSummary.lines)
		lines.push('')
		lines.push('  Top field candidates per type (rollup of attributable misses):')
		lines.push(...candidateFieldRollup(searchSummary.perTypeMisses))
		lines.push('')
		lines.push('--- Path 2: tokenized ILIKE baseline (T1-shape, matches parent bet fixture) ---')
		const tokenizedSummary = summariseByType(tokenizedOutcomes, 'tokenized_ilike')
		lines.push(...tokenizedSummary.lines)
		lines.push('')
		lines.push('  Top field candidates per type (rollup of attributable misses):')
		lines.push(...candidateFieldRollup(tokenizedSummary.perTypeMisses))
		lines.push('')
		lines.push('--- Per-pair table (search_objects path) ---')
		lines.push(...perPairTable(searchOutcomes))
		lines.push('')
		lines.push('--- Per-pair table (tokenized ILIKE path) ---')
		lines.push(...perPairTable(tokenizedOutcomes))
		lines.push('')

		// Parent-bet threshold: if <70% of misses per type map to a missing
		// metadata filter, the per-type-sidecar framing needs a re-scope.
		lines.push('--- Scope-check judgment (parent bet threshold ≥70% attributable per type) ---')
		let scopeVerdict: 'PASS' | 'RE-SCOPE' = 'PASS'
		for (const [t, misses] of searchSummary.perTypeMisses) {
			if (misses.length === 0) {
				lines.push(`    ${t.padEnd(8)} <no misses — nothing to attribute>`)
				continue
			}
			const attributable = misses.filter((m) => m.pair.hypothesisedAttributable === 'Y')
			const attrShare = attributable.length / misses.length
			const marker = attrShare >= 0.7 ? 'PASS' : 'RE-SCOPE'
			if (marker === 'RE-SCOPE') scopeVerdict = 'RE-SCOPE'
			lines.push(
				`    ${t.padEnd(8)} attributable share = ${(attrShare * 100).toFixed(0)}% → ${marker}`,
			)
		}
		lines.push(`    overall: ${scopeVerdict}`)
		lines.push('')

		console.log(lines.join('\n'))

		// ── Structural assertions — the diagnostic must produce a value for every
		// pair on both paths and no silent no-op. This is a diagnostic run, not a
		// gate: the value lives in the printed report, not in a per-pair
		// pass/fail. Assertions only guard against harness bugs (no lost rows,
		// no missing outcomes).
		expect(searchOutcomes).toHaveLength(WORK_JOINT_EVAL_PAIRS.length)
		expect(tokenizedOutcomes).toHaveLength(WORK_JOINT_EVAL_PAIRS.length)
		for (const o of [...searchOutcomes, ...tokenizedOutcomes]) {
			expect(o.hit === 0 || o.hit === 1).toBe(true)
		}
		for (const ctx of contexts) {
			const [{ seeded }] = await db
				.select({ seeded: sql<number>`count(*)::int` })
				.from(objects)
				.where(and(eq(objects.workspaceId, ctx.workspaceId), eq(objects.type, ctx.pair.type)))
			const expectedCount = new Set<string>([
				...ctx.pair.expectedFixtureIds,
				...ctx.pair.trapFixtureIds,
			]).size
			expect(seeded).toBe(expectedCount)
		}
	})
})
