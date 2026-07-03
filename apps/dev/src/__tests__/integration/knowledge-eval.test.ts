import { randomUUID } from 'node:crypto'
import { objects } from '@maskin/db/schema'
import { knowledgeExtras } from '@maskin/ext-knowledge/db-schema'
import { retrieveKnowledge } from '@maskin/ext-knowledge/retrieval'
import { and, eq, ilike, or, sql } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'
import {
	EVAL_PAIRS,
	KNOWLEDGE_CORPUS,
	METADATA_EVAL_PAIRS,
	METADATA_KNOWLEDGE_CORPUS,
	type MetadataDimension,
} from './knowledge-eval-fixture'

// Joint cited-answer eval — runs the 30 content-lookup pairs (T1) and
// the 10 metadata-filter pairs (T5 spec) through both retrieval paths:
// JSONB-ILIKE (today's baseline) and `retrieveKnowledge()` (column-aware,
// post-migration).
//
// Seeding topology:
//   - content-30 lives in one shared workspace — the shared corpus is the
//     point (ranking under a realistic 30-row search surface).
//   - metadata-10 seeds one fresh workspace per pair, containing only that
//     pair's expected + trap rows. The T5 spec calibrated each pair against
//     its own trap set; peripheral ILIKE bleed from other pairs' rows (e.g.
//     U1's "on-call" leaking into V3's query) is a joint-seed artifact of
//     T6's harness, not a retrieval-mechanism gap. Isolation matches the
//     calibration without touching retrieval.
//
// Split reporting per the Strategist's lock-in:
//   - content-30: legibility number, not a kill gate
//   - metadata-10: gate — ≥80% (8/10) = pass, <80% = kill trigger
// Per-dimension breakdown on metadata-10 (recency / un_superseded /
// confidence / verification_status) so the dimensions the promoted columns
// don't yet unlock are visible in the same run.
//
// Empty-return scoring: a pair with `expectedFixtureIds: []` (V3) is a hit
// when retrieval returns zero candidates — no citation is the correct answer
// when every ILIKE match is filtered out by metadata.

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

type UnifiedPair = {
	subset: 'content-30' | 'metadata-10'
	pairId: string
	question: string
	expectedIds: string[]
	expectedExcerpt: string | null
	dimension: MetadataDimension | null
}

type Outcome = {
	pair: UnifiedPair
	retrievalHit: 0 | 1
	citedAnswerHit: 0 | 1
	candidatesReturned: number
	topId: string | null
}

async function runJsonbIlikeBaseline(workspaceId: string, question: string): Promise<Row[]> {
	const tokens = tokenize(question)
	if (tokens.length === 0) return []

	const scoreById = new Map<string, { row: Row; score: number }>()
	const clauses = tokens.map((t) => {
		const escaped = t.replace(/[%_\\]/g, '\\$&')
		const pattern = `%${escaped}%`
		return or(ilike(objects.title, pattern), ilike(objects.content, pattern))
	})

	for (const clause of clauses) {
		const rows = (await db
			.select({
				id: objects.id,
				title: objects.title,
				content: objects.content,
			})
			.from(objects)
			.where(
				and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'knowledge'), clause),
			)) as Row[]

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
}

function scorePair(pair: UnifiedPair, results: Row[]): Outcome {
	const expectedIds = new Set(pair.expectedIds)
	const isEmptyExpected = expectedIds.size === 0

	const topTen = results.slice(0, 10).map((r) => r.id)
	const top = results[0]

	// Retrieval hit @10.
	let retrievalHit: 0 | 1
	if (isEmptyExpected) {
		retrievalHit = results.length === 0 ? 1 : 0
	} else {
		retrievalHit = topTen.some((id) => expectedIds.has(id)) ? 1 : 0
	}

	// Cited-answer hit @1.
	let citedAnswerHit: 0 | 1 = 0
	if (isEmptyExpected) {
		citedAnswerHit = results.length === 0 ? 1 : 0
	} else if (top) {
		const topHaystack = `${top.title ?? ''}\n${top.content ?? ''}`.toLowerCase()
		const idHit = expectedIds.has(top.id)
		const excerptHit = pair.expectedExcerpt
			? topHaystack.includes(pair.expectedExcerpt.toLowerCase())
			: true
		citedAnswerHit = idHit && excerptHit ? 1 : 0
	}

	return {
		pair,
		retrievalHit,
		citedAnswerHit,
		candidatesReturned: results.length,
		topId: top?.id ?? null,
	}
}

