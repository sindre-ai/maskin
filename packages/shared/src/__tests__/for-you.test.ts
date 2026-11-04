import { describe, expect, it } from 'vitest'
import { FOR_YOU_KIND, parseForYouMetadata } from '../schemas/for-you'

const base = { kind: FOR_YOU_KIND, rank: 1, headline: 'Approve the launch' }

describe('parseForYouMetadata', () => {
	it('accepts the source comment id as a number', () => {
		expect(parseForYouMetadata({ ...base, source_comment_id: 947928 })?.source_comment_id).toBe(
			947928,
		)
	})

	it('accepts the source comment id as digits in a string, as event ids arrive from the API', () => {
		expect(parseForYouMetadata({ ...base, source_comment_id: '947928' })?.source_comment_id).toBe(
			947928,
		)
	})

	it('still rejects a source comment id that is not a number', () => {
		expect(parseForYouMetadata({ ...base, source_comment_id: 'abc' })).toBeNull()
		expect(parseForYouMetadata({ ...base, source_comment_id: '12.5' })).toBeNull()
	})

	it('treats the source comment id as optional', () => {
		expect(parseForYouMetadata(base)).not.toBeNull()
	})

	it('ignores extra keys an agent adds', () => {
		expect(parseForYouMetadata({ ...base, tags: ['posthog'] })).not.toBeNull()
	})

	it('keeps a card whose optional fields are null, as if they were absent', () => {
		const parsed = parseForYouMetadata({
			...base,
			rationale: null,
			source_comment_id: null,
			only_while_status: null,
		})
		expect(parsed).not.toBeNull()
		expect(parsed?.only_while_status).toBeUndefined()
		expect(parsed?.source_comment_id).toBeUndefined()
		expect(parsed?.rationale).toBeUndefined()
	})

	it('keeps a card whose only_while_status is an empty list, with no status constraint', () => {
		const parsed = parseForYouMetadata({ ...base, only_while_status: [] })
		expect(parsed).not.toBeNull()
		expect(parsed?.only_while_status).toBeUndefined()
	})

	it('still honours a real only_while_status and still rejects a malformed one', () => {
		const kept = parseForYouMetadata({ ...base, only_while_status: ['proposed'] })
		expect(kept?.only_while_status).toEqual(['proposed'])
		expect(parseForYouMetadata({ ...base, only_while_status: [''] })).toBeNull()
		expect(parseForYouMetadata({ ...base, only_while_status: 'proposed' })).toBeNull()
	})
})
