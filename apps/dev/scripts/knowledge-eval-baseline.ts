#!/usr/bin/env tsx
/**
 * One-shot: run the dump-into-context baseline for the frozen 20-pair
 * knowledge eval against a real model and record the number.
 *
 * Emits a JSON artifact at
 * `apps/dev/src/__tests__/integration/knowledge-eval-baseline.json` and
 * prints a summary line the harness/T5 can compare against.
 *
 * Env:
 *   ANTHROPIC_API_KEY or CLAUDE_OAUTH_ACCESS_TOKEN (one required)  real-model auth
 *   KNOWLEDGE_EVAL_MODEL              default 'claude-haiku-4-5-20251001'
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
	BASELINE_MODEL,
	EVAL_PAIRS,
	FIXTURE_SEED,
	FIXTURE_SOURCE_COMMIT,
	KNOWLEDGE_CORPUS,
	callAnthropicWithUsage,
	runDumpBaseline,
} from '../src/__tests__/integration/knowledge-eval-harness'

async function main() {
	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN
	if (!apiKey) {
		console.error(
			'ANTHROPIC_API_KEY or CLAUDE_OAUTH_ACCESS_TOKEN is required to record the baseline.',
		)
		process.exit(1)
	}

	console.log(
		`Running dump-into-context baseline: model=${BASELINE_MODEL} seed=${FIXTURE_SEED} fixture=${FIXTURE_SOURCE_COMMIT.slice(0, 8)}`,
	)

	const result = await runDumpBaseline(
		EVAL_PAIRS,
		KNOWLEDGE_CORPUS,
		(messages) => callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey),
		{
			model: BASELINE_MODEL,
			seed: FIXTURE_SEED,
			fixtureSourceCommit: FIXTURE_SOURCE_COMMIT,
		},
	)

	const __dirname = dirname(fileURLToPath(import.meta.url))
	const artifactPath = join(
		__dirname,
		'..',
		'src',
		'__tests__',
		'integration',
		'knowledge-eval-baseline.json',
	)
	mkdirSync(dirname(artifactPath), { recursive: true })
	writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')

	console.log('')
	console.log('=== Baseline ===')
	console.log(`  Pairs                       ${result.numPairs}`)
	console.log(`  Correct                     ${result.numCorrect} / ${result.numPairs}`)
	console.log(`  Total prompt tokens         ${result.totalPromptTokens}`)
	console.log(`  Avg prompt tokens / pair    ${result.avgPromptTokensPerPair.toFixed(1)}`)
	console.log(`  Tokens per correct answer   ${result.tokensPerCorrectAnswer.toFixed(1)}`)
	console.log('')
	console.log(`Artifact: ${artifactPath}`)
}

main().catch((err) => {
	console.error(err)
	process.exit(1)
})
