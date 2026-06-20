import { splitTextByUuids } from '@/lib/object-id-detection'
import { describe, expect, it } from 'vitest'

describe('splitTextByUuids', () => {
	it('returns an empty array for empty input', () => {
		expect(splitTextByUuids('')).toEqual([])
	})

	it('returns the full string as text when no UUID is present', () => {
		expect(splitTextByUuids('just plain text')).toEqual([
			{ type: 'text', value: 'just plain text' },
		])
	})

	it('splits a bare UUID out of surrounding text', () => {
		const uuid = 'cf6545dc-74dd-4cba-ab27-16d808112bee'
		expect(splitTextByUuids(`see ${uuid} for context`)).toEqual([
			{ type: 'text', value: 'see ' },
			{ type: 'uuid', value: uuid },
			{ type: 'text', value: ' for context' },
		])
	})

	it('detects multiple UUIDs in order', () => {
		const a = 'cf6545dc-74dd-4cba-ab27-16d808112bee'
		const b = 'fbaac94e-1686-41ec-a2cb-1c96ee82a836'
		expect(splitTextByUuids(`${a} and ${b}`)).toEqual([
			{ type: 'uuid', value: a },
			{ type: 'text', value: ' and ' },
			{ type: 'uuid', value: b },
		])
	})

	it('matches uppercase UUIDs', () => {
		const uuid = 'CF6545DC-74DD-4CBA-AB27-16D808112BEE'
		expect(splitTextByUuids(uuid)).toEqual([{ type: 'uuid', value: uuid }])
	})

	it('does not match UUID substrings embedded inside larger tokens', () => {
		// e.g. an SHA1-looking suffix that contains UUID-shaped chars; word
		// boundaries on each side mean nothing is detected.
		const noisy = 'objfcf6545dc-74dd-4cba-ab27-16d808112beexyz'
		expect(splitTextByUuids(noisy)).toEqual([{ type: 'text', value: noisy }])
	})

	it('handles a UUID at the very start and end of the string', () => {
		const a = 'cf6545dc-74dd-4cba-ab27-16d808112bee'
		const b = 'fbaac94e-1686-41ec-a2cb-1c96ee82a836'
		expect(splitTextByUuids(`${a} ${b}`)).toEqual([
			{ type: 'uuid', value: a },
			{ type: 'text', value: ' ' },
			{ type: 'uuid', value: b },
		])
	})
})
