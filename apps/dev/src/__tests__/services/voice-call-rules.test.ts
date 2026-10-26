import { describe, expect, it } from 'vitest'
import { VOICE_STYLE_RULE, VOICE_WRITE_RULE } from '../../services/voice-call-rules'

describe('voice call rules', () => {
	it('tells the model to call a write tool first, not to ask before it', () => {
		expect(VOICE_WRITE_RULE).toContain('Do not ask for a yes before such a call')
		expect(VOICE_WRITE_RULE).not.toMatch(/Before such a call, say/)
		expect(VOICE_WRITE_RULE).toContain('One spoken yes is enough')
		expect(VOICE_WRITE_RULE).toContain('confirmation_id')
	})

	it('says a spoken yes does not answer a decision card', () => {
		expect(VOICE_WRITE_RULE).toContain('tapping it')
		expect(VOICE_WRITE_RULE).toContain('A spoken yes does not answer the card')
	})

	it('has the voice style block', () => {
		expect(VOICE_STYLE_RULE).toContain('Never say a holding phrase')
		expect(VOICE_STYLE_RULE).toContain('Answer in the language the person speaks')
		expect(VOICE_STYLE_RULE).toContain('read its content, not a summary line')
		expect(VOICE_STYLE_RULE).toContain('Never ask who is speaking')
		expect(VOICE_STYLE_RULE).toContain('only from a tool result you received in this turn')
	})
})
