import { parseLoopDescription } from '@/lib/loop-plan'
import { describe, expect, it } from 'vitest'

const AC_EXAMPLE =
	'when a customer submits feedback, have the Feedback agent triage it and ask me before publishing'

describe('parseLoopDescription — acceptance example', () => {
	it('builds the feedback object type with its state chain', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(plan.objectTypes).toEqual([
			{
				type: 'feedback',
				name: 'Feedback',
				role: 'Submissions from customers',
				live: false,
				stateChain: ['new', 'triage', 'approved', 'published'],
			},
		])
	})

	it('builds the trigger with WHEN clause, target agent, THEN-write and ASKS', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(plan.triggers).toEqual([
			{
				kindLabel: 'JUST ADDED',
				whenClause: 'when a customer submits feedback',
				targetAgent: 'Feedback agent',
				thenWrites: [{ act: 'state_change', type: 'feedback', state: 'triage' }],
				asks: 'you before publishing',
			},
		])
	})

	it('builds the agent with avatar, name, role and count', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(plan.agents).toEqual([
			{
				avatar: 'FA',
				name: 'Feedback agent',
				role: 'triages feedback and asks you before publishing',
				count: 1,
			},
		])
	})

	it('marks the exact point the loop stops for the operator', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(plan.stopForOperator).toBe('before publishing')
	})
})

describe('parseLoopDescription — cue words', () => {
	it('folds "weekly summary" into the object role, a recurring trigger and the agent role', () => {
		const plan = parseLoopDescription(
			'when a customer submits feedback, have the Feedback agent triage it and create a weekly summary',
		)
		expect(plan.objectTypes[0].role).toBe('Submissions from customers · weekly summary')
		expect(plan.triggers).toContainEqual({
			kindLabel: 'RECURRING',
			whenClause: 'when the weekly summary is due',
			targetAgent: 'Feedback agent',
			thenWrites: [{ act: 'create', type: 'feedback' }, { act: 'notify' }],
		})
		expect(plan.agents[0].role).toBe('triages feedback · writes the weekly summary')
	})

	it('folds "notify" into a notify THEN-write and the agent role', () => {
		const plan = parseLoopDescription(
			'when a customer submits feedback, have the Feedback agent triage it and notify me',
		)
		expect(plan.triggers[0].thenWrites).toContainEqual({ act: 'notify' })
		expect(plan.agents[0].role).toBe('triages feedback, notifies you')
	})

	it('folds "note" into a note object type and a create-note THEN-write', () => {
		const plan = parseLoopDescription(
			'when a customer submits feedback, have the Feedback agent triage it and take a note',
		)
		expect(plan.objectTypes).toContainEqual({
			type: 'note',
			name: 'Note',
			role: 'Captured notes',
			live: false,
			stateChain: ['new', 'done'],
		})
		expect(plan.triggers[0].thenWrites).toContainEqual({ act: 'create', type: 'note' })
	})

	it('folds "coach" into the agent role and the stop point', () => {
		const plan = parseLoopDescription(
			'when a customer submits feedback, have the Feedback agent triage it and coach me',
		)
		expect(plan.agents[0].role).toBe('triages feedback · coaches you')
		expect(plan.stopForOperator).toBe('before coaching notes are shared with you')
	})
})

describe('parseLoopDescription — second example sentence', () => {
	it('parses the bet rescue sentence into a plan', () => {
		const plan = parseLoopDescription(
			'when a bet hits at-risk, ping the Strategist to write a rescue plan',
		)
		expect(plan.objectTypes[0]).toMatchObject({
			type: 'bet',
			name: 'Bet',
			stateChain: ['signal', 'active', 'at_risk', 'rescue'],
		})
		expect(plan.triggers[0]).toMatchObject({
			kindLabel: 'JUST ADDED',
			whenClause: 'when a bet hits at-risk',
			targetAgent: 'Strategist agent',
			thenWrites: [
				{ act: 'state_change', type: 'bet', state: 'at_risk' },
				{ act: 'create', type: 'bet', state: 'rescue' },
				{ act: 'notify' },
			],
		})
		expect(plan.agents[0]).toMatchObject({
			avatar: 'SA',
			name: 'Strategist agent',
			role: 'writes the rescue plan, notifies you',
		})
	})
})

describe('parseLoopDescription — workspace status-chain composite', () => {
	it('uses the provided per-type status chain when given', () => {
		const plan = parseLoopDescription(
			'when a bet hits at-risk, ping the Strategist to write a rescue plan',
			{ statusChains: { bet: ['signal', 'active', 'live'] } },
		)
		expect(plan.objectTypes[0].stateChain).toEqual(['signal', 'active', 'live'])
	})
})

describe('parseLoopDescription — determinism and no side effects', () => {
	it('returns an identical plan for the same input', () => {
		const a = parseLoopDescription(AC_EXAMPLE)
		const b = parseLoopDescription(AC_EXAMPLE)
		expect(JSON.stringify(a)).toBe(JSON.stringify(b))
	})

	it('never invents a CSS token in the plan', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		const serialized = JSON.stringify(plan)
		expect(serialized).not.toContain('--st-')
		expect(serialized).not.toContain('--tp-')
		expect(serialized).not.toContain('--')
	})

	it('returns an empty plan for an empty description', () => {
		expect(parseLoopDescription('')).toEqual({
			objectTypes: [],
			triggers: [],
			agents: [],
			stopForOperator: null,
		})
	})

	it('still yields a plan when the description has no "when" clause', () => {
		const plan = parseLoopDescription('have the Feedback agent triage feedback weekly')
		expect(plan.objectTypes[0].type).toBe('feedback')
		expect(plan.triggers.length).toBeGreaterThan(0)
	})
})
