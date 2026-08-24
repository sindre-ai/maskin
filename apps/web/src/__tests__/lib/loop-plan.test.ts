import { describeLoopPlan, parseLoopDescription, summariseLoopPlan } from '@/lib/loop-plan'
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
				live: 'reused',
				stateChain: ['new', 'triage', 'approved', 'published'],
				isNew: false,
			},
		])
	})

	it('builds the trigger with WHEN clause, target agent, THEN-write and ASKS', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(plan.triggers).toEqual([
			{
				kindLabel: 'EVENT',
				whenClause: 'when a customer submits feedback',
				targetAgent: 'Feedback agent',
				thenWrites: [{ act: 'state_change', type: 'feedback', state: 'triage' }],
				isNew: true,
				whenChip: { type: 'feedback', state: 'triage' },
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
			isNew: true,
			whenChip: { type: 'feedback' },
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
			live: 'reused',
			stateChain: ['new', 'done'],
			isNew: false,
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
			kindLabel: 'EVENT',
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

describe('parseLoopDescription — proposed states stay inside the type chain', () => {
	it('drops a cue-word state the type chain cannot hold', () => {
		// 'triage' is a feedback state, not a task state. Proposing it would put a
		// status on the card that the workspace can never actually set.
		const plan = parseLoopDescription('when a task is created, have an agent triage it')
		const states = plan.triggers[0].thenWrites.map((w) => w.state).filter(Boolean)
		expect(states).not.toContain('triage')
	})

	it('falls back to a plain create when every proposed state is rejected', () => {
		const plan = parseLoopDescription('when a task is created, have an agent triage it')
		expect(plan.triggers[0].thenWrites).toEqual([{ act: 'create', type: 'task' }])
		expect(plan.triggers[0].whenChip?.state).toBeUndefined()
	})

	it('keeps a cue-word state the type chain does hold', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		const states = plan.triggers[0].thenWrites.map((w) => w.state)
		expect(states).toContain('triage')
	})

	it('honours a workspace chain that removes a state from the base chain', () => {
		// The base feedback chain has 'triage'; this workspace's does not.
		const plan = parseLoopDescription(AC_EXAMPLE, {
			statusChains: { feedback: ['new', 'reviewed', 'done'] },
		})
		const states = plan.triggers[0].thenWrites.map((w) => w.state).filter(Boolean)
		expect(states).not.toContain('triage')
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

describe('parseLoopDescription — kindLabel vs isNew', () => {
	it('reports the trigger kind in kindLabel, never the "just added" badge', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(plan.triggers[0].kindLabel).toBe('EVENT')
		expect(plan.triggers[0].isNew).toBe(true)
	})

	it('marks an object type NEW only when the workspace vocabulary lacks it', () => {
		const known = parseLoopDescription(AC_EXAMPLE, { statusChains: { feedback: ['new', 'done'] } })
		expect(known.objectTypes[0].isNew).toBe(false)

		const unknown = parseLoopDescription(AC_EXAMPLE, { statusChains: { bet: ['signal'] } })
		expect(unknown.objectTypes[0].isNew).toBe(true)
	})

	it('claims nothing is new when no workspace vocabulary is supplied', () => {
		expect(parseLoopDescription(AC_EXAMPLE).objectTypes[0].isNew).toBe(false)
	})
})

describe('parseLoopDescription — clarify signal', () => {
	it('produces no triggers and no stop point for an under-specified sentence', () => {
		const plan = parseLoopDescription('track customer feedback')
		expect(plan.triggers).toHaveLength(0)
		expect(plan.stopForOperator).toBeNull()
	})

	it('drafts a trigger once a when-clause is appended', () => {
		const plan = parseLoopDescription('track customer feedback when it comes in.')
		expect(plan.triggers.length).toBeGreaterThan(0)
	})
})

describe('describeLoopPlan / summariseLoopPlan', () => {
	it('describes the drafted loop rather than fixed copy', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		const description = describeLoopPlan(plan)
		expect(description).toContain('Moves feedback from new to published.')
		expect(description).toContain('Feedback agent')
		expect(description).toContain('It stops for you before publishing.')
	})

	it('counts what would be created and says nothing exists yet', () => {
		const plan = parseLoopDescription(AC_EXAMPLE)
		expect(summariseLoopPlan(plan)).toBe(
			'1 object type · 1 trigger · 1 agent — nothing exists in your workspace yet.',
		)
	})

	it('says nothing is drafted for an empty plan', () => {
		expect(describeLoopPlan(parseLoopDescription(''))).toBe(
			'Nothing is drafted yet — say what should happen.',
		)
	})
})

describe('parseLoopDescription — live reading and read-only types', () => {
	it('reads a type the workspace has no vocabulary for as a new type', () => {
		const plan = parseLoopDescription(AC_EXAMPLE, { statusChains: { task: ['todo', 'done'] } })
		expect(plan.objectTypes[0].isNew).toBe(true)
		expect(plan.objectTypes[0].live).toBe('new type · 4 states')
	})

	it('reads a type the workspace already runs as reused', () => {
		const plan = parseLoopDescription(AC_EXAMPLE, {
			statusChains: { feedback: ['new', 'done'] },
		})
		expect(plan.objectTypes[0].isNew).toBe(false)
		expect(plan.objectTypes[0].live).toBe('reused')
	})

	it('adds a read-only type only when the sentence reports back to it', () => {
		const reporting = parseLoopDescription(
			'when a task is done, have the Delivery agent notify the customer',
		)
		const readOnly = reporting.objectTypes.find((t) => t.readOnly)
		expect(readOnly?.type).toBe('customer')
		expect(readOnly?.note).toBe('linked, never changed by this loop')
		expect(readOnly?.stateChain).toEqual([])

		// A passing mention ("customer feedback") must not invent a type.
		const passing = parseLoopDescription(AC_EXAMPLE)
		expect(passing.objectTypes.some((t) => t.readOnly)).toBe(false)
	})
})
