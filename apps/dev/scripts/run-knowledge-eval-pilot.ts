/**
 * Standalone runner for the pilot paired eval — bypasses the vitest
 * integration harness (which requires Postgres) so we can produce the
 * verdict artifact from any node environment with an Anthropic token.
 *
 * Usage:
 *   RUN_KNOWLEDGE_EVAL_PILOT=1 \
 *     ANTHROPIC_API_KEY=... \
 *     tsx apps/dev/scripts/run-knowledge-eval-pilot.ts
 *
 * Emits `knowledge-eval-pilot.json` next to the fixture file. Both
 * grader modes populate.
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

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN
	if (!apiKey) {
		throw new Error('ANTHROPIC_API_KEY or CLAUDE_OAUTH_ACCESS_TOKEN must be set')
	}
	const chat: ChatFn = (messages) => callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey)
	const judge = createAnthropicJudge(apiKey)

	const result = await runPairedEval(PILOT_PAIRS, PILOT_CORPUS, chat, {
		seed: PILOT_SEED,
		fixtureSourceCommit: PILOT_SNAPSHOT_AT,
		retriever: createRouterRetriever(),
		judge,
	})

	const __dirname = dirname(fileURLToPath(import.meta.url))
	const artifactPath = join(
		__dirname,
		'..',
		'src',
		'__tests__',
		'integration',
		'knowledge-eval-pilot.json',
	)
	mkdirSync(dirname(artifactPath), { recursive: true })
	writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')

	const dump = result.dump
	const router = result.router
	console.log('\n=== pilot paired-run ===')
	console.log(`model: ${result.model} · seed: ${result.seed}`)
	console.log(`pairs: ${result.numPairs}\n`)
	console.log('dump:')
	console.log(`  totalPromptTokens: ${dump.totalPromptTokens}`)
	console.log(`  numCorrectExact:    ${dump.numCorrectExact} / ${dump.numPairs}`)
	console.log(`  numCorrectSemantic: ${dump.numCorrectSemantic} / ${dump.numPairs}`)
	console.log(`  tokens/correct exact:    ${dump.tokensPerCorrectAnswerExact.toFixed(2)}`)
	console.log(
		`  tokens/correct semantic: ${
			dump.tokensPerCorrectAnswerSemantic === null
				? 'null'
				: dump.tokensPerCorrectAnswerSemantic.toFixed(2)
		}`,
	)
	console.log(`  retrievalAccuracy:  ${dump.retrievalAccuracy}\n`)
	if (router) {
		console.log('router:')
		console.log(`  totalPromptTokens: ${router.totalPromptTokens}`)
		console.log(`  numCorrectExact:    ${router.numCorrectExact} / ${router.numPairs}`)
		console.log(`  numCorrectSemantic: ${router.numCorrectSemantic} / ${router.numPairs}`)
		console.log(`  tokens/correct exact:    ${router.tokensPerCorrectAnswerExact.toFixed(2)}`)
		console.log(
			`  tokens/correct semantic: ${
				router.tokensPerCorrectAnswerSemantic === null
					? 'null'
					: router.tokensPerCorrectAnswerSemantic.toFixed(2)
			}`,
		)
		console.log(`  retrievalAccuracy:  ${router.retrievalAccuracy}\n`)
	}
	console.log(`artifact: ${artifactPath}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
