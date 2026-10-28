import { describe, expect, it } from 'vitest'
import {
	STATUS_GROUPS,
	STATUS_GROUP_KEYS,
	STATUS_GROUP_LABELS,
	type StatusGroupKey,
	getStatusGroup,
	isStatusGroupKey,
} from '../search/status-groups'

// Written out row by row from the tech spec (section 2), not derived from the
// implementation's table, so a wrong entry there fails here.
const TABLE: Array<[type: string, status: string, group: StatusGroupKey]> = [
	['bet', 'opportunity', 'new'],
	['bet', 'define', 'in_progress'],
	['bet', 'active', 'in_progress'],
	['bet', 'live', 'in_progress'],
	['bet', 'succeeded', 'done'],
	['bet', 'failed', 'done'],
	['bet', 'paused', 'archived'],
	['bet', 'archived', 'archived'],

	['insight', 'new', 'new'],
	['insight', 'processing', 'in_progress'],
	['insight', 'clustered', 'in_progress'],
	['insight', 'scored', 'in_progress'],
	['insight', 'parked', 'archived'],
	['insight', 'discarded', 'archived'],

	['task', 'backlog', 'new'],
	['task', 'todo', 'new'],
	['task', 'in_progress', 'in_progress'],
	['task', 'in_review', 'needs_you'],
	['task', 'validated', 'done'],
	['task', 'done', 'done'],
	['task', 'discarded', 'archived'],

	['loop', 'draft', 'new'],
	['loop', 'pilot', 'in_progress'],
	['loop', 'learning', 'in_progress'],
	['loop', 'supervised', 'in_progress'],
	['loop', 'live', 'in_progress'],
	['loop', 'fully_autonomous', 'in_progress'],
	['loop', 'paused', 'archived'],
	['loop', 'archived', 'archived'],

	['event', 'proposed', 'new'],
	['event', 'planned', 'in_progress'],
	['event', 'in_production', 'in_progress'],
	['event', 'live', 'in_progress'],
	['event', 'published', 'done'],
	['event', 'wrapped_up', 'done'],
	['event', 'archived', 'archived'],

	['content', 'proposed', 'new'],
	['content', 'in_progress', 'in_progress'],
	['content', 'approved', 'in_progress'],
	['content', 'in_review', 'needs_you'],
	['content', 'published', 'done'],
	['content', 'live', 'done'],
	['content', 'archived', 'archived'],

	['company', 'prospect', 'new'],
	['company', 'icp_match', 'in_progress'],
	['company', 'engaged', 'in_progress'],
	['company', 'customer', 'in_progress'],
	['company', 'churned', 'archived'],
	['company', 'not_a_fit', 'archived'],

	['contact', 'new_lead', 'new'],
	['contact', 'qualified', 'in_progress'],
	['contact', 'connection_requested', 'in_progress'],
	['contact', 'messaged', 'in_progress'],
	['contact', 'in_conversation', 'in_progress'],
	['contact', 'meeting_booked', 'in_progress'],
	['contact', 'follow_up_later', 'in_progress'],
	['contact', 'offer_pending', 'needs_you'],
	['contact', 'converted', 'done'],
	['contact', 'rejected', 'archived'],
	['contact', 'not_interested', 'archived'],

	['meeting', 'scheduled', 'new'],
	['meeting', 'happened', 'in_progress'],
	['meeting', 'processed', 'done'],
	['meeting', 'cancelled', 'archived'],
	['meeting', 'archived', 'archived'],

	['knowledge', 'draft', 'new'],
	['knowledge', 'validated', 'done'],
	['knowledge', 'deprecated', 'archived'],

	// Non-object sources: chat unread/read/archived, agent_state, automation enabled.
	['chat', 'archived', 'archived'],
	['chat', 'unread', 'new'],
	['chat', 'read', 'done'],
	['agent', 'running', 'in_progress'],
	['agent', 'idle', 'in_progress'],
	['agent', 'paused', 'archived'],
	['agent', 'failed', 'needs_you'],
	['automation', 'on', 'in_progress'],
	['automation', 'off', 'archived'],
]

describe('group keys, labels and order', () => {
	it('lists the five groups in display order', () => {
		expect([...STATUS_GROUP_KEYS]).toEqual(['needs_you', 'in_progress', 'new', 'done', 'archived'])
		expect(STATUS_GROUPS.map((g) => g.label)).toEqual([
			'Needs you',
			'In progress',
			'New',
			'Done',
			'Archived',
		])
		expect(STATUS_GROUPS.map((g) => g.key)).toEqual([...STATUS_GROUP_KEYS])
	})

	it('has a label for every key', () => {
		for (const key of STATUS_GROUP_KEYS) expect(STATUS_GROUP_LABELS[key]).toBeTruthy()
	})

	it('recognises group keys', () => {
		expect(isStatusGroupKey('needs_you')).toBe(true)
		expect(isStatusGroupKey('Needs you')).toBe(false)
		expect(isStatusGroupKey(undefined)).toBe(false)
	})
})

