import {
	getAsk,
	getEvidence,
	getFoldMarkdown,
	getFoldTitle,
} from '@/components/objects/object-detail-fixtures'
import { buildObjectResponse } from '../factories'

describe('object-detail-fixtures', () => {
	describe('getAsk', () => {
		it('reads _ask_title and _ask_sub from metadata', () => {
			const object = buildObjectResponse({
				metadata: { _ask_title: 'Which option wins?', _ask_sub: 'A or B?' },
			})
			expect(getAsk(object)).toEqual({ title: 'Which option wins?', sub: 'A or B?' })
		})

		it('returns null when _ask_title is missing or empty', () => {
			expect(getAsk(buildObjectResponse())).toBeNull()
			expect(getAsk(buildObjectResponse({ metadata: { _ask_sub: 'no title' } }))).toBeNull()
			expect(getAsk(buildObjectResponse({ metadata: { _ask_title: '' } }))).toBeNull()
		})

		it('returns null sub when _ask_sub is absent', () => {
			const object = buildObjectResponse({ metadata: { _ask_title: 'Question?' } })
			expect(getAsk(object)).toEqual({ title: 'Question?', sub: null })
		})
	})

	describe('fold accessors', () => {
		it('reads _fold_title', () => {
			expect(getFoldTitle(buildObjectResponse({ metadata: { _fold_title: 'Notes' } }))).toBe(
				'Notes',
			)
			expect(getFoldTitle(buildObjectResponse())).toBeNull()
		})

		it('reads _fold_markdown', () => {
			const md = '# Heading'
			expect(getFoldMarkdown(buildObjectResponse({ metadata: { _fold_markdown: md } }))).toBe(md)
			expect(getFoldMarkdown(buildObjectResponse())).toBeNull()
		})
	})

	describe('getEvidence', () => {
		it('reads _evidence_quote, _evidence_source and _evidence_date', () => {
			const object = buildObjectResponse({
				metadata: {
					_evidence_quote: 'The quote',
					_evidence_source: 'Source',
					_evidence_date: '2026-08-01',
				},
			})
			expect(getEvidence(object)).toEqual({
				quote: 'The quote',
				source: 'Source',
				date: '2026-08-01',
			})
		})

		it('returns null when quote or source is missing', () => {
			expect(getEvidence(buildObjectResponse({ metadata: { _evidence_quote: 'q' } }))).toBeNull()
			expect(getEvidence(buildObjectResponse({ metadata: { _evidence_source: 's' } }))).toBeNull()
		})

		it('returns null date when _evidence_date is absent', () => {
			const object = buildObjectResponse({
				metadata: { _evidence_quote: 'q', _evidence_source: 's' },
			})
			expect(getEvidence(object)).toEqual({ quote: 'q', source: 's', date: null })
		})
	})
})
