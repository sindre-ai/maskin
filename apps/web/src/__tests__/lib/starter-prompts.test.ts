import { starterPromptsForAgents } from '@/lib/starter-prompts'
import { describe, expect, it } from 'vitest'

const actors = [
	{ id: 'a1', starter_prompts: ['What needs me today?', 'Summarise the open decisions'] },
	{ id: 'a2', starter_prompts: [] },
	{ id: 'a3' },
	{ id: 'a4', starter_prompts: ['  Padded  ', 7, 'line\nbreak'] as unknown as string[] },
]

describe('starterPromptsForAgents', () => {
	it('returns the prompts of the one agent in the chat', () => {
		expect(starterPromptsForAgents(['a1'], actors)).toEqual([
			'What needs me today?',
			'Summarise the open decisions',
		])
	})

	it('offers nothing for an agent that set none, with no stand-in list', () => {
		expect(starterPromptsForAgents(['a2'], actors)).toEqual([])
		expect(starterPromptsForAgents(['a3'], actors)).toEqual([])
	})

	it('offers nothing with no agent or with several, since nobody’s openers fit a group', () => {
		expect(starterPromptsForAgents([], actors)).toEqual([])
		expect(starterPromptsForAgents(['a1', 'a2'], actors)).toEqual([])
	})

	it('offers nothing while the actor list is loading or the agent is unknown', () => {
		expect(starterPromptsForAgents(['a1'], undefined)).toEqual([])
		expect(starterPromptsForAgents(['missing'], actors)).toEqual([])
	})

	it('drops a stored value that could not be sent as written', () => {
		expect(starterPromptsForAgents(['a4'], actors)).toEqual(['Padded'])
	})
})
