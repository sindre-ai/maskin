import { describe, expect, it } from 'vitest'
import { parseChannelRef } from '../../../../lib/integrations/providers/youtube/channel-ref'

const ID = 'UCabcdefghijklmnopqrstuv'

describe('parseChannelRef', () => {
	it.each([
		[ID, { id: ID }],
		['@maskin', { forHandle: '@maskin' }],
		[`https://www.youtube.com/channel/${ID}`, { id: ID }],
		[`youtube.com/channel/${ID}/videos`, { id: ID }],
		['https://www.youtube.com/@maskin', { forHandle: '@maskin' }],
		['https://m.youtube.com/@maskin/videos', { forHandle: '@maskin' }],
		['https://www.youtube.com/user/somebody', { forUsername: 'somebody' }],
		['  @maskin  ', { forHandle: '@maskin' }],
	])('resolves %s', (input, expected) => {
		expect(parseChannelRef(input)).toEqual(expected)
	})

	it.each([
		'maskin',
		'https://www.youtube.com/c/maskin',
		'https://www.youtube.com/watch?v=dQw4w9WgXcQ',
		'https://www.youtube.com/channel/notachannelid',
		'https://evil.example.com/@maskin',
		'https://youtube.com.evil.example.com/@maskin',
		'@a',
		'',
	])('refuses %s with INVALID_INPUT', (input) => {
		expect(() => parseChannelRef(input)).toThrowError(
			expect.objectContaining({ code: 'INVALID_INPUT' }),
		)
	})
})
