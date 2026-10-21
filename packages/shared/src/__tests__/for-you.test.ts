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
})
