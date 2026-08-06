import { randomUUID } from 'node:crypto'
import { objects } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { buildObjectListConditions, tokenRankOrderBy } from '../../routes/objects'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'
import {
	EVAL_PAIRS,
	KNOWLEDGE_CORPUS,
	METADATA_EVAL_PAIRS,
	METADATA_KNOWLEDGE_CORPUS,
} from './knowledge-eval-fixture'

// Joint cited-answer eval — runs the 30 content-lookup pairs and the 10
// metadata-filter pairs through the shipped object-search SQL path
// (`buildObjectListConditions` + `tokenRankOrderBy` in `apps/dev/src/routes/
// objects.ts`) and reports content-30 cited-answer@1 and joint 40-pair
// cited-answer@1.
//
// Seeding topology:
//   - content-30 lives in one shared workspace — the shared corpus is the
//     point (ranking under a realistic 30-row search surface).
//   - metadata-10 seeds one fresh workspace per pair, containing only that
//     pair's expected + trap rows. The fixture was calibrated against each
//     pair's own trap set; joint-workspace seeding under-specifies that
//     contract.
//
// The metadata-10 subset is designed to fail under the tokenized-ILIKE SQL
// path — every pair pairs an expected row against a trap that outranks it
// on content alone. Its role here is to keep the joint 40-pair number as
// the load-bearing acceptance figure the bet is scored against, not as a
// pass/kill gate by itself.
//
// Empty-return scoring: a pair with `expectedFixtureIds: []` (V3) is a hit
// when retrieval returns zero candidates.

type Row = { id: string; title: string | null; content: string | null }

type UnifiedPair = {
	subset: 'content-30' | 'metadata-10'
	pairId: string
	question: string
	expectedIds: string[]
	expectedExcerpt: string | null
}

type Outcome = {
	pair: UnifiedPair
	citedAnswerHit: 0 | 1
	candidatesReturned: number
	topId: string | null
}

async function runShippedSearch(workspaceId: string, question: string): Promise<Row[]> {
	const { conditions: filterConditions, searchRankExpr } = buildObjectListConditions({
		q: question,
		type: 'knowledge',
	})
	// If tokenization collapsed to zero tokens, `searchRankExpr` is null and
	// the shipped path applies no text filter. Mirror that here: return no
	// candidates instead of dumping the entire workspace — the eval scores a
	// missing rank expression as a miss on non-empty-expected pairs.
	if (!searchRankExpr) return []

	const rows = (await db
		.select({
			id: objects.id,
			title: objects.title,
			content: objects.content,
		})
		.from(objects)
		.where(and(eq(objects.workspaceId, workspaceId), ...filterConditions))
		.orderBy(...tokenRankOrderBy(searchRankExpr))
		.limit(10)) as Row[]

	return rows
}

function scorePair(pair: UnifiedPair, results: Row[]): Outcome {
	const expectedIds = new Set(pair.expectedIds)
	const isEmptyExpected = expectedIds.size === 0
	const top = results[0]

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
		citedAnswerHit,
		candidatesReturned: results.length,
		topId: top?.id ?? null,
	}
}

function summarise(
	outcomes: Outcome[],
	label: string,
): {
	citedCorrect: number
	total: number
	block: string[]
} {
	const total = outcomes.length
	const citedCorrect = outcomes.reduce((acc, o) => acc + o.citedAnswerHit, 0)
	const citedPct = total === 0 ? 0 : (citedCorrect / total) * 100

	const misses = outcomes.filter((o) => o.citedAnswerHit === 0)
	const block: string[] = []
	block.push(`  ${label}:`)
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
	return { citedCorrect, total, block }
}

describe('Knowledge cited-answer eval — joint (content-30 + metadata-10)', () => {
	it('runs the joint fixture through the shipped object-search SQL and reports content-30 + joint accuracy', async () => {
		const contentActor = await insertActor(db, { name: 'Eval Actor', email: 'eval@test.com' })
		const contentWorkspace = await insertWorkspace(db, contentActor.id, {
			name: 'Content-30 Eval Workspace',
		})

		// ── Seed content-30 rows into one shared workspace. ──
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

		// ── Seed metadata-10 rows into one fresh workspace per pair. ──
		// Isolation prevents peripheral ILIKE matches from other pairs' rows
		// (e.g. U1's "on-call" leaking into V3's query) from surviving into
		// another pair's candidate set. Each pair is calibrated against its
		// own trap set; joint-workspace seeding would under-specify that.
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

			metadataContextByPair.set(pair.pairId, {
				workspaceId: workspace.id,
				idByFixture,
			})
		}

		// ── Build the unified pair list. ──
		const contentPairs: Array<UnifiedPair & { workspaceId: string }> = EVAL_PAIRS.map((p) => ({
			subset: 'content-30',
			pairId: p.expectedFixtureId,
			question: p.question,
			expectedIds: [contentIdByFixture.get(p.expectedFixtureId) as string],
			expectedExcerpt: p.expectedExcerpt,
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
					workspaceId: ctx.workspaceId,
				}
			},
		)
		const allPairs = [...contentPairs, ...metadataPairs]

		// ── Run the shipped search path for every pair against its workspace. ──
		const outcomes: Outcome[] = []
		for (const pair of allPairs) {
			const rows = await runShippedSearch(pair.workspaceId, pair.question)
			outcomes.push(scorePair(pair, rows))
		}

		const contentOutcomes = outcomes.filter((o) => o.pair.subset === 'content-30')
		const metaOutcomes = outcomes.filter((o) => o.pair.subset === 'metadata-10')
		const jointOutcomes = outcomes

		const contentSummary = summarise(contentOutcomes, 'content-30 (n=30)')
		const metaSummary = summarise(metaOutcomes, 'metadata-10 (n=10)')
		const jointSummary = summarise(jointOutcomes, 'joint 40-pair (n=40)')

		// ── Print the report. ──
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
		lines.push('--- Shipped object-search SQL (buildObjectListConditions + tokenRankOrderBy) ---')
		lines.push(...contentSummary.block)
		lines.push(...metaSummary.block)
		lines.push(...jointSummary.block)
		lines.push('')
		console.log(lines.join('\n'))

		// ── Structural assertions — every pair scored 0/1 on cited-answer. ──
		expect(outcomes).toHaveLength(allPairs.length)
		for (const o of outcomes) {
			expect(o.citedAnswerHit === 0 || o.citedAnswerHit === 1).toBe(true)
		}

		// content-30 workspace holds the full 30-row corpus; each metadata
		// pair's isolated workspace holds only its expected + trap rows.
		const contentSeeded = await db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, contentWorkspace.id), eq(objects.type, 'knowledge')))
		expect(contentSeeded.length).toBe(KNOWLEDGE_CORPUS.length)

		for (const pair of METADATA_EVAL_PAIRS) {
			const ctx = metadataContextByPair.get(pair.pairId)
			if (!ctx) throw new Error(`no metadata context for pair ${pair.pairId}`)
			const seeded = await db
				.select({ id: objects.id })
				.from(objects)
				.where(and(eq(objects.workspaceId, ctx.workspaceId), eq(objects.type, 'knowledge')))
			const expectedCount = new Set<string>([...pair.expectedFixtureIds, ...pair.trapFixtureIds])
				.size
			expect(seeded.length).toBe(expectedCount)
		}
	})
})
