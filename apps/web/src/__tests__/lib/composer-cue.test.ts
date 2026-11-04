import {
	type ComposerCueInput,
	HINT_NOBODY,
	HINT_PEOPLE_ONLY,
	NEUTRAL_PLACEHOLDER,
	deriveComposerCue,
} from '@/lib/composer-cue'
import { describe, expect, it } from 'vitest'

const ME = { actorId: 'me', actorName: 'Me', actorType: 'human' as const }
const AGENT_A = { actorId: 'agent-a', actorName: 'Forge', actorType: 'agent' as const }
const AGENT_B = { actorId: 'agent-b', actorName: 'Sentinel', actorType: 'agent' as const }
const AGENT_C = { actorId: 'agent-c', actorName: 'Atlas', actorType: 'agent' as const }
const PERSON = { actorId: 'person-1', actorName: 'Sam', actorType: 'human' as const }

const say = (actorId: string, actorType: 'human' | 'agent') => ({
	actorId,
	actorType,
	kind: 'message' as const,
})

function cue(overrides: Partial<ComposerCueInput> = {}) {
	return deriveComposerCue({
		selfId: 'me',
		participants: [ME, AGENT_A, AGENT_B],
		taggedIds: [],
		messages: [],
		hasMoreMessages: false,
		...overrides,
	})
}

describe('deriveComposerCue', () => {
	it('is not used in a chat with fewer than 3 participants', () => {
		expect(cue({ participants: [ME, AGENT_A] })).toBeNull()
	})

	it('names the agent who spoke last when nobody else has written since', () => {
		const result = cue({
			messages: [say('agent-b', 'agent'), say('me', 'human'), say('agent-a', 'agent')],
		})
		expect(result).toEqual({ placeholder: 'Reply to Forge…', hint: null })
	})

	it('skips the sender’s own messages when finding the last other writer', () => {
		const result = cue({
			messages: [say('agent-b', 'agent'), say('me', 'human'), say('me', 'human')],
		})
		expect(result).toEqual({ placeholder: 'Reply to Sentinel…', hint: null })
	})

	it('says nobody will answer when a person spoke last', () => {
		const result = cue({
			participants: [ME, AGENT_A, PERSON],
			messages: [say('agent-a', 'agent'), say('person-1', 'human')],
		})
		expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_NOBODY })
	})

	it('says nobody will answer when the last speaker has left the chat', () => {
		const result = cue({ messages: [say('agent-c', 'agent')] })
		expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_NOBODY })
	})

	it('counts a participant of an unknown type as a person', () => {
		const result = cue({
			participants: [ME, AGENT_A, { actorId: 'x', actorName: 'X', actorType: 'system' }],
			messages: [say('x', 'human')],
		})
		expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_NOBODY })
	})

	it('ignores system rows when finding the last writer', () => {
		const result = cue({
			messages: [
				say('agent-a', 'agent'),
				{ actorId: 'agent-b', actorType: 'agent', kind: 'system' },
			],
		})
		expect(result).toEqual({ placeholder: 'Reply to Forge…', hint: null })
	})

	describe('a fresh chat', () => {
		it('names the agent when there is exactly one', () => {
			const result = cue({ participants: [ME, AGENT_A, PERSON], messages: [] })
			expect(result).toEqual({ placeholder: 'Reply to Forge…', hint: null })
		})

		it('says nobody will answer with two or more agents', () => {
			expect(cue({ messages: [] })).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_NOBODY })
		})

		it('treats the new-chat screen as a first message with nobody having spoken', () => {
			const oneAgent = cue({ participants: [ME, AGENT_A, PERSON], messages: null, isNewChat: true })
			const twoAgents = cue({ messages: null, isNewChat: true })
			expect(oneAgent).toEqual({ placeholder: 'Reply to Forge…', hint: null })
			expect(twoAgents).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_NOBODY })
		})
	})

	describe('tags', () => {
		it('names one tagged agent whoever spoke last', () => {
			const result = cue({ taggedIds: ['agent-b'], messages: [say('agent-a', 'agent')] })
			expect(result).toEqual({ placeholder: 'Reply to Sentinel…', hint: null })
		})

		it('names two tagged agents', () => {
			const result = cue({ taggedIds: ['agent-a', 'agent-b'] })
			expect(result).toEqual({ placeholder: 'Reply to Forge and Sentinel…', hint: null })
		})

		it('counts three or more', () => {
			const result = cue({
				participants: [ME, AGENT_A, AGENT_B, AGENT_C],
				taggedIds: ['agent-a', 'agent-b', 'agent-c'],
			})
			expect(result).toEqual({ placeholder: 'Reply to 3 agents…', hint: null })
		})

		it('says only people are tagged when the tags name no agent', () => {
			const result = cue({ participants: [ME, AGENT_A, PERSON], taggedIds: ['person-1'] })
			expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_PEOPLE_ONLY })
		})

		it('ignores a tagged person next to a tagged agent', () => {
			const result = cue({
				participants: [ME, AGENT_A, PERSON],
				taggedIds: ['person-1', 'agent-a'],
			})
			expect(result).toEqual({ placeholder: 'Reply to Forge…', hint: null })
		})

		it('counts an agent who is tagged but not in the chat yet, since the server adds them first', () => {
			const result = cue({ taggedIds: ['agent-c'], joiningAgents: [AGENT_C] })
			expect(result).toEqual({ placeholder: 'Reply to Atlas…', hint: null })
		})

		it('does not count a tagged id it knows nothing about as an agent', () => {
			const result = cue({ taggedIds: ['stranger'] })
			expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_PEOPLE_ONLY })
		})

		it('does not count a tag of yourself', () => {
			const result = cue({ taggedIds: ['me'], messages: [say('agent-a', 'agent')] })
			expect(result).toEqual({ placeholder: 'Reply to Forge…', hint: null })
		})
	})

	describe('while the thread is not fully known', () => {
		it('shows the neutral placeholder and no hint while messages are loading', () => {
			expect(cue({ messages: null })).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: null })
		})

		it('does not guess when the loaded page is only the sender’s own and older pages exist', () => {
			const result = cue({ messages: [say('me', 'human')], hasMoreMessages: true })
			expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: null })
		})

		it('does not call a chat new while older pages exist', () => {
			expect(cue({ messages: [], hasMoreMessages: true })).toEqual({
				placeholder: NEUTRAL_PLACEHOLDER,
				hint: null,
			})
		})

		it('still names the last writer found on a page when older pages exist', () => {
			const result = cue({ messages: [say('agent-a', 'agent')], hasMoreMessages: true })
			expect(result).toEqual({ placeholder: 'Reply to Forge…', hint: null })
		})

		it('says nobody will answer once the whole thread is loaded and only the sender wrote', () => {
			const result = cue({ messages: [say('me', 'human')], hasMoreMessages: false })
			expect(result).toEqual({ placeholder: NEUTRAL_PLACEHOLDER, hint: HINT_NOBODY })
		})
	})
})
