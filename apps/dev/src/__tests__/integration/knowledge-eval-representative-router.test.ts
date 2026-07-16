/**
 * T10 — router regime paired against the T8 representative harness.
 *
 * Three layers:
 *   1. Wiring self-checks — the router `Retriever` returns the top-K
 *      subset the paired runner expects, with fixture rows preserved
 *      by reference.
 *   2. Stubbed paired-runner semantics — perfect-answer stub + real
 *      router; asserts the router leg emits both metrics without
 *      touching the network.
 *   3. Real-model paired run — dump vs. router side by side against
 *      Anthropic, guarded by `RUN_KNOWLEDGE_EVAL_ROUTER=1` + a token.
 *      Emits `knowledge-eval-representative-router.json` — the JSON
 *      artifact the ship-metric comment quotes from.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASELINE_MODEL, type ChatFn, callAnthropicWithUsage } from './knowledge-eval-harness'
import { runPairedEval } from './knowledge-eval-paired'
import {
	REPRESENTATIVE_CORPUS,
	REPRESENTATIVE_PAIRS,
	REPRESENTATIVE_SEED,
	REPRESENTATIVE_SOURCE_COMMIT,
} from './knowledge-eval-representative'
import {
	DEFAULT_ROUTER_MIN_SCORE,
	DEFAULT_ROUTER_TOP_K,
	createRouterRetriever,
} from './knowledge-eval-router-wiring'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('knowledge-eval-router-wiring retriever', () => {
	const retriever = createRouterRetriever()

	it('returns at most topK articles for any query', () => {
		const pair = REPRESENTATIVE_PAIRS[0]
		const { retrieved, retrievedIds } = retriever(pair.question, REPRESENTATIVE_CORPUS)
		expect(retrieved.length).toBeLessThanOrEqual(DEFAULT_ROUTER_TOP_K)
		expect(retrievedIds.length).toBe(retrieved.length)
	})

	it('preserves fixture rows by reference so the paired runner sees the exact objects', () => {
		const pair = REPRESENTATIVE_PAIRS[0]
		const { retrieved } = retriever(pair.question, REPRESENTATIVE_CORPUS)
		for (const row of retrieved) {
			const source = REPRESENTATIVE_CORPUS.find((r) => r.fixtureId === row.fixtureId)
			// Same object reference — no cloning, no re-shape.
			expect(row).toBe(source)
		}
	})

	it('is deterministic — same query, same corpus, same order', () => {
		const pair = REPRESENTATIVE_PAIRS[3]
		const a = retriever(pair.question, REPRESENTATIVE_CORPUS)
		const b = retriever(pair.question, REPRESENTATIVE_CORPUS)
		expect(a.retrievedIds).toEqual(b.retrievedIds)
	})

	it('never returns non-v1 rows (router filters on metadata.format_version)', () => {
		// Every query in the fixture; nothing the router returns should be
		// one of the 5 deliberately non-v1 rows T8 seeded.
		const nonV1Ids = new Set(
			REPRESENTATIVE_CORPUS.filter((r) => r.metadata.format_version !== 'v1').map(
				(r) => r.fixtureId,
			),
		)
		for (const pair of REPRESENTATIVE_PAIRS) {
			const { retrievedIds } = retriever(pair.question, REPRESENTATIVE_CORPUS)
			for (const id of retrievedIds) {
				expect(nonV1Ids.has(id)).toBe(false)
			}
		}
	})

	it('honours minScore — a lower threshold widens the routable set', () => {
		const pair = REPRESENTATIVE_PAIRS[0]
		const strict = createRouterRetriever({ minScore: DEFAULT_ROUTER_MIN_SCORE * 4 })
		const loose = createRouterRetriever({ minScore: 0 })
		const strictHits = strict(pair.question, REPRESENTATIVE_CORPUS).retrievedIds.length
		const looseHits = loose(pair.question, REPRESENTATIVE_CORPUS).retrievedIds.length
		expect(looseHits).toBeGreaterThanOrEqual(strictHits)
	})
})

describe('paired-runner with the router retriever (stubbed chat)', () => {
	// Stub returns the expected excerpt when the gold row is in the prompt,
	// else a canned wrong answer. Same shape as T8's stub — lets us drive
	// the paired runner end-to-end without the network.
	const excerptByQuestion = new Map(
		REPRESENTATIVE_PAIRS.map((p) => [p.question, p.expectedExcerpt]),
	)
	const stubChat: ChatFn = async (messages) => {
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

	it('router leg emits both metrics and uses fewer tokens than the dump leg', async () => {
		const result = await runPairedEval(REPRESENTATIVE_PAIRS, REPRESENTATIVE_CORPUS, stubChat, {
			seed: REPRESENTATIVE_SEED,
			fixtureSourceCommit: REPRESENTATIVE_SOURCE_COMMIT,
			retriever: createRouterRetriever(),
		})
		expect(result.router).not.toBeNull()
		expect(result.router?.numPairs).toBe(REPRESENTATIVE_PAIRS.length)
		expect(result.router?.totalPromptTokens).toBeLessThan(result.dump.totalPromptTokens)
		expect(Number.isFinite(result.router?.retrievalAccuracy ?? 0)).toBe(true)
	})
})

describe('router paired-run recorded artifact', () => {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN ?? undefined
	const shouldRun = process.env.RUN_KNOWLEDGE_EVAL_ROUTER === '1' && Boolean(apiKey)

	it.runIf(shouldRun)(
		'records dump + router numbers side-by-side against a real model',
		async () => {
			const chat: ChatFn = (messages) =>
				callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey as string)
			const result = await runPairedEval(REPRESENTATIVE_PAIRS, REPRESENTATIVE_CORPUS, chat, {
				seed: REPRESENTATIVE_SEED,
				fixtureSourceCommit: REPRESENTATIVE_SOURCE_COMMIT,
				retriever: createRouterRetriever(),
			})
			expect(result.dump.numPairs).toBe(REPRESENTATIVE_PAIRS.length)
			expect(result.router?.numPairs).toBe(REPRESENTATIVE_PAIRS.length)
			expect(Number.isFinite(result.dump.tokensPerCorrectAnswerExact)).toBe(true)
			// Router regime should never send more prompt tokens than the dump
			// regime — top-K subset vs. the whole corpus.
			expect(result.router?.totalPromptTokens ?? 0).toBeLessThanOrEqual(
				result.dump.totalPromptTokens,
			)

			const artifactPath = join(__dirname, 'knowledge-eval-representative-router.json')
			mkdirSync(dirname(artifactPath), { recursive: true })
			writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
		},
		600_000,
	)
})
