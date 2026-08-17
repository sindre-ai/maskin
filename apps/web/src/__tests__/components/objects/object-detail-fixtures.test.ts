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
	it('returns null when quote is missing', () => {
		expect(getEvidence(buildObjectResponse({ metadata: null }))).toBeNull()
		expect(getEvidence(buildObjectResponse({ metadata: { _evidence_source: 'src' } }))).toBeNull()
	})

	it('returns quote without optional fields', () => {
		const object = buildObjectResponse({ metadata: { _evidence_quote: 'A quote' } })
		expect(getEvidence(object)).toEqual({ quote: 'A quote' })
	})

	it('returns quote with source and date', () => {
		const object = buildObjectResponse({
			metadata: {
				_evidence_quote: 'A quote',
				_evidence_source: 'Slack #general',
				_evidence_date: '2026-08-01',
			},
		})
		expect(getEvidence(object)).toEqual({
			quote: 'A quote',
			source: 'Slack #general',
			date: '2026-08-01',
		})
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
