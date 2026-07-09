import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// The Code Reviewer system prompts in `packages/db/src/seed.ts` are the source of
// truth for the CR system prompt shipped in the `code-reviewer` and
// `development-pipeline` catalog packages. The success metric of
// "Give build agents a code-time docs/API reference lookup" counts findings
// tagged with the exact strings below. Renaming or removing them silently
// breaks the metric — this test guards both copies at once.

const REQUIRED_TAGS = ['[wrong-api]', '[hallucinated-signature]', '[version-mismatch]'] as const

const seedPath = resolve(dirname(fileURLToPath(import.meta.url)), '../../../db/src/seed.ts')
const seedSource = readFileSync(seedPath, 'utf8')

describe('seed.ts Code Reviewer tag taxonomy', () => {
	it.each(REQUIRED_TAGS)('mentions %s at least twice (both CR prompt copies)', (tag) => {
		const matches = seedSource.split(tag).length - 1
		expect(matches).toBeGreaterThanOrEqual(2)
	})

	it('records a one-line definition per new tag in both copies', () => {
		// Each tag must appear as a bulleted line with definition text after it, in
		// both CR prompt copies. The prompts are template literals so backticks are
		// escaped in-source (`\``), and definitions follow after an em-dash.
		for (const tag of REQUIRED_TAGS) {
			const needle = `- \\\`${tag}\\\` — `
			const matches = seedSource.split(needle).length - 1
			expect(matches, `missing definition line for ${tag}`).toBeGreaterThanOrEqual(2)
		}
	})

	it('names the umbrella + two sub-cases so precedence is unambiguous', () => {
		const precedenceCount = seedSource.split('Precedence: prefer').length - 1
		expect(precedenceCount).toBeGreaterThanOrEqual(2)
	})
})
