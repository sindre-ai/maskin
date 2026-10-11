import { describe, expect, it } from 'vitest'
import { readEmptyTurnFallbackModel } from '../../lib/empty-turn-fallback'

describe('readEmptyTurnFallbackModel', () => {
	it('returns the configured model, trimmed', () => {
		expect(
			readEmptyTurnFallbackModel({
				CHAT_EMPTY_TURN_FALLBACK_MODEL: ' deepseek/deepseek-v4-flash ',
			}),
		).toBe('deepseek/deepseek-v4-flash')
	})

	it('is off when unset or blank', () => {
		expect(readEmptyTurnFallbackModel({})).toBeNull()
		expect(readEmptyTurnFallbackModel({ CHAT_EMPTY_TURN_FALLBACK_MODEL: '   ' })).toBeNull()
	})

	it('is off, rather than throwing, when the value is not a model name', () => {
		expect(readEmptyTurnFallbackModel({ CHAT_EMPTY_TURN_FALLBACK_MODEL: 'two words' })).toBeNull()
		expect(readEmptyTurnFallbackModel({ CHAT_EMPTY_TURN_FALLBACK_MODEL: 'a"b' })).toBeNull()
	})
})
