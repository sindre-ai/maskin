/**
 * Paired-regime harness on the representative agent-query set (T8).
 *
 * Three checks:
 *   1. Fixture shape — 35 corpus rows, 30 pairs, no dangling fixtureIds,
 *      every excerpt present in its gold row.
 *   2. Paired runner semantics on a stub chat + trivial retriever, no
 *      network. Verifies the retrieval-accuracy math and the JSON
 *      artifact shape.
 *   3. Real-model recorded baseline of the dump regime, guarded by
 *      `RUN_KNOWLEDGE_EVAL_REPRESENTATIVE=1` + an Anthropic token. Skipped
 *      in CI by default; run manually to record the number.
 *
 * The router regime is intentionally left unwired here — T10 will pass a
 * Retriever built on `lib/knowledge/router.ts` when it lands. This test
 * file already covers the router-leg semantics via the stub.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASELINE_MODEL, type ChatFn, callAnthropicWithUsage } from './knowledge-eval-harness'
import { type Retriever, computeRetrievalAccuracy, runPairedEval } from './knowledge-eval-paired'
import {
	REPRESENTATIVE_CORPUS,
	REPRESENTATIVE_PAIRS,
	REPRESENTATIVE_SEED,
	REPRESENTATIVE_SOURCE_COMMIT,
} from './knowledge-eval-representative'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('knowledge-eval-representative fixture', () => {
	it('freezes 35 corpus rows and 30+ eval pairs', () => {
		expect(REPRESENTATIVE_CORPUS.length).toBe(35)
		expect(REPRESENTATIVE_PAIRS.length).toBeGreaterThanOrEqual(30)
	})

	it('every pair resolves to a corpus row (no dangling fixtureIds)', () => {
		const ids = new Set(REPRESENTATIVE_CORPUS.map((row) => row.fixtureId))
		for (const pair of REPRESENTATIVE_PAIRS) {
			expect(ids.has(pair.expectedFixtureId)).toBe(true)
		}
	})

	it('every expected excerpt is present in the title or body of its gold row', () => {
		const byId = new Map(REPRESENTATIVE_CORPUS.map((row) => [row.fixtureId, row]))
		const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
		for (const pair of REPRESENTATIVE_PAIRS) {
			const row = byId.get(pair.expectedFixtureId)
			expect(row).toBeDefined()
			const source = normalise(`${row?.title ?? ''}\n${row?.body ?? ''}`)
			expect(source.includes(normalise(pair.expectedExcerpt))).toBe(true)
		}
	})

	it('mirrors the mixed real corpus — 30 v1 rows and 5 non-v1 rows', () => {
		const v1 = REPRESENTATIVE_CORPUS.filter((r) => r.metadata.format_version === 'v1')
		expect(v1.length).toBe(30)
		expect(REPRESENTATIVE_CORPUS.length - v1.length).toBe(5)
	})
})

describe('paired-eval runner semantics', () => {
	// Deterministic stub chat — returns the expected excerpt verbatim when
	// the gold row is present in the prompt, otherwise returns a canned
	// wrong answer. Enough to drive the paired runner end-to-end without
	// touching the network.
	const stubChatFor =
		(excerptByQuestion: Map<string, string>): ChatFn =>
		async (messages) => {
			const userContent = messages.find((m) => m.role === 'user')?.content ?? ''
			for (const [question, excerpt] of excerptByQuestion) {
				if (userContent.includes(`Question: ${question}`)) {
					if (userContent.toLowerCase().includes(excerpt.toLowerCase())) {
						return {
							content: excerpt,
							promptTokens: Math.ceil(userContent.length / 4),
							completionTokens: 10,
						}
					}
					return {
						content: 'I cannot find the answer in the corpus.',
						promptTokens: Math.ceil(userContent.length / 4),
						completionTokens: 10,
					}
				}
			}
			return { content: null, promptTokens: 0, completionTokens: 0 }
		}

	const excerptByQuestion = new Map(
		REPRESENTATIVE_PAIRS.map((p) => [p.question, p.expectedExcerpt]),
	)

	// Trivial retriever — returns the top-1 article whose fixtureId is
	// mentioned in the question. Not a real router; enough to drive the
	// paired-runner semantics.
	const trivialRetriever: Retriever = (query, corpus) => {
		const gold = REPRESENTATIVE_PAIRS.find((p) => p.question === query)?.expectedFixtureId
		const hit = gold ? corpus.find((r) => r.fixtureId === gold) : undefined
		return {
			retrieved: hit ? [hit] : [],
			retrievedIds: hit ? [hit.fixtureId] : [],
		}
	}

	it('dump regime scores every pair correct on the stub chat (gold always in corpus)', async () => {
		const chat = stubChatFor(excerptByQuestion)
		const result = await runPairedEval(REPRESENTATIVE_PAIRS, REPRESENTATIVE_CORPUS, chat, {
			seed: REPRESENTATIVE_SEED,
			fixtureSourceCommit: REPRESENTATIVE_SOURCE_COMMIT,
			retriever: null,
		})
		expect(result.dump.numCorrectExact).toBe(REPRESENTATIVE_PAIRS.length)
		expect(result.dump.numCorrectSemantic).toBeNull()
		expect(result.dump.retrievalAccuracy).toBe(1)
		expect(result.router).toBeNull()
	})

	it('router regime with a perfect retriever reports retrieval accuracy 1.0 and correctness parity', async () => {
		const chat = stubChatFor(excerptByQuestion)
		const result = await runPairedEval(REPRESENTATIVE_PAIRS, REPRESENTATIVE_CORPUS, chat, {
			seed: REPRESENTATIVE_SEED,
			fixtureSourceCommit: REPRESENTATIVE_SOURCE_COMMIT,
			retriever: trivialRetriever,
		})
		expect(result.router).not.toBeNull()
		expect(result.router?.retrievalAccuracy).toBe(1)
		expect(result.router?.numCorrectExact).toBe(REPRESENTATIVE_PAIRS.length)
		// Router regime should use fewer tokens than dump — top-1 vs. full corpus.
		expect(result.router?.totalPromptTokens).toBeLessThan(result.dump.totalPromptTokens)
	})

	it('router regime with an empty retriever drops retrieval accuracy to 0 and marks answers wrong', async () => {
		const chat = stubChatFor(excerptByQuestion)
		const emptyRetriever: Retriever = () => ({ retrieved: [], retrievedIds: [] })
		const result = await runPairedEval(REPRESENTATIVE_PAIRS, REPRESENTATIVE_CORPUS, chat, {
			seed: REPRESENTATIVE_SEED,
			fixtureSourceCommit: REPRESENTATIVE_SOURCE_COMMIT,
			retriever: emptyRetriever,
		})
		expect(result.router?.retrievalAccuracy).toBe(0)
		expect(result.router?.numCorrectExact).toBe(0)
	})

	it('computeRetrievalAccuracy handles missing entries as zero-hit', () => {
		const retrieved = new Map<string, string[]>([
			[REPRESENTATIVE_PAIRS[0].question, [REPRESENTATIVE_PAIRS[0].expectedFixtureId]],
			[REPRESENTATIVE_PAIRS[1].question, ['a99-not-a-real-id']],
		])
		const twoPairs = REPRESENTATIVE_PAIRS.slice(0, 2)
		expect(computeRetrievalAccuracy(twoPairs, retrieved)).toBe(0.5)
	})
})

describe('knowledge-eval-representative recorded baseline', () => {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN ?? undefined
	const shouldRun = process.env.RUN_KNOWLEDGE_EVAL_REPRESENTATIVE === '1' && Boolean(apiKey)

	it.runIf(shouldRun)(
		'records the dump-regime baseline against a real model',
		async () => {
			const chat: ChatFn = (messages) =>
				callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey as string)
			const result = await runPairedEval(REPRESENTATIVE_PAIRS, REPRESENTATIVE_CORPUS, chat, {
				seed: REPRESENTATIVE_SEED,
				fixtureSourceCommit: REPRESENTATIVE_SOURCE_COMMIT,
				retriever: null,
			})
			expect(result.dump.numPairs).toBe(REPRESENTATIVE_PAIRS.length)
			expect(result.dump.numCorrectExact).toBeGreaterThan(0)
			expect(Number.isFinite(result.dump.tokensPerCorrectAnswerExact)).toBe(true)
			expect(result.dump.retrievalAccuracy).toBe(1)
			expect(result.router).toBeNull()

			const artifactPath = join(__dirname, 'knowledge-eval-representative-baseline.json')
			mkdirSync(dirname(artifactPath), { recursive: true })
			writeFileSync(artifactPath, `${JSON.stringify(result, null, '\t')}\n`, 'utf-8')
		},
		600_000,
	)
})
