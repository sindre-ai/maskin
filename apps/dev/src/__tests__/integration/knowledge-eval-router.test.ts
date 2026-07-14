import { describe, expect, it } from 'vitest'
import {
	approxTokens,
	assembleContext,
	assembleFullContext,
	route,
} from '../../lib/knowledge/router'
import { CORPUS, EVAL_PAIRS, FIXTURE_SEED } from './knowledge-eval-fixture'

// Router regime for the 20-pair knowledge eval. Runs against the shared fixture
// (T4 imports the same module for its dump-into-context baseline harness). See
// docs/reference/knowledge-format.md for the v1 frontmatter contract the router
// keys on.
//
// Mechanism assertions here — token-savings ratio and top-K-contains-gold — are
// what T5 owns end-to-end. The full ship metric (tokens-per-correct-answer against
// a real model) is composed with T4's dump-regime numbers once T4's baseline lands.

const TOP_K = 3

describe('knowledge router eval — router regime', () => {
	const dumpContext = assembleFullContext(CORPUS)
	const dumpContextTokens = approxTokens(dumpContext)

	it('every question routes to a top-K set that contains the gold article', () => {
		const missing: string[] = []
		for (const pair of EVAL_PAIRS) {
			const result = route(pair.question, CORPUS, { topK: TOP_K })
			const ids = result.hits.map((h) => h.article.id)
			if (!ids.includes(pair.goldArticleId)) {
				missing.push(`${pair.id}: expected ${pair.goldArticleId}, got [${ids.join(', ')}]`)
			}
		}
		expect(missing, missing.join('\n')).toHaveLength(0)
	})

	it('router regime uses at least 30% fewer input tokens than dump-into-context', () => {
		let totalDump = 0
		let totalRouter = 0

		for (const pair of EVAL_PAIRS) {
			const qTokens = approxTokens(pair.question)

			totalDump += qTokens + dumpContextTokens

			const result = route(pair.question, CORPUS, { topK: TOP_K })
			const routerContext = assembleContext(result.hits.map((h) => h.article))
			totalRouter += qTokens + approxTokens(routerContext)
		}

		const dumpPerPair = totalDump / EVAL_PAIRS.length
		const routerPerPair = totalRouter / EVAL_PAIRS.length
		const savings = 1 - totalRouter / totalDump

		console.log(
			`[knowledge-eval-router] seed=${FIXTURE_SEED} topK=${TOP_K}\n` +
				`  dump  total=${totalDump} tokens, avg/pair=${dumpPerPair.toFixed(1)}\n` +
				`  router total=${totalRouter} tokens, avg/pair=${routerPerPair.toFixed(1)}\n` +
				`  savings=${(savings * 100).toFixed(1)}%`,
		)

		expect(savings).toBeGreaterThanOrEqual(0.3)
	})

	it('router is deterministic across repeated runs on the same fixture', () => {
		const first = route(EVAL_PAIRS[0].question, CORPUS, { topK: TOP_K })
		const second = route(EVAL_PAIRS[0].question, CORPUS, { topK: TOP_K })
		expect(first.hits.map((h) => h.article.id)).toEqual(second.hits.map((h) => h.article.id))
		expect(first.hits.map((h) => h.score)).toEqual(second.hits.map((h) => h.score))
	})

	it('router only considers v1 articles', () => {
		const withV0 = [
			...CORPUS,
			{
				id: 'z0000000-0000-0000-0000-00000000000v',
				title: 'Pre-v1 article about GitHub tokens',
				body: 'This article is not v1-formatted.',
				metadata: { doc_type: 'operational', tags: ['topic:integrations'] },
			},
		]
		const result = route('github token', withV0, { topK: TOP_K })
		const ids = result.hits.map((h) => h.article.id)
		expect(ids).not.toContain('z0000000-0000-0000-0000-00000000000v')
	})
})
