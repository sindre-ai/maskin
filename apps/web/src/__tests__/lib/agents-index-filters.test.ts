import {
	NO_TEAM,
	buildAgentFilterPills,
	buildTeamByAgentId,
	buildTeamChips,
} from '@/lib/agents-index-filters'
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

describe('buildTeamByAgentId', () => {
	it('takes the first tag, trimmed, else the catch-all', () => {
		const teams = buildTeamByAgentId([
			{ id: 'a', tags: [' writer ', 'Marketing'] },
			{ id: 'b', tags: [] },
			{ id: 'c' },
		])
		expect(teams.get('a')).toBe('Marketing')
		expect(teams.get('b')).toBe(NO_TEAM)
		expect(teams.get('c')).toBe(NO_TEAM)
	})

	it('treats tags that differ only in case as one team, in the spelling that sorts first', () => {
		const teams = buildTeamByAgentId([
			{ id: 'a', tags: ['alpha'] },
			{ id: 'b', tags: ['Alpha'] },
		])
		expect(teams.get('a')).toBe('Alpha')
		expect(teams.get('b')).toBe('Alpha')
	})

	it('orders digits by value', () => {
		const teams = buildTeamByAgentId([{ id: 'a', tags: ['Team 10', 'Team 2'] }])
		expect(teams.get('a')).toBe('Team 2')
	})
})
