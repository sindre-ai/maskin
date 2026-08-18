import {
	LoopProposedEdit,
	diffLoopPlans,
	readStoredPlan,
} from '@/components/loops/loop-proposed-edit'
import { parseLoopDescription } from '@/lib/loop-plan'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const BEFORE = 'when a customer submits feedback, have the Feedback agent triage it'
const AFTER =
	'when a customer submits feedback, have the Feedback agent triage it and ask me before publishing'

describe('readStoredPlan', () => {
	it('parses the plan snapshot /loops/new writes to metadata.plan', () => {
		const plan = parseLoopDescription(BEFORE)
		expect(readStoredPlan({ plan: JSON.stringify(plan) })).toEqual(plan)
	})

	it('returns null for a loop that carries no snapshot (marketplace / MCP)', () => {
		expect(readStoredPlan({})).toBeNull()
		expect(readStoredPlan(null)).toBeNull()
		expect(readStoredPlan({ plan: 'not json' })).toBeNull()
		expect(readStoredPlan({ plan: JSON.stringify({ nope: true }) })).toBeNull()
	})
})

describe('diffLoopPlans', () => {
	it('returns only the fields the utterance actually changed', () => {
		const rows = diffLoopPlans(parseLoopDescription(BEFORE), parseLoopDescription(AFTER))
		const labels = rows.map((r) => r.label)
		expect(labels).toContain('STOPS FOR YOU')
		expect(rows.find((r) => r.label === 'STOPS FOR YOU')).toEqual({
			label: 'STOPS FOR YOU',
			before: 'never',
			after: 'before publishing',
		})
		expect(labels).not.toContain('OBJECT TYPE')
	})

	it('returns nothing when the utterance restates the same loop', () => {
		expect(diffLoopPlans(parseLoopDescription(BEFORE), parseLoopDescription(BEFORE))).toEqual([])
	})
})

describe('LoopProposedEdit', () => {
	const nextPlan = parseLoopDescription(AFTER)
	const rows = diffLoopPlans(parseLoopDescription(BEFORE), nextPlan)

	it('reads the change back with a struck-through before and a bold after', () => {
		render(
			<LoopProposedEdit
				utterance="ask me before publishing"
				rows={rows}
				nextPlan={nextPlan}
				onApply={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)

		expect(screen.getByText('PROPOSED EDIT')).toBeInTheDocument()
		expect(screen.getByText('never').className).toMatch(/line-through/)
		expect(screen.getByText('before publishing').className).toMatch(/font-semibold/)
		expect(screen.getByText('nothing moves until you say so')).toBeInTheDocument()
	})

	it('writes nothing on render — the change only lands on Make the change', async () => {
		const user = userEvent.setup()
		const onApply = vi.fn()
		const onDismiss = vi.fn()
		render(
			<LoopProposedEdit
				utterance="ask me before publishing"
				rows={rows}
				nextPlan={nextPlan}
				onApply={onApply}
				onDismiss={onDismiss}
			/>,
		)
		expect(onApply).not.toHaveBeenCalled()

		await user.click(screen.getByRole('button', { name: 'Leave it' }))
		expect(onDismiss).toHaveBeenCalled()
		expect(onApply).not.toHaveBeenCalled()

		await user.click(screen.getByRole('button', { name: 'Make the change' }))
		expect(onApply).toHaveBeenCalled()
	})

	it('renders nothing when there is no diff to read back', () => {
		const { container } = render(
			<LoopProposedEdit
				utterance="same thing again"
				rows={[]}
				nextPlan={nextPlan}
				onApply={vi.fn()}
				onDismiss={vi.fn()}
			/>,
		)
		expect(container).toBeEmptyDOMElement()
	})
})
