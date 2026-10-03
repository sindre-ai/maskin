import { describe, expect, it } from 'vitest'
import {
	assistantTurns,
	firstAssistantTurn,
	lastAssistantTurn,
} from '../../../lib/outreach/voice/transcript'

const messages = [
	{ role: 'assistant', text: 'Hi Pia, this is an AI assistant.' },
	{ role: 'user', text: 'Hello' },
	{ role: 'agent', content: 'Just to confirm, one email.' },
	{ role: 'user', text: 'Yes' },
]

describe('transcript helpers', () => {
	it('reads the assistant turns in order, whichever role and text key Telnyx uses', () => {
		expect(assistantTurns(messages)).toEqual([
			'Hi Pia, this is an AI assistant.',
			'Just to confirm, one email.',
		])
		expect(firstAssistantTurn(messages)).toBe('Hi Pia, this is an AI assistant.')
		expect(lastAssistantTurn(messages)).toBe('Just to confirm, one email.')
	})

	it('treats anything that is not a message list as nothing said', () => {
		for (const bad of [undefined, null, 'a string', 42, {}, [], [null, 3, { role: 'assistant' }]]) {
			expect(firstAssistantTurn(bad)).toBeNull()
			expect(lastAssistantTurn(bad)).toBeNull()
		}
	})
})
