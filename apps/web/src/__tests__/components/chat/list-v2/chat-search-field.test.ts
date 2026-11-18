import { suggestionsFor } from '@/components/chat/list-v2/chat-search-field'
import { operatorBeingTyped } from '@/lib/chat-list-v2'
import { describe, expect, it } from 'vitest'

const pools = { agents: ['Forge', 'Sage', 'Fox Den'], teams: ['growth', 'ops'] }

describe('suggestionsFor', () => {
	it('lists the operators with a hint each when the field is empty', () => {
		const labels = suggestionsFor(null, '', pools).map((s) => s.label)
		expect(labels).toEqual(['agent:', 'from:', 'with:', 'team:', 'is:', '"phrase"', '-word'])
	})

	it('suggests the states after is:, narrowed by what was typed', () => {
		const text = 'billing is:un'
		const out = suggestionsFor(operatorBeingTyped(text), text, pools)
		expect(out.map((s) => s.insert)).toEqual(['is:unread'])
	})

	it('suggests agents after agent: and quotes a name with a space', () => {
		const text = 'agent:f'
		const out = suggestionsFor(operatorBeingTyped(text), text, pools)
		expect(out.map((s) => s.insert)).toEqual(['agent:Forge', 'agent:"Fox Den"'])
	})

	it('suggests teams after team: and nothing once the word is complete', () => {
		expect(
			suggestionsFor(operatorBeingTyped('team:g'), 'team:g', pools).map((s) => s.insert),
		).toEqual(['team:growth'])
		expect(suggestionsFor(operatorBeingTyped('team:growth'), 'team:growth', pools)).toEqual([])
	})

	it('suggests nothing while plain words are typed', () => {
		expect(suggestionsFor(null, 'billing', pools)).toEqual([])
	})
})
