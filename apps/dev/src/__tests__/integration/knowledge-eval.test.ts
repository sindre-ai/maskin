import { randomUUID } from 'node:crypto'
import { objects } from '@maskin/db/schema'
import { and, eq, ilike, or, sql } from 'drizzle-orm'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'
import { EVAL_PAIRS, KNOWLEDGE_CORPUS } from './knowledge-eval-fixture'

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

describe('Knowledge cited-answer eval (JSONB-ILIKE baseline)', () => {
	it("runs 30 gold Q/A pairs through today's ilike(title|content) retrieval and reports two accuracy numbers", async () => {
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

		type Row = { id: string; title: string | null; content: string | null }
		const perPair: Array<{
			question: string
			expectedId: string
			expectedFixtureId: string
			retrievalHit: 0 | 1
			citedAnswerHit: 0 | 1
			tokenCount: number
			candidatesReturned: number
			topId: string | null
		}> = []

		for (const pair of EVAL_PAIRS) {
			const expectedId = idByFixture.get(pair.expectedFixtureId)
			if (!expectedId) throw new Error(`fixtureId not seeded: ${pair.expectedFixtureId}`)

			const tokens = tokenize(pair.question)
			const scoreById = new Map<string, { row: Row; score: number }>()

			if (tokens.length > 0) {
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
							and(eq(objects.workspaceId, workspace.id), eq(objects.type, 'knowledge'), clause),
						)) as Row[]

					for (const row of rows) {
						const existing = scoreById.get(row.id)
						if (existing) existing.score += 1
						else scoreById.set(row.id, { row, score: 1 })
					}
				}
			}

			const ordered = Array.from(scoreById.values()).sort((a, b) => {
				if (b.score !== a.score) return b.score - a.score
				return (a.row.title ?? '').localeCompare(b.row.title ?? '')
			})

			const topTen = ordered.slice(0, 10).map((r) => r.row.id)
			const retrievalHit = topTen.includes(expectedId) ? 1 : 0

			const top = ordered[0]
			const topHaystack = `${top?.row.title ?? ''}\n${top?.row.content ?? ''}`.toLowerCase()
			const citedAnswerHit = top && topHaystack.includes(pair.expectedExcerpt.toLowerCase()) ? 1 : 0

			perPair.push({
				question: pair.question,
				expectedId,
				expectedFixtureId: pair.expectedFixtureId,
				retrievalHit,
				citedAnswerHit,
				tokenCount: tokens.length,
				candidatesReturned: ordered.length,
				topId: top?.row.id ?? null,
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
		lines.push('=== Knowledge cited-answer eval (JSONB-ILIKE baseline) ===')
		lines.push(`corpus size:            ${KNOWLEDGE_CORPUS.length}`)
		lines.push(`eval pairs:             ${total}`)
		lines.push(`retrieval accuracy@10:  ${retrievalCorrect}/${total} = ${retrievalPct.toFixed(1)}%`)
		lines.push(`cited-answer accuracy@1:${citedCorrect}/${total} = ${citedPct.toFixed(1)}%`)
		if (misses.length > 0) {
			lines.push(`\ncited-answer misses (${misses.length}):`)
			for (const miss of misses) {
				lines.push(
					`  - [${miss.expectedFixtureId}] tokens=${miss.tokenCount} candidates=${miss.candidatesReturned}`,
				)
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
})
