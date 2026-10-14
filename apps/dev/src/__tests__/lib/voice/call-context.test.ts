import { describe, expect, it } from 'vitest'
import {
	CALL_CONTEXT_MAX_CHARS,
	extractCallContext,
} from '../../../lib/outreach/voice/call-context'

describe('extractCallContext', () => {
	it('returns the text under the Call context heading', () => {
		const description = [
			'## Call context',
			'Bygger skræddersyede webshops til tøjbutikker.',
			'Kunne have glæde af automatisk ordrebekræftelse.',
		].join('\n')
		expect(extractCallContext(description)).toBe(
			'Bygger skræddersyede webshops til tøjbutikker. Kunne have glæde af automatisk ordrebekræftelse.',
		)
	})

	it('stops at the next heading, so internal notes after the section never come through', () => {
		const description = [
			'Tier A, score 87',
			'',
			'## Call context',
			'Webshop-bureau i Aarhus.',
			'',
			'## Internal notes',
			'Rejected by Qualifier in May: too small. Do not mention pricing.',
		].join('\n')
		const out = extractCallContext(description)
		expect(out).toBe('Webshop-bureau i Aarhus.')
		expect(out).not.toMatch(/Tier|Rejected|pricing|score/)
	})

	it('stops at a deeper heading too, since a sub-section may hold internal notes', () => {
		const description = '# Call context\nFacts here.\n### Strategy\nSecret angle.'
		expect(extractCallContext(description)).toBe('Facts here.')
	})

	it('never includes text that sits before the section', () => {
		expect(extractCallContext('Internal: scoring 12\n\n## Call context\nOpen text.')).toBe(
			'Open text.',
		)
	})

	it('matches the heading in any case, with a colon, at any level and with closing hashes', () => {
		for (const heading of ['# call context', '### CALL CONTEXT:', '## Call context ##']) {
			expect(extractCallContext(`${heading}\nFacts.`)).toBe('Facts.')
		}
	})

	it('reads CRLF text and collapses blank lines and runs of spaces', () => {
		expect(extractCallContext('## Call context\r\n\r\nOne   fact.\r\n\r\nAnother.\r\n')).toBe(
			'One fact. Another.',
		)
	})

	it('uses the first Call context section when there are two', () => {
		expect(extractCallContext('## Call context\nFirst.\n## Call context\nSecond.')).toBe('First.')
	})

	it.each([
		['null', null],
		['undefined', undefined],
		['an empty description', ''],
		['a description without the section', '## Notes\nTier A.\n\nJust text.'],
		['an empty section', '## Call context\n\n## Notes\nTier A.'],
		['a section with only whitespace at the end of the text', '## Call context\n   \n'],
		['a heading that only mentions call context', '## Call context ideas\nSecret.'],
		['call context in running text', 'The call context is below.\nNothing.'],
	])('returns an empty string for %s', (_label, description) => {
		expect(extractCallContext(description)).toBe('')
	})

	it('caps the text at the limit', () => {
		const out = extractCallContext(`## Call context\n${'a'.repeat(CALL_CONTEXT_MAX_CHARS + 200)}`)
		expect(out).toHaveLength(CALL_CONTEXT_MAX_CHARS)
	})

	it('counts characters, not UTF-16 units, so a cut never splits an emoji', () => {
		const out = extractCallContext(`## Call context\n${'😀'.repeat(CALL_CONTEXT_MAX_CHARS + 5)}`)
		expect([...out]).toHaveLength(CALL_CONTEXT_MAX_CHARS)
		expect(out).not.toMatch(/[\uD800-\uDBFF]$/)
	})

	it('does not leave trailing whitespace when the cut lands on a space', () => {
		const out = extractCallContext(`## Call context\n${'a'.repeat(CALL_CONTEXT_MAX_CHARS - 1)} b`)
		expect(out).toBe('a'.repeat(CALL_CONTEXT_MAX_CHARS - 1))
	})
})
