/**
 * Standalone runner for the pilot paired eval — bypasses the vitest
 * integration harness (which requires Postgres) so we can produce the
 * verdict artifacts from any node environment with an Anthropic token.
 *
 * Usage:
 *   ANTHROPIC_API_KEY=... tsx apps/dev/scripts/run-knowledge-eval-pilot.ts
 *
 * Emits two artifacts next to the fixture (T11 spec):
 *   - `knowledge-eval-pilot-baseline.json` — dump-only regime
 *     (`retriever: null`), both graders. The baseline the router leg
 *     is scored against.
 *   - `knowledge-eval-pilot-router.json` — dump + router paired, both
 *     graders. The ship-metric verdict input.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	BASELINE_MODEL,
	type ChatFn,
	callAnthropicWithUsage,
	createAnthropicJudge,
} from '../src/__tests__/integration/knowledge-eval-harness'
import { runPairedEval } from '../src/__tests__/integration/knowledge-eval-paired'
import {
	PILOT_CORPUS,
	PILOT_PAIRS,
	PILOT_SEED,
	PILOT_SNAPSHOT_AT,
} from '../src/__tests__/integration/knowledge-eval-pilot'
import { createRouterRetriever } from '../src/__tests__/integration/knowledge-eval-router-wiring'

function logRegime(
	label: string,
	r: NonNullable<Awaited<ReturnType<typeof runPairedEval>>['router']>,
) {
	console.log(`${label}:`)
	console.log(`  totalPromptTokens:       ${r.totalPromptTokens}`)
	console.log(`  numCorrectExact:         ${r.numCorrectExact} / ${r.numPairs}`)
	console.log(`  numCorrectSemantic:      ${r.numCorrectSemantic} / ${r.numPairs}`)
	console.log(`  tokens/correct exact:    ${r.tokensPerCorrectAnswerExact.toFixed(2)}`)
	console.log(
		`  tokens/correct semantic: ${
			r.tokensPerCorrectAnswerSemantic === null
				? 'null'
				: r.tokensPerCorrectAnswerSemantic.toFixed(2)
		}`,
	)
	console.log(`  retrievalAccuracy:       ${r.retrievalAccuracy}\n`)
}

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN
	if (!apiKey) {
		throw new Error('ANTHROPIC_API_KEY or CLAUDE_OAUTH_ACCESS_TOKEN must be set')
	}
	const chat: ChatFn = (messages) => callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey)
	const judge = createAnthropicJudge(apiKey)

	const __dirname = dirname(fileURLToPath(import.meta.url))
	const artifactDir = join(__dirname, '..', 'src', '__tests__', 'integration')
	mkdirSync(artifactDir, { recursive: true })

	// Dump-only baseline first — separate real-model call, so the baseline
	// artifact is a standalone artefact (not just one leg of the paired
	// file). Both graders populate. Same fixture, same model.
	const baseline = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, chat, {
		seed: PILOT_SEED,
		fixtureSourceCommit: PILOT_SNAPSHOT_AT,
		retriever: null,
		judge,
	})
	const baselinePath = join(artifactDir, 'knowledge-eval-pilot-baseline.json')
	writeFileSync(baselinePath, `${JSON.stringify(baseline, null, 2)}\n`, 'utf-8')

	// Dump + router paired — the verdict artefact.
	const paired = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, chat, {
		seed: PILOT_SEED,
		fixtureSourceCommit: PILOT_SNAPSHOT_AT,
		retriever: createRouterRetriever(),
		judge,
	})
	const pairedPath = join(artifactDir, 'knowledge-eval-pilot-router.json')
	writeFileSync(pairedPath, `${JSON.stringify(paired, null, 2)}\n`, 'utf-8')

	console.log('\n=== pilot dump-only baseline ===')
	console.log(`model: ${baseline.model} · seed: ${baseline.seed}`)
	console.log(`pairs: ${baseline.numPairs}\n`)
	logRegime('dump', baseline.dump)
	console.log(`artifact: ${baselinePath}\n`)

	console.log('=== pilot dump + router paired ===')
	console.log(`model: ${paired.model} · seed: ${paired.seed}`)
	console.log(`pairs: ${paired.numPairs}\n`)
	logRegime('dump', paired.dump)
	if (paired.router) logRegime('router', paired.router)
	console.log(`artifact: ${pairedPath}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
