/**
 * T9 pilot corpus paired-run — the 2026-08-25 verdict input.
 *
 * Runs T8's paired-runner (`knowledge-eval-paired.ts`) over the seven
 * T9 pilot rows with T10's router adapter. Scoring runs both graders on
 * a single invocation:
 *   - `correctExact` — the T4 exact-substring grader kept as an audit
 *     trail. Whitespace/case-insensitive substring match against the
 *     seeded gold excerpt.
 *   - `correctSemantic` — the T-follow-up semantic-match judge. A second
 *     `claude-haiku-4-5-20251001` call, temperature 0, that answers
 *     yes/no on whether the candidate answer contains the information
 *     from the gold excerpt. Semantic-match is the primary metric —
 *     paraphrase-tolerant so the verdict measures router+corpus signal,
 *     not the model's willingness to quote verbatim.
 *
 * Layers:
 *   1. Wiring self-checks — 7 rows, 7 pairs, each excerpt resolves.
 *   2. Stubbed paired-runner — perfect-answer stub with a stub judge;
 *      asserts both grader columns render on a single run without the
 *      network.
 *   3. Real-model gated runs — both guarded by `RUN_KNOWLEDGE_EVAL_PILOT=1`
 *      + an Anthropic token. Two artifacts land next to the fixture so
 *      the ship-metric baseline lives on disk instead of a bet comment
 *      (T11):
 *        - `knowledge-eval-pilot-baseline.json` — dump-only regime
 *          (`retriever: null`), both graders. The dump baseline the
 *          router leg is scored against.
 *        - `knowledge-eval-pilot-router.json` — dump + router paired,
 *          both graders. The verdict artifact.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
	BASELINE_MODEL,
	type ChatFn,
	type SemanticJudge,
	callAnthropicWithUsage,
	createAnthropicJudge,
} from './knowledge-eval-harness'
import { runPairedEval } from './knowledge-eval-paired'
import { PILOT_CORPUS, PILOT_PAIRS, PILOT_SEED, PILOT_SNAPSHOT_AT } from './knowledge-eval-pilot'
import { createRouterRetriever } from './knowledge-eval-router-wiring'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('knowledge-eval-pilot fixture', () => {
	it('carries seven articles + seven paired queries', () => {
		expect(PILOT_CORPUS.length).toBe(7)
		expect(PILOT_PAIRS.length).toBe(7)
	})

	it('every pair points at a corpus row with matching v1 frontmatter', () => {
		const byId = new Map(PILOT_CORPUS.map((row) => [row.fixtureId, row]))
		for (const pair of PILOT_PAIRS) {
			const gold = byId.get(pair.expectedFixtureId)
			expect(gold).toBeDefined()
			expect(gold?.metadata.format_version).toBe('v1')
		}
	})

	it('router retriever surfaces every gold row in the top-3', () => {
		const retriever = createRouterRetriever()
		for (const pair of PILOT_PAIRS) {
			const { retrievedIds } = retriever(pair.question, PILOT_CORPUS)
			expect(retrievedIds).toContain(pair.expectedFixtureId)
		}
	})
})

describe('paired-runner over the pilot with stubbed chat + stub judge', () => {
	const excerptByQuestion = new Map(PILOT_PAIRS.map((p) => [p.question, p.expectedExcerpt]))

	// Perfect-answer stub — same shape T8/T10 use. Returns the gold
	// excerpt verbatim when the gold article is in the prompt, otherwise
	// a canned refusal.
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

	// Stub judge — accepts iff the candidate contains the gold excerpt
	// (same test signal as the exact grader in the perfect-answer stub).
	// Real runs replace this with the Anthropic judge; the stub only
	// exercises the paired-runner plumbing.
	const stubJudge: SemanticJudge = async (response, expectedExcerpt) => {
		const correct = response.toLowerCase().includes(expectedExcerpt.toLowerCase())
		return {
			correct,
			reason: correct ? 'stub: answer contains excerpt' : 'stub: excerpt not in answer',
			verdict: correct ? 'yes' : 'no',
		}
	}

	it('records both graders alongside each other on a single invocation', async () => {
		const result = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, stubChat, {
			seed: PILOT_SEED,
			fixtureSourceCommit: PILOT_SNAPSHOT_AT,
			retriever: createRouterRetriever(),
			judge: stubJudge,
		})
		expect(result.dump.numCorrectExact).toBe(PILOT_PAIRS.length)
		expect(result.dump.numCorrectSemantic).toBe(PILOT_PAIRS.length)
		expect(result.router).not.toBeNull()
		expect(result.router?.numCorrectExact).toBe(PILOT_PAIRS.length)
		expect(result.router?.numCorrectSemantic).toBe(PILOT_PAIRS.length)
		expect(result.router?.totalPromptTokens).toBeLessThan(result.dump.totalPromptTokens)
	})

	it('leaves semantic columns null when no judge is passed — audit-only mode', async () => {
		const result = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, stubChat, {
			seed: PILOT_SEED,
			fixtureSourceCommit: PILOT_SNAPSHOT_AT,
			retriever: createRouterRetriever(),
		})
		expect(result.dump.numCorrectSemantic).toBeNull()
		expect(result.dump.tokensPerCorrectAnswerSemantic).toBeNull()
		expect(result.router?.numCorrectSemantic).toBeNull()
	})
})

describe('pilot paired-run recorded artifacts', () => {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN ?? undefined
	const shouldRun = process.env.RUN_KNOWLEDGE_EVAL_PILOT === '1' && Boolean(apiKey)

	// Dump-only baseline artifact — separate from the paired run so the
	// baseline the router leg is compared against exists on disk on its
	// own, not just as one leg of the paired file. Both graders populate.
	it.runIf(shouldRun)(
		'records the dump-only baseline against the real model',
		async () => {
			const chat: ChatFn = (messages) =>
				callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey as string)
			const judge = createAnthropicJudge(apiKey as string)
			const result = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, chat, {
				seed: PILOT_SEED,
				fixtureSourceCommit: PILOT_SNAPSHOT_AT,
				retriever: null,
				judge,
			})

			expect(result.dump.numPairs).toBe(PILOT_PAIRS.length)
			expect(result.router).toBeNull()
			expect(Number.isFinite(result.dump.tokensPerCorrectAnswerExact)).toBe(true)
			expect(result.dump.numCorrectSemantic).not.toBeNull()
			expect(result.dump.retrievalAccuracy).toBe(1)

			const artifactPath = join(__dirname, 'knowledge-eval-pilot-baseline.json')
			mkdirSync(dirname(artifactPath), { recursive: true })
			writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
		},
		900_000,
	)

	// Dump + router paired artifact — the ship-metric verdict input.
	it.runIf(shouldRun)(
		'records dump + router numbers under both graders against the real model',
		async () => {
			const chat: ChatFn = (messages) =>
				callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey as string)
			const judge = createAnthropicJudge(apiKey as string)
			const result = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, chat, {
				seed: PILOT_SEED,
				fixtureSourceCommit: PILOT_SNAPSHOT_AT,
				retriever: createRouterRetriever(),
				judge,
			})

			expect(result.dump.numPairs).toBe(PILOT_PAIRS.length)
			expect(result.router?.numPairs).toBe(PILOT_PAIRS.length)
			// Both grader columns must populate on the real run — that's the
			// whole point of this artifact.
			expect(Number.isFinite(result.dump.tokensPerCorrectAnswerExact)).toBe(true)
			expect(result.dump.numCorrectSemantic).not.toBeNull()
			expect(result.router?.numCorrectSemantic).not.toBeNull()
			// Router regime should never send more prompt tokens than the
			// dump regime — top-K subset vs. the whole corpus.
			expect(result.router?.totalPromptTokens ?? 0).toBeLessThanOrEqual(
				result.dump.totalPromptTokens,
			)

			const artifactPath = join(__dirname, 'knowledge-eval-pilot-router.json')
			mkdirSync(dirname(artifactPath), { recursive: true })
			writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
		},
		900_000,
	)
})
