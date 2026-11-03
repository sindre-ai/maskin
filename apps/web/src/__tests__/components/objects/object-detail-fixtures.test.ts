import { getAsk, getDocumentFold, getEvidence } from '@/components/objects/object-detail-fixtures'
import { buildObjectResponse } from '../../factories'

describe('getAsk', () => {
	it('returns the _ask string when present', () => {
		const object = buildObjectResponse({ metadata: { _ask: 'Should we ship this?' } })
		expect(getAsk(object)).toBe('Should we ship this?')
	})

	it('returns null when _ask is missing', () => {
		expect(getAsk(buildObjectResponse({ metadata: null }))).toBeNull()
		expect(getAsk(buildObjectResponse({ metadata: { other: 'x' } }))).toBeNull()
	})

	it('returns null for empty or non-string _ask', () => {
		expect(getAsk(buildObjectResponse({ metadata: { _ask: '' } }))).toBeNull()
		expect(getAsk(buildObjectResponse({ metadata: { _ask: 5 } }))).toBeNull()
	})
})

describe('getEvidence', () => {
	it('returns an empty list when quote is missing', () => {
		expect(getEvidence(buildObjectResponse({ metadata: null }))).toEqual([])
		expect(getEvidence(buildObjectResponse({ metadata: { _evidence_source: 'src' } }))).toEqual([])
	})

	it('returns quote without optional fields', () => {
		const object = buildObjectResponse({ metadata: { _evidence_quote: 'A quote' } })
		expect(getEvidence(object)).toEqual([{ quote: 'A quote', source: undefined, date: undefined }])
	})

	it('returns quote with source and date', () => {
		const object = buildObjectResponse({
			metadata: {
				_evidence_quote: 'A quote',
				_evidence_source: 'Slack #general',
				_evidence_date: '2026-08-01',
			},
		})
		expect(getEvidence(object)).toEqual([
			{
				quote: 'A quote',
				source: 'Slack #general',
				date: '2026-08-01',
			},
		])
	})

	// Indexed variants let a document carry a row of pull-quotes (mockup 1127).
	it('collects indexed evidence quotes in order and stops at the first gap', () => {
		const object = buildObjectResponse({
			metadata: {
				_evidence_quote: 'First',
				_evidence_quote_2: 'Second',
				_evidence_source_2: 'Slack',
				_evidence_quote_4: 'Never reached',
			},
		})
		expect(getEvidence(object).map((e) => e.quote)).toEqual(['First', 'Second'])
	})
})

describe('getDocumentFold', () => {
	it('returns null when either fold field is missing', () => {
		expect(getDocumentFold(buildObjectResponse({ metadata: null }))).toBeNull()
		expect(getDocumentFold(buildObjectResponse({ metadata: { _fold_title: 'Notes' } }))).toBeNull()
		expect(
			getDocumentFold(buildObjectResponse({ metadata: { _fold_markdown: 'body' } })),
		).toBeNull()
	})

	it('returns title and markdown when both present', () => {
		const object = buildObjectResponse({
			metadata: { _fold_title: 'Research notes', _fold_markdown: '# Notes\n\nBody' },
		})
		expect(getDocumentFold(object)).toEqual({
			title: 'Research notes',
			markdown: '# Notes\n\nBody',
		})
	})
})
