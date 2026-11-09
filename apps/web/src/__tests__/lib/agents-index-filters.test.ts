import { NO_TEAM, buildAgentFilterPills, buildTeamChips } from '@/lib/agents-index-filters'
import { describe, expect, it } from 'vitest'

describe('buildTeamChips', () => {
	it('counts agents per team, A to Z, with the catch-all last', () => {
		const chips = buildTeamChips(['Zeta', NO_TEAM, 'alpha', 'Zeta', NO_TEAM, 'Zeta'])
		expect(chips).toEqual([
			{ team: 'alpha', count: 1 },
			{ team: 'Zeta', count: 3 },
			{ team: NO_TEAM, count: 2 },
		])
	})

	it('sorts numbers inside names the way a reader counts', () => {
		const chips = buildTeamChips(['Team 10', 'Team 2'])
		expect(chips.map((c) => c.team)).toEqual(['Team 2', 'Team 10'])
	})

	it('has no chip for a team with no agents', () => {
		expect(buildTeamChips([])).toEqual([])
	})
})

describe('buildAgentFilterPills', () => {
	const statusLabel = (bucket: string) => bucket.toUpperCase()

	it('has no pills when nothing is filtered', () => {
		expect(buildAgentFilterPills({ statuses: [], team: undefined, statusLabel })).toEqual([])
	})

	it('names every active filter, status first', () => {
		const pills = buildAgentFilterPills({
			statuses: ['working', 'idle'],
			team: 'Zeta flow',
			statusLabel,
		})
		expect(pills).toEqual([
			{ id: 'status', label: 'Status', value: 'WORKING, IDLE' },
			{ id: 'team', label: 'Team', value: 'Zeta flow' },
		])
	})
})