function summarise(
	outcomes: Outcome[],
	label: string,
): {
	retrievalCorrect: number
	citedCorrect: number
	total: number
	block: string[]
} {
	const total = outcomes.length
	const retrievalCorrect = outcomes.reduce((acc, o) => acc + o.retrievalHit, 0)
	const citedCorrect = outcomes.reduce((acc, o) => acc + o.citedAnswerHit, 0)
	const retrievalPct = total === 0 ? 0 : (retrievalCorrect / total) * 100
	const citedPct = total === 0 ? 0 : (citedCorrect / total) * 100

	const misses = outcomes.filter((o) => o.citedAnswerHit === 0)
	const block: string[] = []
	block.push(`  ${label}:`)
	block.push(`    retrieval@10:    ${retrievalCorrect}/${total} = ${retrievalPct.toFixed(1)}%`)
	block.push(`    cited-answer@1:  ${citedCorrect}/${total} = ${citedPct.toFixed(1)}%`)
	if (misses.length > 0) {
		block.push(`    cited-answer misses (${misses.length}):`)
		for (const m of misses) {
			block.push(
				`      - [${m.pair.pairId}] top=${m.topId ?? '<empty>'} candidates=${m.candidatesReturned}`,
			)
			block.push(`        q: ${m.pair.question}`)
		}
	}
	return { retrievalCorrect, citedCorrect, total, block }
}

function perDimensionBreakdown(outcomes: Outcome[]): string[] {
	const lines: string[] = []
	const dims: MetadataDimension[] = [
		'recency',
		'un_superseded',
		'confidence',
		'verification_status',
	]
	for (const dim of dims) {
		const inDim = outcomes.filter((o) => o.pair.dimension === dim)
		if (inDim.length === 0) continue
		const hits = inDim.reduce((acc, o) => acc + o.citedAnswerHit, 0)
		lines.push(`      ${dim.padEnd(20)} ${hits}/${inDim.length}`)
		for (const o of inDim) {
			const mark = o.citedAnswerHit ? 'PASS' : 'MISS'
			lines.push(`        ${mark} ${o.pair.pairId} — ${o.pair.question}`)
		}
	}
	return lines
}

