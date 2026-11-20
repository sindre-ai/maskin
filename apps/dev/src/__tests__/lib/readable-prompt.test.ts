import { describe, expect, it } from 'vitest'
import { isReadablePromptEnabled } from '../../lib/readable-prompt'

describe('isReadablePromptEnabled', () => {
	it('is off when unset, empty, 0, false or off', () => {
		for (const v of [undefined, '', ' ', '0', 'false', 'FALSE', 'off']) {
			expect(isReadablePromptEnabled({ MASKIN_READABLE_PROMPT: v })).toBe(false)
		}
	})

	it('is on for any other value', () => {
		for (const v of ['1', 'on', 'true', ' True ']) {
			expect(isReadablePromptEnabled({ MASKIN_READABLE_PROMPT: v })).toBe(true)
		}
	})
})
