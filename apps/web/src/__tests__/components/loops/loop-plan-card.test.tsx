import { LoopPlanCard, defaultLoopName } from '@/components/loops/loop-plan-card'
import type { LoopPlan } from '@/lib/loop-plan'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const plan: LoopPlan = {
	objectTypes: [
		{
			type: 'feedback',
			name: 'Feedback',
			role: 'Submissions from customers',
			live: 'new type · 4 states',
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
		onCreate: vi.fn(),
		onStartOver: vi.fn(),
		workspaceId: 'ws-1',
		...overrides,
	}
}

describe('defaultLoopName', () => {
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

	it('offers no builder path — the footer is Start over + Create loop only', () => {
		render(<LoopPlanCard {...baseProps()} />)
		expect(screen.queryByRole('button', { name: /adjust/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^start over$/i })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: /create loop/i })).toBeInTheDocument()
	})

	it('shows the live reading on a type card instead of a fixed label', () => {
		render(<LoopPlanCard {...baseProps()} />)
		expect(screen.getByText('new type · 4 states')).toBeInTheDocument()
		expect(screen.queryByText('tracked live')).not.toBeInTheDocument()
	})

	it('renders a note instead of a state chain for a read-only type', () => {
		render(
			<LoopPlanCard
				{...baseProps({
					plan: {
						...plan,
						objectTypes: [
							...plan.objectTypes,
							{
								type: 'customer',
								name: 'Customer',
								role: 'who hears back',
								live: 'reused',
								readOnly: true,
								note: 'linked, never changed by this loop',
								stateChain: [],
								isNew: false,
							},
						],
					},
				})}
			/>,
		)
		expect(screen.getByText('linked, never changed by this loop')).toBeInTheDocument()
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
