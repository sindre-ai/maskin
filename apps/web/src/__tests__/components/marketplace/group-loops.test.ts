import { groupLoopsByUseCase } from '@/components/marketplace/group-loops'
import type { MarketplaceLoopSummary } from '@/lib/api'
import { describe, expect, it } from 'vitest'

function loop(id: string, useCase: string | null): MarketplaceLoopSummary {
	return {
		id,
		name: `Loop ${id}`,
		slug: id,
		description: '',
		version: '1.0.0',
		use_case: useCase,
		item_types: ['actor', 'trigger'],
		created_at: null,
		updated_at: null,
	}
}

describe('groupLoopsByUseCase', () => {
	it('sorts groups A to Z regardless of case', () => {
		const groups = groupLoopsByUseCase([
			loop('1', 'sales'),
			loop('2', 'Discovery'),
			loop('3', 'Growth'),
		])
		expect(groups.map((g) => g.name)).toEqual(['Discovery', 'Growth', 'sales'])
	})

	it('puts flows with no use case in a final Other group', () => {
		const groups = groupLoopsByUseCase([
			loop('1', null),
			loop('2', 'Zeta'),
			loop('3', '  '),
			loop('4', 'Alpha'),
		])
		expect(groups.map((g) => g.name)).toEqual(['Alpha', 'Zeta', 'Other'])
		expect(groups[2].loops.map((l) => l.id)).toEqual(['1', '3'])
	})

	it('keeps incoming order inside a group', () => {
		const groups = groupLoopsByUseCase([loop('b', 'Sales'), loop('a', 'Sales')])
		expect(groups).toHaveLength(1)
		expect(groups[0].loops.map((l) => l.id)).toEqual(['b', 'a'])
	})

	it('returns no groups for no flows', () => {
		expect(groupLoopsByUseCase([])).toEqual([])
	})

	it('returns a single Other group when no flow has a use case', () => {
		const groups = groupLoopsByUseCase([loop('1', null)])
		expect(groups.map((g) => g.name)).toEqual(['Other'])
	})
})
