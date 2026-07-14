/**
 * Baseline harness for the 20-pair knowledge eval.
 *
 * Runs three checks:
 *   1. Fixture shape (20 corpus rows, 20 pairs, every pair points at a row).
 *   2. Grader semantics on a hand-rolled sample.
 *   3. Dump-into-context path against a real model, guarded by
 *      `RUN_KNOWLEDGE_EVAL_BASELINE=1` + `OPENAI_API_KEY`. Skipped in CI by
 *      default; run manually to record the number.
 *
 * T5's router test file imports the fixture module directly. This file owns
 * the harness only (single-writer-per-file per the branching skill).
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
	BASELINE_MODEL,
	EVAL_PAIRS,
	FIXTURE_SEED,
	FIXTURE_SOURCE_COMMIT,
	KNOWLEDGE_CORPUS,
	callAnthropicWithUsage,
	gradeAnswer,
	runDumpBaseline,
	serialiseCorpus,
} from './knowledge-eval-harness'

const __dirname = dirname(fileURLToPath(import.meta.url))

describe('knowledge-eval fixture', () => {
	it('freezes exactly 20 corpus rows and 20 pairs', () => {
		expect(KNOWLEDGE_CORPUS.length).toBe(20)
		expect(EVAL_PAIRS.length).toBe(20)
	})

	it('every pair resolves to a corpus row (no dangling fixtureIds)', () => {
		const ids = new Set(KNOWLEDGE_CORPUS.map((row) => row.fixtureId))
		for (const pair of EVAL_PAIRS) {
			expect(ids.has(pair.expectedFixtureId)).toBe(true)
		}
	})

	it('every expected excerpt is present in its source corpus row (title or content)', () => {
		const byId = new Map(KNOWLEDGE_CORPUS.map((row) => [row.fixtureId, row]))
		for (const pair of EVAL_PAIRS) {
			const row = byId.get(pair.expectedFixtureId)
			expect(row).toBeDefined()
			// Title and content are both dumped into the prompt, so a grounded
			// answer can legitimately quote from either. A pair whose excerpt is
			// in neither is unanswerable and would silently score as wrong.
			const source = `${row?.title ?? ''}\n${row?.content ?? ''}`
			expect(gradeAnswer(source, pair.expectedExcerpt)).toBe(true)
		}
	})
})

describe('knowledge-eval grader', () => {
	it('matches substrings case- and whitespace-insensitively', () => {
		expect(
			gradeAnswer(
				'The answer is a Colored Dot + one-word LOWERCASE label.',
				'colored dot + one-word lowercase label',
			),
		).toBe(true)
		expect(
			gradeAnswer(
				'mentions   colored dot + one-word\nlowercase label directly',
				'colored dot + one-word lowercase label',
			),
		).toBe(true)
	})

	it('rejects a null answer', () => {
		expect(gradeAnswer(null, 'anything')).toBe(false)
	})

	it('rejects an answer that omits the excerpt', () => {
		expect(gradeAnswer('some unrelated response', 'colored dot + one-word lowercase label')).toBe(
			false,
		)
	})
})

describe('knowledge-eval dump-into-context path', () => {
	it('serialises the corpus into the user message once per question', () => {
		const serialised = serialiseCorpus(KNOWLEDGE_CORPUS)
		// Every row's title should appear exactly once in the serialised block.
		for (const row of KNOWLEDGE_CORPUS) {
			const occurrences = serialised.split(row.title).length - 1
			expect(occurrences).toBe(1)
		}
	})

	const apiKey = process.env.ANTHROPIC_API_KEY ?? process.env.CLAUDE_OAUTH_ACCESS_TOKEN ?? undefined
	const shouldRunBaseline = process.env.RUN_KNOWLEDGE_EVAL_BASELINE === '1' && Boolean(apiKey)

	it.runIf(shouldRunBaseline)(
		'records the dump-into-context baseline against a real model',
		async () => {
			const result = await runDumpBaseline(
				EVAL_PAIRS,
				KNOWLEDGE_CORPUS,
				(messages) => callAnthropicWithUsage(messages, BASELINE_MODEL, apiKey as string),
				{
					model: BASELINE_MODEL,
					seed: FIXTURE_SEED,
					fixtureSourceCommit: FIXTURE_SOURCE_COMMIT,
				},
			)
			expect(result.numPairs).toBe(20)
			expect(result.numCorrect).toBeGreaterThan(0)
			expect(result.totalPromptTokens).toBeGreaterThan(0)
			expect(Number.isFinite(result.tokensPerCorrectAnswer)).toBe(true)

			const artifactPath = join(__dirname, 'knowledge-eval-baseline.json')
			mkdirSync(dirname(artifactPath), { recursive: true })
			writeFileSync(artifactPath, `${JSON.stringify(result, null, 2)}\n`, 'utf-8')
		},
		120_000,
	)
})
