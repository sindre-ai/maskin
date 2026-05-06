import {
	type WorkBoardFilters,
	actorTypeMap,
	hasActiveFilters,
	isAssigneeKeyword,
	matchesFilters,
} from '@/components/work-board/filters'
import { describe, expect, it } from 'vitest'
import { buildActorListItem, buildObjectResponse } from '../../factories'

const ctx = (currentActorId: string | null = null, actors: { id: string; type: string }[] = []) => {
	const map = new Map<string, string>()
	for (const a of actors) map.set(a.id, a.type)
	return { currentActorId, actorTypeById: map }
}

describe('filters / hasActiveFilters', () => {
	it('returns false for an empty filter object', () => {
		expect(hasActiveFilters({})).toBe(false)
	})
	it('returns false when status is "all"', () => {
		expect(hasActiveFilters({ status: 'all' })).toBe(false)
	})
	it('returns true for any single filter', () => {
		expect(hasActiveFilters({ bet: 'b1' })).toBe(true)
		expect(hasActiveFilters({ assignee: 'mine' })).toBe(true)
		expect(hasActiveFilters({ status: 'blocked' })).toBe(true)
		expect(hasActiveFilters({ status: 'active' })).toBe(true)
	})
})

describe('filters / isAssigneeKeyword', () => {
	it('recognizes the three keywords', () => {
		expect(isAssigneeKeyword('mine')).toBe(true)
		expect(isAssigneeKeyword('humans')).toBe(true)
		expect(isAssigneeKeyword('agents')).toBe(true)
	})
	it('rejects arbitrary strings', () => {
		expect(isAssigneeKeyword('actor-1')).toBe(false)
		expect(isAssigneeKeyword('')).toBe(false)
	})
})

describe('filters / matchesFilters — assignee', () => {
	it('matches "mine" against the current actor id', () => {
		const me = buildObjectResponse({ owner: 'actor-me' })
		const them = buildObjectResponse({ owner: 'actor-them' })
		const f: WorkBoardFilters = { assignee: 'mine' }
		expect(matchesFilters(me, f, ctx('actor-me'))).toBe(true)
		expect(matchesFilters(them, f, ctx('actor-me'))).toBe(false)
	})

	it('matches "humans" / "agents" against owner type', () => {
		const ownedByHuman = buildObjectResponse({ owner: 'a-human' })
		const ownedByAgent = buildObjectResponse({ owner: 'an-agent' })
		const c = ctx(null, [
			{ id: 'a-human', type: 'human' },
			{ id: 'an-agent', type: 'agent' },
		])
		expect(matchesFilters(ownedByHuman, { assignee: 'humans' }, c)).toBe(true)
		expect(matchesFilters(ownedByHuman, { assignee: 'agents' }, c)).toBe(false)
		expect(matchesFilters(ownedByAgent, { assignee: 'agents' }, c)).toBe(true)
		expect(matchesFilters(ownedByAgent, { assignee: 'humans' }, c)).toBe(false)
	})

	it('matches a specific actor id', () => {
		const t = buildObjectResponse({ owner: 'actor-x' })
		expect(matchesFilters(t, { assignee: 'actor-x' }, ctx())).toBe(true)
		expect(matchesFilters(t, { assignee: 'actor-y' }, ctx())).toBe(false)
	})

	it('drops tasks with no owner under any assignee filter', () => {
		const t = buildObjectResponse({ owner: null })
		expect(matchesFilters(t, { assignee: 'mine' }, ctx('actor-x'))).toBe(false)
		expect(matchesFilters(t, { assignee: 'humans' }, ctx())).toBe(false)
	})
})

describe('filters / matchesFilters — status', () => {
	it('"blocked" keeps only blocked tasks', () => {
		const blocked = buildObjectResponse({ status: 'blocked' })
		const todo = buildObjectResponse({ status: 'todo' })
		expect(matchesFilters(blocked, { status: 'blocked' }, ctx())).toBe(true)
		expect(matchesFilters(todo, { status: 'blocked' }, ctx())).toBe(false)
	})
	it('"active" hides done', () => {
		const done = buildObjectResponse({ status: 'done' })
		const todo = buildObjectResponse({ status: 'todo' })
		expect(matchesFilters(done, { status: 'active' }, ctx())).toBe(false)
		expect(matchesFilters(todo, { status: 'active' }, ctx())).toBe(true)
	})
	it('"all" or undefined keeps everything', () => {
		const done = buildObjectResponse({ status: 'done' })
		expect(matchesFilters(done, { status: 'all' }, ctx())).toBe(true)
		expect(matchesFilters(done, {}, ctx())).toBe(true)
	})
})

describe('filters / matchesFilters — multi-filter AND', () => {
	it('requires every active filter to pass', () => {
		const t = buildObjectResponse({ owner: 'actor-x', status: 'in_progress' })
		const c = ctx(null, [{ id: 'actor-x', type: 'human' }])
		// Both pass → match
		expect(matchesFilters(t, { assignee: 'humans', status: 'active' }, c)).toBe(true)
		// Status fails → no match
		expect(
			matchesFilters({ ...t, status: 'done' }, { assignee: 'humans', status: 'active' }, c),
		).toBe(false)
		// Assignee fails → no match
		expect(matchesFilters(t, { assignee: 'agents', status: 'active' }, c)).toBe(false)
	})
})

describe('filters / actorTypeMap', () => {
	it('maps actor ids to their types', () => {
		const a1 = buildActorListItem({ id: 'a-1', type: 'human' })
		const a2 = buildActorListItem({ id: 'a-2', type: 'agent' })
		const map = actorTypeMap([a1, a2])
		expect(map.get('a-1')).toBe('human')
		expect(map.get('a-2')).toBe('agent')
	})
	it('returns an empty map for undefined input', () => {
		expect(actorTypeMap(undefined).size).toBe(0)
	})
})
