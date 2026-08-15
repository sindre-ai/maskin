import { LoopHeader } from '@/components/loops/loop-header'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { buildLoopSummary } from '../../factories'

describe('LoopHeader', () => {
	it('renders the loop name, pill, and description', () => {
		const loop = buildLoopSummary({
			name: 'Customer feedback loop',
			guarantee: 'Every customer hears back within 30 days',
			pill: 'running',
		})
		render(<LoopHeader loop={loop} onTogglePause={vi.fn()} isTogglingPause={false} />)

		expect(screen.getByText('Customer feedback loop')).toBeInTheDocument()
		expect(screen.getByText('Running')).toBeInTheDocument()
		expect(screen.getByText('Every customer hears back within 30 days')).toBeInTheDocument()
	})

	it('renders "Untitled loop" when name is null', () => {
		render(
			<LoopHeader
				loop={buildLoopSummary({ name: null })}
				onTogglePause={vi.fn()}
				isTogglingPause={false}
			/>,
		)

		expect(screen.getByText('Untitled loop')).toBeInTheDocument()
	})

	it('calls onTogglePause with "Pause loop" when running', async () => {
		const user = userEvent.setup()
		const onTogglePause = vi.fn()
		render(
			<LoopHeader
				loop={buildLoopSummary({ status: 'running' })}
				onTogglePause={onTogglePause}
				isTogglingPause={false}
			/>,
		)

		await user.click(screen.getByRole('button', { name: /more/i }))
		await user.click(await screen.findByText('Pause loop'))

		expect(onTogglePause).toHaveBeenCalled()
	})

	it('shows "Resume loop" when the loop is paused', async () => {
		const user = userEvent.setup()
		render(
			<LoopHeader
				loop={buildLoopSummary({ status: 'paused', pill: 'paused' })}
				onTogglePause={vi.fn()}
				isTogglingPause={false}
			/>,
		)

		await user.click(screen.getByRole('button', { name: /more/i }))

		expect(await screen.findByText('Resume loop')).toBeInTheDocument()
	})
})
