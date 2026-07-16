/**
 * Pilot paired-runner — T8's paired harness driven against the seven pilot
 * rows (`knowledge-eval-pilot.ts`) with T10's router as the retriever. This
 * is the ship-metric baseline for the bet's pilot corpus; the two JSON
 * artifacts it emits are what the 2026-08-13 verdict run reads from.
 *
 * Three layers:
 *   1. Fixture shape — 7 corpus rows, 7 pairs, no dangling fixtureIds,
 *      every excerpt present in the gold row.
 *   2. Router wiring on the pilot corpus — top-K retrieval never exceeds
 *      `DEFAULT_ROUTER_TOP_K`; retrieved rows are preserved by reference;
 *      no non-v1 row surfaces (every pilot row is v1, so this is a
 *      sanity check that the filter still runs).
 *   3. Real-model paired run — dump vs. router side by side against
 *      Anthropic, guarded by `RUN_KNOWLEDGE_EVAL_PILOT=1` + a token.
 *      Emits `knowledge-eval-pilot-router.json` (dump + router paired)
 *      and `knowledge-eval-pilot-baseline.json` (dump leg only, T4-shaped)
 *      so the Product Analyst has both the paired file and a dump-only
 *      artifact matching `measurement_ref`'s naming convention.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { BASELINE_MODEL, type ChatFn, callAnthropicWithUsage } from './knowledge-eval-harness'
import { runPairedEval } from './knowledge-eval-paired'
import { PILOT_CORPUS, PILOT_PAIRS, PILOT_SEED, PILOT_SOURCE_COMMIT } from './knowledge-eval-pilot'
import {
	DEFAULT_ROUTER_MIN_SCORE,
	DEFAULT_ROUTER_TOP_K,
	createRouterRetriever,
} from './knowledge-eval-router-wiring'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('knowledge-eval-pilot fixture', () => {
	it('freezes 7 pilot rows and 7 eval pairs', () => {
		expect(PILOT_CORPUS.length).toBe(7)
		expect(PILOT_PAIRS.length).toBe(7)
	})

	it('every pair resolves to a corpus row', () => {
		const ids = new Set(PILOT_CORPUS.map((row) => row.fixtureId))
		for (const pair of PILOT_PAIRS) {
			expect(ids.has(pair.expectedFixtureId)).toBe(true)
		}
	})

	it('every expected excerpt appears in the title or body of its gold row', () => {
		const byId = new Map(PILOT_CORPUS.map((row) => [row.fixtureId, row]))
		const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
		for (const pair of PILOT_PAIRS) {
			const row = byId.get(pair.expectedFixtureId)
			expect(row).toBeDefined()
			const source = normalise(`${row?.title ?? ''}\n${row?.body ?? ''}`)
			expect(source.includes(normalise(pair.expectedExcerpt))).toBe(true)
		}
	})

	it('every pilot row carries format_version=v1 so the router filter surfaces it', () => {
		for (const row of PILOT_CORPUS) {
			expect(row.metadata.format_version).toBe('v1')
		}
	})
})

describe('router retrieval on the pilot corpus', () => {
	const retriever = createRouterRetriever({
		topK: DEFAULT_ROUTER_TOP_K,
		minScore: DEFAULT_ROUTER_MIN_SCORE,
	})

	it('returns at most topK articles for any pilot query', () => {
		for (const pair of PILOT_PAIRS) {
			const { retrieved, retrievedIds } = retriever(pair.question, PILOT_CORPUS)
			expect(retrieved.length).toBeLessThanOrEqual(DEFAULT_ROUTER_TOP_K)
			expect(retrievedIds.length).toBe(retrieved.length)
		}
	})

	it('preserves fixture rows by reference (same objects the fixture exports)', () => {
		const pair = PILOT_PAIRS[0]
		const { retrieved } = retriever(pair.question, PILOT_CORPUS)
		for (const row of retrieved) {
			const source = PILOT_CORPUS.find((r) => r.fixtureId === row.fixtureId)
			expect(row).toBe(source)
		}
	})

	it('surfaces the gold row inside the top-K for every pilot pair (retrieval accuracy 1.00)', () => {
		for (const pair of PILOT_PAIRS) {
			const { retrievedIds } = retriever(pair.question, PILOT_CORPUS)
			expect(retrievedIds).toContain(pair.expectedFixtureId)
		}
	})
})

describe('pilot paired-run recorded artifacts', () => {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN ?? undefined
	const shouldRun = process.env.RUN_KNOWLEDGE_EVAL_PILOT === '1' && Boolean(apiKey)

	it.runIf(shouldRun)(
		'records dump + router numbers on the pilot corpus against a real model',
		async () => {
			const chat: ChatFn = (messages) =>
				callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey as string)
			const result = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, chat, {
				seed: PILOT_SEED,
				fixtureSourceCommit: PILOT_SOURCE_COMMIT,
				retriever: createRouterRetriever(),
			})

			expect(result.dump.numPairs).toBe(PILOT_PAIRS.length)
			expect(result.router?.numPairs).toBe(PILOT_PAIRS.length)
			expect(Number.isFinite(result.dump.tokensPerCorrectAnswer)).toBe(true)
			// Router regime should never send more prompt tokens than dump
			// on the pilot corpus — the corpus is small but router still
			// picks top-K < 7.
			expect(result.router?.totalPromptTokens ?? 0).toBeLessThanOrEqual(
				result.dump.totalPromptTokens,
			)

			// Router artifact: full paired result (both regimes) — this is
			// what the ship-metric verdict reads and what T10 emits for the
			// representative fixture.
			const routerArtifact = join(__dirname, 'knowledge-eval-pilot-router.json')
			mkdirSync(dirname(routerArtifact), { recursive: true })
			writeFileSync(routerArtifact, `${JSON.stringify(result, null, '\t')}\n`, 'utf-8')

			// Baseline artifact: dump-only slice of the same paired result,
			// mirroring T4's `knowledge-eval-baseline.json` shape so
			// `measurement_ref` can name both files independently. Same run,
			// no second Anthropic call — the dump numbers are identical to
			// the paired file's `dump` block.
			const baseline = {
				model: result.model,
				temperature: result.temperature,
				seed: result.seed,
				fixtureSourceCommit: result.fixtureSourceCommit,
				numPairs: result.dump.numPairs,
				numCorrect: result.dump.numCorrect,
				totalPromptTokens: result.dump.totalPromptTokens,
				avgPromptTokensPerPair: result.dump.avgPromptTokensPerPair,
				tokensPerCorrectAnswer: result.dump.tokensPerCorrectAnswer,
				retrievalAccuracy: result.dump.retrievalAccuracy,
				perPair: result.dump.perPair,
			}
			const baselineArtifact = join(__dirname, 'knowledge-eval-pilot-baseline.json')
			writeFileSync(baselineArtifact, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8')
		},
		600_000,
	)
})