describe('getStatusGroup: explicit table', () => {
	it.each(TABLE)('%s %s maps to %s', (type, status, group) => {
		expect(getStatusGroup(type, status)).toBe(group)
	})

	it('reads type and status case-insensitively and spaces as underscores', () => {
		expect(getStatusGroup('Task', 'In_Review')).toBe('needs_you')
		expect(getStatusGroup('task', 'in review')).toBe('needs_you')
		expect(getStatusGroup('contact', ' Offer Pending ')).toBe('needs_you')
	})

	it('lets the table win over the text rules', () => {
		// None of these has a text rule, so without the table they would be In progress.
		expect(getStatusGroup('bet', 'failed')).toBe('done')
		expect(getStatusGroup('content', 'live')).toBe('done')
		expect(getStatusGroup('insight', 'parked')).toBe('archived')
		expect(getStatusGroup('agent', 'failed')).toBe('needs_you')
	})
})

describe('getStatusGroup: text fallback', () => {
	it.each<[string, StatusGroupKey]>([
		['awaiting approval', 'needs_you'],
		['needs you', 'needs_you'],
		['decision', 'needs_you'],
		['waiting', 'needs_you'],
		['blocked', 'needs_you'],
		['pending', 'needs_you'],
		['at risk', 'needs_you'],
		['review', 'needs_you'],
		['archived', 'archived'],
		['dropped', 'archived'],
		['churned', 'archived'],
		['paused', 'archived'],
		['off', 'archived'],
		['cancelled', 'archived'],
		['done', 'done'],
		['shipped', 'done'],
		['published', 'done'],
		['completed', 'done'],
		['resolved', 'done'],
		['closed', 'done'],
		['read', 'done'],
		['finished', 'done'],
		['new', 'new'],
		['newly added', 'new'],
		['draft', 'new'],
		['proposed', 'new'],
		['unread', 'new'],
		['backlog', 'new'],
		['active', 'in_progress'],
		['watching', 'in_progress'],
		['usage down 61%', 'in_progress'],
	])('%s maps to %s', (status, group) => {
		expect(getStatusGroup('some_custom_type', status)).toBe(group)
	})

	it('reads underscores as spaces', () => {
		expect(getStatusGroup('custom', 'needs_you')).toBe('needs_you')
		expect(getStatusGroup('custom', 'at_risk')).toBe('needs_you')
	})

	it('is case-insensitive', () => {
		expect(getStatusGroup('custom', 'BLOCKED')).toBe('needs_you')
		expect(getStatusGroup('custom', 'Shipped')).toBe('done')
	})

	it('lets the first matching rule win', () => {
		// review (Needs you) comes before done, and paus (Archived) before done.
		expect(getStatusGroup('custom', 'review complete')).toBe('needs_you')
		expect(getStatusGroup('custom', 'paused after shipping')).toBe('archived')
		// unread must not be caught by the read-only rule.
		expect(getStatusGroup('custom', 'unread')).toBe('new')
	})

	it('anchors the single-word rules', () => {
		expect(getStatusGroup('custom', 'offline')).toBe('in_progress')
		expect(getStatusGroup('custom', 'already')).toBe('in_progress')
	})

	it('uses the text rules for a known type with an unlisted status', () => {
		expect(getStatusGroup('task', 'blocked')).toBe('needs_you')
		expect(getStatusGroup('bet', 'shipped')).toBe('done')
		expect(getStatusGroup('loop', 'learning_phase_two')).toBe('in_progress')
	})
})

describe('getStatusGroup: unknown input never throws', () => {
	it('falls back to In progress for an unknown type and status', () => {
		expect(getStatusGroup('contract', 'negotiating')).toBe('in_progress')
	})

	it('falls back to In progress for an empty or missing status', () => {
		expect(getStatusGroup('task', '')).toBe('in_progress')
		expect(getStatusGroup('task', '   ')).toBe('in_progress')
		expect(getStatusGroup('task', null)).toBe('in_progress')
		expect(getStatusGroup('task', undefined)).toBe('in_progress')
	})

	it('copes with a missing type', () => {
		expect(getStatusGroup(null, 'done')).toBe('done')
		expect(getStatusGroup(undefined, undefined)).toBe('in_progress')
		expect(getStatusGroup('', 'in_review')).toBe('needs_you')
	})
})
