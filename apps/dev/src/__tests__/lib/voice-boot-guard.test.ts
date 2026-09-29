import { describe, expect, it } from 'vitest'
import { assertVoiceOperatorEnv } from '../../lib/voice-boot-guard'

describe('assertVoiceOperatorEnv', () => {
	it('passes when voice-mode-v1 is not enabled for any tester', () => {
		expect(() =>
			assertVoiceOperatorEnv({
				FF_TESTER_FEATURES: 'linkedin-addon-visible',
				// MASKIN_VOICE_OPENAI_API_KEY intentionally omitted
			}),
		).not.toThrow()
	})

	it('passes when voice-mode-v1 is enabled and the operator key is set', () => {
		expect(() =>
			assertVoiceOperatorEnv({
				FF_TESTER_FEATURES: 'voice-mode-v1',
				MASKIN_VOICE_OPENAI_API_KEY: 'sk-live-abc',
			}),
		).not.toThrow()
	})

	it('throws when voice-mode-v1 is enabled but the operator key is unset', () => {
		expect(() => assertVoiceOperatorEnv({ FF_TESTER_FEATURES: 'voice-mode-v1' })).toThrow(
			/MASKIN_VOICE_OPENAI_API_KEY/,
		)
	})

	it('throws when the operator key is present but empty (whitespace-only)', () => {
		expect(() =>
			assertVoiceOperatorEnv({
				FF_TESTER_FEATURES: 'voice-mode-v1',
				MASKIN_VOICE_OPENAI_API_KEY: '   ',
			}),
		).toThrow(/MASKIN_VOICE_OPENAI_API_KEY/)
	})

	it('handles the flag id appearing alongside other flag ids in the list', () => {
		expect(() =>
			assertVoiceOperatorEnv({
				FF_TESTER_FEATURES: 'linkedin-addon-visible, voice-mode-v1, some-other-flag',
			}),
		).toThrow(/MASKIN_VOICE_OPENAI_API_KEY/)
	})
})