describe('Knowledge cited-answer eval — joint (content-30 + metadata-10)', () => {
	it('runs the joint fixture through JSONB-ILIKE baseline and column-aware retrieval and reports split accuracy', async () => {
		const contentActor = await insertActor(db, { name: 'Eval Actor', email: 'eval@test.com' })
		const contentWorkspace = await insertWorkspace(db, contentActor.id, {
			name: 'Content-30 Eval Workspace',
		})

		// ── Seed content-30 rows with baseline metadata (verified/high/live). ──
		const contentIdByFixture = new Map<string, string>()
		const contentSeedRows = KNOWLEDGE_CORPUS.map((entry) => {
			const id = randomUUID()
			contentIdByFixture.set(entry.fixtureId, id)
			return {
				id,
				workspaceId: contentWorkspace.id,
				type: 'knowledge',
				title: entry.title,
				content: entry.content,
				status: 'validated',
				metadata: null,
				createdBy: contentActor.id,
			}
		})
		await db.insert(objects).values(contentSeedRows)

		const now = new Date()
		const dayMs = 86_400_000

		// content-30 extras — matches T4's defaults.
		const contentExtras = contentSeedRows.map((row) => ({
			objectId: row.id,
			workspaceId: contentWorkspace.id,
			tValid: now,
			tInvalid: null as Date | null,
			confidence: 'high',
			verificationStatus: 'verified',
			writerType: 'agent',
			provenanceType: 'imported',
			provenanceRef: null,
		}))
		await db.insert(knowledgeExtras).values(contentExtras)

		// ── Seed metadata-10 rows into one fresh workspace per pair. ──
		// Isolation prevents peripheral ILIKE matches from other pairs' rows
		// (e.g. U1's "on-call" leaking into V3's query) from surviving the
		// deprecated exclusion. Each pair is calibrated against its own trap
		// set per T5; joint-workspace seeding under-specified that contract.
		const metadataCorpusById = new Map(METADATA_KNOWLEDGE_CORPUS.map((c) => [c.fixtureId, c]))
		type MetadataPairContext = {
			workspaceId: string
			idByFixture: Map<string, string>
		}
		const metadataContextByPair = new Map<string, MetadataPairContext>()

		for (const pair of METADATA_EVAL_PAIRS) {
			const actor = await insertActor(db, {
				name: `Eval Actor ${pair.pairId}`,
				email: `eval-${pair.pairId.toLowerCase()}@test.com`,
			})
			const workspace = await insertWorkspace(db, actor.id, {
				name: `Metadata Eval Workspace ${pair.pairId}`,
			})

			const pairFixtureIds = new Set<string>([...pair.expectedFixtureIds, ...pair.trapFixtureIds])
			const idByFixture = new Map<string, string>()
			const objectRows: Array<{
				id: string
				workspaceId: string
				type: string
				title: string
				content: string
				status: string
				metadata: null
				createdBy: string
			}> = []
			for (const fixtureId of pairFixtureIds) {
				const entry = metadataCorpusById.get(fixtureId)
				if (!entry) throw new Error(`fixtureId not in corpus: ${fixtureId}`)
				const id = randomUUID()
				idByFixture.set(fixtureId, id)
				objectRows.push({
					id,
					workspaceId: workspace.id,
					type: 'knowledge',
					title: entry.title,
					content: entry.content,
					status: 'validated',
					metadata: null,
					createdBy: actor.id,
				})
			}
			await db.insert(objects).values(objectRows)

			const extrasRows = Array.from(pairFixtureIds).map((fixtureId) => {
				const entry = metadataCorpusById.get(
					fixtureId,
				) as (typeof METADATA_KNOWLEDGE_CORPUS)[number]
				const objectId = idByFixture.get(fixtureId) as string
				return {
					objectId,
					workspaceId: workspace.id,
					tValid: new Date(now.getTime() + entry.tValidOffsetDays * dayMs),
					tInvalid:
						entry.tInvalidOffsetDays === null
							? null
							: new Date(now.getTime() + entry.tInvalidOffsetDays * dayMs),
					confidence: entry.confidence,
					verificationStatus: entry.verificationStatus,
					writerType: 'agent',
					provenanceType: 'imported',
					provenanceRef: null,
				}
			})
			await db.insert(knowledgeExtras).values(extrasRows)

			metadataContextByPair.set(pair.pairId, {
				workspaceId: workspace.id,
				idByFixture,
			})
		}

		// ── Build the unified pair list for both retrieval paths. ──
		const contentPairs: Array<UnifiedPair & { workspaceId: string }> = EVAL_PAIRS.map((p) => ({
			subset: 'content-30',
			pairId: p.expectedFixtureId,
			question: p.question,
			expectedIds: [contentIdByFixture.get(p.expectedFixtureId) as string],
			expectedExcerpt: p.expectedExcerpt,
			dimension: null,
			workspaceId: contentWorkspace.id,
		}))
		const metadataPairs: Array<UnifiedPair & { workspaceId: string }> = METADATA_EVAL_PAIRS.map(
			(p) => {
				const ctx = metadataContextByPair.get(p.pairId)
				if (!ctx) throw new Error(`no metadata context for pair ${p.pairId}`)
				return {
					subset: 'metadata-10',
					pairId: p.pairId,
					question: p.question,
					expectedIds: p.expectedFixtureIds.map((id) => ctx.idByFixture.get(id) as string),
					expectedExcerpt: p.expectedExcerpt,
					dimension: p.dimension,
					workspaceId: ctx.workspaceId,
				}
			},
		)
		const allPairs = [...contentPairs, ...metadataPairs]

		// ── Run both retrieval paths for every pair against its own workspace. ──
		const baselineOutcomes: Outcome[] = []
		const columnAwareOutcomes: Outcome[] = []

		for (const pair of allPairs) {
			const baselineRows = await runJsonbIlikeBaseline(pair.workspaceId, pair.question)
			baselineOutcomes.push(scorePair(pair, baselineRows))

			const colRows = (await retrieveKnowledge(db, {
				workspaceId: pair.workspaceId,
				q: pair.question,
				limit: 10,
				offset: 0,
			})) as Row[]
			columnAwareOutcomes.push(scorePair(pair, colRows))
		}

		// ── Split by subset. ──
		const baselineContent = baselineOutcomes.filter((o) => o.pair.subset === 'content-30')
		const baselineMeta = baselineOutcomes.filter((o) => o.pair.subset === 'metadata-10')
		const colContent = columnAwareOutcomes.filter((o) => o.pair.subset === 'content-30')
		const colMeta = columnAwareOutcomes.filter((o) => o.pair.subset === 'metadata-10')

		const baseContentSummary = summarise(baselineContent, 'content-30 (n=30)')
		const baseMetaSummary = summarise(baselineMeta, 'metadata-10 (n=10)')
		const colContentSummary = summarise(colContent, 'content-30 (n=30)')
		const colMetaSummary = summarise(colMeta, 'metadata-10 (n=10)')

		// ── Print the joint report. ──
		const lines: string[] = []
		lines.push('')
		lines.push('=== Knowledge cited-answer eval — joint (content-30 + metadata-10) ===')
		lines.push(
			`corpus size (total):    ${KNOWLEDGE_CORPUS.length + METADATA_KNOWLEDGE_CORPUS.length}`,
		)
		lines.push(`  content-30 seeds:     ${KNOWLEDGE_CORPUS.length} (shared workspace)`)
		lines.push(
			`  metadata-10 seeds:    ${METADATA_KNOWLEDGE_CORPUS.length} (expected + trap rows, one workspace per pair)`,
		)
		lines.push('')
		lines.push('--- JSONB-ILIKE baseline (T1-equivalent ILIKE path) ---')
		lines.push(...baseContentSummary.block)
		lines.push(...baseMetaSummary.block)
		lines.push('')
		lines.push('--- Column-aware retrieveKnowledge() (post-migration path) ---')
		lines.push(...colContentSummary.block)
		lines.push(...colMetaSummary.block)
		lines.push('')
		lines.push('--- metadata-10 per-dimension breakdown (column-aware) ---')
		lines.push(...perDimensionBreakdown(colMeta))
		lines.push('')
		lines.push('--- Kill-trigger judgment (rides on metadata-10 alone) ---')
		const metaCitedCorrect = colMetaSummary.citedCorrect
		const metaTotal = colMetaSummary.total
		const gate = metaCitedCorrect / metaTotal >= 0.8 ? 'PASS' : 'KILL'
		lines.push(
			`    metadata-10 cited-answer@1 = ${metaCitedCorrect}/${metaTotal} → ${gate} (≥80% = pass, <80% = kill trigger)`,
		)
		lines.push('')
		console.log(lines.join('\n'))

		// ── Structural assertions — every pair scored 0/1 on both metrics. ──
		expect(baselineOutcomes).toHaveLength(allPairs.length)
		expect(columnAwareOutcomes).toHaveLength(allPairs.length)
		for (const o of [...baselineOutcomes, ...columnAwareOutcomes]) {
			expect(o.retrievalHit === 0 || o.retrievalHit === 1).toBe(true)
			expect(o.citedAnswerHit === 0 || o.citedAnswerHit === 1).toBe(true)
		}

		// content-30 workspace holds the full 30-row corpus; each metadata
		// pair's isolated workspace holds only its expected + trap rows.
		const [{ seeded: contentSeeded }] = await db
			.select({ seeded: sql<number>`count(*)::int` })
			.from(objects)
			.where(and(eq(objects.workspaceId, contentWorkspace.id), eq(objects.type, 'knowledge')))
		expect(contentSeeded).toBe(KNOWLEDGE_CORPUS.length)

		for (const pair of METADATA_EVAL_PAIRS) {
			const ctx = metadataContextByPair.get(pair.pairId)
			if (!ctx) throw new Error(`no metadata context for pair ${pair.pairId}`)
			const [{ seeded }] = await db
				.select({ seeded: sql<number>`count(*)::int` })
				.from(objects)
				.where(and(eq(objects.workspaceId, ctx.workspaceId), eq(objects.type, 'knowledge')))
			const expectedCount = new Set<string>([...pair.expectedFixtureIds, ...pair.trapFixtureIds])
				.size
			expect(seeded).toBe(expectedCount)
		}
	})

	it('excludes rows with t_invalid set (bi-temporal live-only)', async () => {
		const actor = await insertActor(db, { name: 'Invalidation Actor', email: 'invalid@test.com' })
		const workspace = await insertWorkspace(db, actor.id, { name: 'Invalidation Workspace' })

		const liveId = randomUUID()
		const invalidatedId = randomUUID()
		await db.insert(objects).values([
			{
				id: liveId,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: 'MCP tool response trimming defaults',
				content: 'The ecosystem has converged on field projection.',
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			},
			{
				id: invalidatedId,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: 'MCP tool response defaults (superseded)',
				content: 'Older take on field projection — kept for audit.',
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			},
		])
		await db.insert(knowledgeExtras).values([
			{
				objectId: liveId,
				workspaceId: workspace.id,
				tValid: new Date(),
				tInvalid: null,
				confidence: 'high',
				verificationStatus: 'verified',
				writerType: 'agent',
				provenanceType: 'imported',
				provenanceRef: null,
			},
			{
				objectId: invalidatedId,
				workspaceId: workspace.id,
				tValid: new Date(),
				tInvalid: new Date(),
				confidence: 'high',
				verificationStatus: 'verified',
				writerType: 'agent',
				provenanceType: 'imported',
				provenanceRef: null,
			},
		])

		const results = await retrieveKnowledge(db, {
			workspaceId: workspace.id,
			q: 'MCP tool response defaults projection',
			limit: 10,
			offset: 0,
		})

		const ids = results.map((r) => r.id)
		expect(ids).toContain(liveId)
		expect(ids).not.toContain(invalidatedId)
	})

	it('ranks higher verification and confidence above lower ones when multiple rows match', async () => {
		const actor = await insertActor(db, { name: 'Ranking Actor', email: 'ranking@test.com' })
		const workspace = await insertWorkspace(db, actor.id, { name: 'Ranking Workspace' })

		const highId = randomUUID()
		const lowId = randomUUID()
		await db.insert(objects).values([
			{
				id: lowId,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: 'Retrieval ranking — early note',
				content: 'Draft claim about retrieval ranking behaviour.',
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			},
			{
				id: highId,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: 'Retrieval ranking — confirmed pattern',
				content: 'Verified claim about retrieval ranking behaviour.',
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			},
		])
		await db.insert(knowledgeExtras).values([
			{
				objectId: lowId,
				workspaceId: workspace.id,
				tValid: new Date(),
				tInvalid: null,
				confidence: 'low',
				verificationStatus: 'unverified',
				writerType: 'agent',
				provenanceType: 'imported',
				provenanceRef: null,
			},
			{
				objectId: highId,
				workspaceId: workspace.id,
				tValid: new Date(),
				tInvalid: null,
				confidence: 'high',
				verificationStatus: 'verified',
				writerType: 'agent',
				provenanceType: 'imported',
				provenanceRef: null,
			},
		])

		const results = await retrieveKnowledge(db, {
			workspaceId: workspace.id,
			q: 'retrieval ranking behaviour',
			limit: 10,
			offset: 0,
		})

		expect(results[0]?.id).toBe(highId)
	})

	it('excludes rows with verification_status=deprecated', async () => {
		const actor = await insertActor(db, { name: 'Deprecated Actor', email: 'dep@test.com' })
		const workspace = await insertWorkspace(db, actor.id, { name: 'Deprecated Workspace' })

		const okId = randomUUID()
		const deprecatedId = randomUUID()
		await db.insert(objects).values([
			{
				id: okId,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: 'Deprecation eval — active row',
				content: 'Body about deprecation handling.',
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			},
			{
				id: deprecatedId,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: 'Deprecation eval — retired row',
				content: 'Body about deprecation handling.',
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			},
		])
		await db.insert(knowledgeExtras).values([
			{
				objectId: okId,
				workspaceId: workspace.id,
				tValid: new Date(),
				tInvalid: null,
				confidence: 'medium',
				verificationStatus: 'verified',
				writerType: 'agent',
				provenanceType: 'imported',
				provenanceRef: null,
			},
			{
				objectId: deprecatedId,
				workspaceId: workspace.id,
				tValid: new Date(),
				tInvalid: null,
				confidence: 'high',
				verificationStatus: 'deprecated',
				writerType: 'agent',
				provenanceType: 'imported',
				provenanceRef: null,
			},
		])

		const results = await retrieveKnowledge(db, {
			workspaceId: workspace.id,
			q: 'deprecation eval handling',
			limit: 10,
			offset: 0,
		})

		const ids = results.map((r) => r.id)
		expect(ids).toContain(okId)
		expect(ids).not.toContain(deprecatedId)
	})
})
