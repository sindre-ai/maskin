import { DecisionOptions, suggestedLine } from '@/components/shared/decision-option-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const OPTIONS = [
	{ id: 'hold', label: 'Hold', consequences: ['Nothing ships'] },
	{
		id: 'ship',
		label: 'Ship',
		recommended: true,
		consequences: ['Goes out tonight', 'No rollback'],
	},
	{ id: 'ask', label: 'Ask a question', consequences: [] },
]

describe('DecisionOptions', () => {
	it('draws the recommended option as the first, filled button and the rest as secondary', () => {
		render(<DecisionOptions options={OPTIONS} pendingId={null} onChoose={() => {}} />)
		const buttons = screen.getAllByRole('button')
		expect(buttons.map((button) => button.textContent?.replace('Recommended', ''))).toEqual([
			'Ship',
			'Hold',
			'Ask a question',
		])
		expect(buttons[0]?.className).toContain('bg-primary')
		expect(buttons[1]?.className).toContain('bg-secondary')
	})

	it('keeps the tag out of the recommended button name', () => {
		render(<DecisionOptions options={OPTIONS} pendingId={null} onChoose={() => {}} />)
		expect(screen.getByRole('button', { name: 'Ship' })).toBeInTheDocument()
	})

	it('reports the chosen option and holds every button while it is posted', async () => {
		const onChoose = vi.fn()
		const { rerender } = render(
			<DecisionOptions options={OPTIONS} pendingId={null} onChoose={onChoose} />,
		)
		await userEvent.click(screen.getByRole('button', { name: 'Hold' }))
		expect(onChoose).toHaveBeenCalledWith(OPTIONS[0])
		rerender(<DecisionOptions options={OPTIONS} pendingId="hold" onChoose={onChoose} />)
		for (const button of screen.getAllByRole('button')) expect(button).toBeDisabled()
	})
})

describe('suggestedLine', () => {
	it('is null when nothing is recommended', () => {
		expect(suggestedLine([{ id: 'a', label: 'A', consequences: ['x'] }])).toBeNull()
	})
})
