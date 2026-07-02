import { randomUUID } from 'node:crypto'
import { objects } from '@maskin/db/schema'
import { knowledgeExtras } from '@maskin/ext-knowledge/db-schema'
import { retrieveKnowledge } from '@maskin/ext-knowledge/retrieval'
import { and, eq, sql } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'
import { EVAL_PAIRS, KNOWLEDGE_CORPUS } from './knowledge-eval-fixture'

// Post-migration eval — the retrieval path now goes through
// `retrieveKnowledge()` (LEFT JOIN on `knowledge_extras`, column-aware filters
// and ranking) rather than the raw JSONB-ILIKE loop T1 measured. Fixture and
// scoring rules stay byte-identical to T1's baseline harness so the two
// accuracy numbers sit on the same axis:
//
//   baseline (T1):        retrieval@10 = 96.7 %  cited-answer@1 = 83.3 %
//   post-migration (T4):  reported in the console block below.
//
// Seeded `knowledge_extras` metadata reflects the migration's backfill
// defaults for a corpus of validated knowledge (verification_status=verified,
// writer_type=agent, provenance_type=imported, confidence=high, t_valid=now,
// t_invalid=NULL). If a future eval redesigns the fixture to include
// invalidated / low-confidence rows, only the seed block moves — the
// retrieval helper is unchanged.

describe('Knowledge cited-answer eval (column-aware retrieval)', () => {
	it('runs 30 gold Q/A pairs through retrieveKnowledge() and reports two accuracy numbers', async () => {
		const actor = await insertActor(db, { name: 'Eval Actor', email: 'eval@test.com' })
		const workspace = await insertWorkspace(db, actor.id, { name: 'Eval Workspace' })

		const idByFixture = new Map<string, string>()
		const seedRows = KNOWLEDGE_CORPUS.map((entry) => {
			const id = randomUUID()
			idByFixture.set(entry.fixtureId, id)
			return {
				id,
				workspaceId: workspace.id,
				type: 'knowledge',
				title: entry.title,
				content: entry.content,
				status: 'validated',
				metadata: null,
				createdBy: actor.id,
			}
		})
		await db.insert(objects).values(seedRows)

		const extrasRows = seedRows.map((row) => ({
			objectId: row.id,
			workspaceId: workspace.id,
			tValid: new Date(),
			tInvalid: null,
			confidence: 'high',
			verificationStatus: 'verified',
			writerType: 'agent',
			provenanceType: 'imported',
			provenanceRef: null,
		}))
		await db.insert(knowledgeExtras).values(extrasRows)

		const perPair: Array<{
			question: string
			expectedId: string
			expectedFixtureId: string
			retrievalHit: 0 | 1
			citedAnswerHit: 0 | 1
			candidatesReturned: number
			topId: string | null
		}> = []

		for (const pair of EVAL_PAIRS) {
			const expectedId = idByFixture.get(pair.expectedFixtureId)
			if (!expectedId) throw new Error(`fixtureId not seeded: ${pair.expectedFixtureId}`)

			const results = await retrieveKnowledge(db, {
				workspaceId: workspace.id,
				q: pair.question,
				limit: 10,
				offset: 0,
			})

			const topTen = results.slice(0, 10).map((r) => r.id)
			const retrievalHit = topTen.includes(expectedId) ? 1 : 0

			const top = results[0]
			const topHaystack = `${top?.title ?? ''}\n${top?.content ?? ''}`.toLowerCase()
			const citedAnswerHit = top && topHaystack.includes(pair.expectedExcerpt.toLowerCase()) ? 1 : 0

			perPair.push({
				question: pair.question,
				expectedId,
				expectedFixtureId: pair.expectedFixtureId,
				retrievalHit,
				citedAnswerHit,
				candidatesReturned: results.length,
				topId: top?.id ?? null,
			})
		}

		const total = perPair.length
		const retrievalCorrect = perPair.reduce((acc, p) => acc + p.retrievalHit, 0)
		const citedCorrect = perPair.reduce((acc, p) => acc + p.citedAnswerHit, 0)
		const retrievalPct = (retrievalCorrect / total) * 100
		const citedPct = (citedCorrect / total) * 100

		const misses = perPair.filter((p) => p.citedAnswerHit === 0)

		const lines: string[] = []
		lines.push('')
		lines.push('=== Knowledge cited-answer eval (column-aware retrieval) ===')
		lines.push(`corpus size:            ${KNOWLEDGE_CORPUS.length}`)
		lines.push(`eval pairs:             ${total}`)
		lines.push(`retrieval accuracy@10:  ${retrievalCorrect}/${total} = ${retrievalPct.toFixed(1)}%`)
		lines.push(`cited-answer accuracy@1:${citedCorrect}/${total} = ${citedPct.toFixed(1)}%`)
		if (misses.length > 0) {
			lines.push(`\ncited-answer misses (${misses.length}):`)
			for (const miss of misses) {
				lines.push(`  - [${miss.expectedFixtureId}] candidates=${miss.candidatesReturned}`)
				lines.push(`    q: ${miss.question}`)
			}
		}
		lines.push('')
		console.log(lines.join('\n'))

		expect(perPair).toHaveLength(EVAL_PAIRS.length)
		for (const p of perPair) {
			expect(p.retrievalHit === 0 || p.retrievalHit === 1).toBe(true)
			expect(p.citedAnswerHit === 0 || p.citedAnswerHit === 1).toBe(true)
		}

		const [{ seeded }] = await db
			.select({ seeded: sql<number>`count(*)::int` })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspace.id), eq(objects.type, 'knowledge')))
		expect(seeded).toBe(KNOWLEDGE_CORPUS.length)
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
