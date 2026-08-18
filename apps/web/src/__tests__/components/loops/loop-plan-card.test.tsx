import {
	LoopPlanCard,
	defaultLoopName,
	draftFromPlan,
	mergeDraftOntoPlan,
} from '@/components/loops/loop-plan-card'
import type { LoopPlan } from '@/lib/loop-plan'
import { fireEvent, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const plan: LoopPlan = {
	objectTypes: [
		{
			type: 'feedback',
			name: 'Feedback',
			role: 'Submissions from customers',
			live: false,
			stateChain: ['new', 'triage', 'approved', 'published'],
			isNew: true,
		},
	],
	triggers: [
		{
			kindLabel: 'EVENT',
			whenClause: 'when a new feedback is added',
			targetAgent: 'Feedback agent',
			thenWrites: [{ act: 'state_change', type: 'feedback', state: 'triage' }, { act: 'notify' }],
			isNew: true,
			whenChip: { type: 'feedback', state: 'triage' },
		},
	],
	agents: [{ avatar: 'FB', name: 'Feedback agent', role: 'triages feedback', count: 1 }],
	stopForOperator: 'before it proceeds',
}

function baseProps(overrides: Partial<Parameters<typeof LoopPlanCard>[0]> = {}) {
	return {
		plan,
		draft: draftFromPlan(plan),
		mode: 'proposed' as const,
		onDraftChange: vi.fn(),
		onAdjust: vi.fn(),
		onSave: vi.fn(),
		onCreate: vi.fn(),
		onStartOver: vi.fn(),
		workspaceId: 'ws-1',
		...overrides,
	}
}

describe('draftFromPlan / mergeDraftOntoPlan', () => {
	it('derives an editable draft from the parsed plan', () => {
		const draft = draftFromPlan(plan)
		expect(draft.name).toBe('Feedback loop')
		expect(draft.objectTypeName).toBe('Feedback')
		expect(draft.stateChain).toEqual(['new', 'triage', 'approved', 'published'])
		expect(draft.agentName).toBe('Feedback agent')
		expect(draft.stopForOperator).toBe('before it proceeds')
	})

	it('merges edits into the plan so they carry into Create', () => {
		const merged = mergeDraftOntoPlan(plan, {
			name: 'Customer feedback loop',
			objectTypeName: 'Feedback',
			stateChain: ['new', 'done'],
			agentName: 'Triage bot',
			stopForOperator: 'before approval',
		})
		expect(merged.objectTypes[0].stateChain).toEqual(['new', 'done'])
		expect(merged.agents[0].name).toBe('Triage bot')
		expect(merged.stopForOperator).toBe('before approval')
	})

	it('falls back to the plan when an edit is blanked out', () => {
		const merged = mergeDraftOntoPlan(plan, {
			...draftFromPlan(plan),
			agentName: '   ',
			stateChain: [],
			stopForOperator: '',
		})
		expect(merged.agents[0].name).toBe('Feedback agent')
		expect(merged.objectTypes[0].stateChain).toEqual(['new', 'triage', 'approved', 'published'])
		expect(merged.stopForOperator).toBe('before it proceeds')
	})

	it('derives the default loop name from the first object type', () => {
		expect(defaultLoopName(plan)).toBe('Feedback loop')
	})
})

describe('LoopPlanCard', () => {
	it('renders the object types, state chain, triggers, agents and stop point', () => {
		render(<LoopPlanCard {...baseProps()} />)

		expect(screen.getByText('PROPOSED LOOP')).toBeInTheDocument()
		expect(screen.getByText('not created yet')).toBeInTheDocument()
		expect(screen.getByText('Feedback')).toBeInTheDocument()
		expect(screen.getByText('new')).toBeInTheDocument()
		expect(screen.getAllByText('triage').length).toBeGreaterThan(0)
		// `kindLabel` is the trigger's kind; "just added" is a separate badge.
		expect(screen.getByText('EVENT')).toBeInTheDocument()
		expect(screen.getByText('JUST ADDED')).toBeInTheDocument()
		expect(screen.getByText('NEW TYPE')).toBeInTheDocument()
		expect(screen.getByText('when a new feedback is added')).toBeInTheDocument()
		// v2 renders the agent name on both the trigger row and the AGENTS section.
		expect(screen.getAllByText('Feedback agent').length).toBeGreaterThan(0)
		expect(screen.getByText('before it proceeds')).toBeInTheDocument()
	})

	it('does not fire create on render (nothing is created until Create is pressed)', () => {
		const onCreate = vi.fn()
		render(<LoopPlanCard {...baseProps({ onCreate })} />)
		expect(onCreate).not.toHaveBeenCalled()
	})

	it('switches to editable fields on Adjust and carries edits into the draft', async () => {
		const user = userEvent.setup()
		const onAdjust = vi.fn()
		const onDraftChange = vi.fn()
		const props = baseProps({ mode: 'proposed', onAdjust, onDraftChange })
		const { rerender } = render(<LoopPlanCard {...props} />)

		await user.click(screen.getByRole('button', { name: /adjust/i }))
		expect(onAdjust).toHaveBeenCalled()

		rerender(<LoopPlanCard {...baseProps({ mode: 'editing', onDraftChange })} />)
		const nameInput = screen.getByRole('textbox', { name: /object type name/i })
		fireEvent.change(nameInput, { target: { value: 'Reviews' } })
		expect(onDraftChange).toHaveBeenCalledWith(
			expect.objectContaining({ objectTypeName: 'Reviews' }),
		)
	})

	it('calls onCreate when Create loop is pressed', async () => {
		const user = userEvent.setup()
		const onCreate = vi.fn()
		render(<LoopPlanCard {...baseProps({ onCreate })} />)

		await user.click(screen.getByRole('button', { name: /create loop/i }))
		expect(onCreate).toHaveBeenCalled()
	})

	it('calls onStartOver to clear to a fresh draft', async () => {
		const user = userEvent.setup()
		const onStartOver = vi.fn()
		render(<LoopPlanCard {...baseProps({ onStartOver })} />)

		await user.click(screen.getByRole('button', { name: /^start over$/i }))
		expect(onStartOver).toHaveBeenCalled()
	})

	it('reads the footer summary off the plan rather than fixed copy', () => {
		render(<LoopPlanCard {...baseProps()} />)
		expect(
			screen.getByText(
				'1 object type · 1 trigger · 1 agent — nothing exists in your workspace yet.',
			),
		).toBeInTheDocument()
	})

	it('labels the agents section with the "from your crew" promise', () => {
		render(<LoopPlanCard {...baseProps()} />)
		expect(screen.getByText('AGENTS · from your crew, nobody new to hire')).toBeInTheDocument()
	})
})
