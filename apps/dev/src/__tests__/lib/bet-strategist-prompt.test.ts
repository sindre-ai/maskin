import { describe, expect, it } from 'vitest'
import { extractDraftTitle, isMalformedDraft } from '../../lib/bet-strategist-prompt'

const VALID_DRAFT = `## Hypothesis
We believe shipping a prompt bar for PMs will lift signups by 15%.

## Success
Lift landing → signup by 15% within 4 weeks.

## Exit criteria
If by 2026-08-15 conversion is below 8%, stop and revisit positioning.

## First test
Have 3 PMs blind-score 30 cold drafts for credibility.
`

describe('isMalformedDraft', () => {
	it('returns false for a draft containing all four required headings', () => {
		expect(isMalformedDraft(VALID_DRAFT)).toBe(false)
	})

	it('flags a draft missing one of the required headings', () => {
		const missing = VALID_DRAFT.replace('## First test', '## What to do')
		expect(isMalformedDraft(missing)).toBe(true)
	})

	it('flags empty content', () => {
		expect(isMalformedDraft('')).toBe(true)
		expect(isMalformedDraft('   \n')).toBe(true)
	})

	it('flags content with only some headings', () => {
		expect(isMalformedDraft('## Hypothesis\nSomething')).toBe(true)
	})
})

describe('extractDraftTitle', () => {
	it('returns the first non-empty line under the Hypothesis heading', () => {
		expect(extractDraftTitle(VALID_DRAFT)).toBe(
			'We believe shipping a prompt bar for PMs will lift signups by 15%.',
		)
	})

	it('truncates over-long hypothesis lines', () => {
		const long = `## Hypothesis\n${'x'.repeat(200)}\n## Success\nfoo\n`
		const title = extractDraftTitle(long)
		expect(title.length).toBeLessThanOrEqual(120)
		expect(title.endsWith('...')).toBe(true)
	})

	it('falls back to "Draft bet" when no Hypothesis section is present', () => {
		expect(extractDraftTitle('## Success\nfoo')).toBe('Draft bet')
		expect(extractDraftTitle('')).toBe('Draft bet')
	})
})
