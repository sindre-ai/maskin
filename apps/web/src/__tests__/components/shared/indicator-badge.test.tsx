import { IndicatorBadgeChip, IndicatorBadgeRow } from '@/components/shared/indicator-badge'
import type { BetStatusResult } from '@/lib/bet-status'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

function makeResult(overrides: Partial<BetStatusResult> = {}): BetStatusResult {
	return {
		state: 'idle',
		pendingAction: null,
		decisionsSoFar: [],
		...overrides,
	}
}

describe('IndicatorBadgeRow', () => {
	it('renders lowercase word matching the state (waiting_on_human → "waiting")', () => {
		render(<IndicatorBadgeRow result={makeResult({ state: 'waiting_on_human' })} />)
		expect(screen.getByLabelText('Status: waiting')).toBeInTheDocument()
		expect(screen.getByText('waiting')).toBeInTheDocument()
	})

	it('renders "progressing"', () => {
		render(<IndicatorBadgeRow result={makeResult({ state: 'progressing' })} />)
		expect(screen.getByText('progressing')).toBeInTheDocument()
	})

	it('renders "stalled"', () => {
		render(<IndicatorBadgeRow result={makeResult({ state: 'stalled' })} />)
		expect(screen.getByText('stalled')).toBeInTheDocument()
	})

	it('renders "idle"', () => {
		render(<IndicatorBadgeRow result={makeResult({ state: 'idle' })} />)
		expect(screen.getByText('idle')).toBeInTheDocument()
	})

	it('applies the louder waiting treatment (semibold)', () => {
		render(<IndicatorBadgeRow result={makeResult({ state: 'waiting_on_human' })} />)
		expect(screen.getByLabelText('Status: waiting').className).toContain('font-semibold')
	})
})

describe('IndicatorBadgeChip', () => {
	it('renders trigger with the full label including "on human" for waiting_on_human', () => {
		render(
			<TestWrapper>
				<IndicatorBadgeChip result={makeResult({ state: 'waiting_on_human' })} workspaceId="ws-1" />
			</TestWrapper>,
		)
		expect(screen.getByRole('button', { name: 'Status: waiting on human' })).toBeInTheDocument()
	})

	it('opens popover on click and shows decisions + pending action', async () => {
		const user = userEvent.setup()
		const result: BetStatusResult = {
			state: 'waiting_on_human',
			pendingAction: {
				kind: 'waiting_on_human',
				tasks: [{ id: 'task-1', title: 'Approve legal review', driver: null, status: 'todo' }],
			},
			decisionsSoFar: [
				{ taskId: 'task-0', title: 'Direction locked', decidedAt: '2026-07-01T00:00:00Z' },
			],
		}
		render(
			<TestWrapper>
				<IndicatorBadgeChip result={result} workspaceId="ws-1" />
			</TestWrapper>,
		)
		await user.click(screen.getByRole('button', { name: 'Status: waiting on human' }))
		expect(await screen.findByText('Waiting: Approve legal review')).toBeInTheDocument()
		expect(screen.getByText('Direction locked')).toBeInTheDocument()
		expect(screen.getByRole('link', { name: /Open task/ })).toHaveAttribute(
			'href',
			'/$workspaceId/objects/$objectId',
		)
	})

	it('shows the idle empty-state copy when state is idle with no history', async () => {
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<IndicatorBadgeChip result={makeResult({ state: 'idle' })} workspaceId="ws-1" />
			</TestWrapper>,
		)
		await user.click(screen.getByRole('button', { name: 'Status: idle' }))
		expect(
			await screen.findByText(/No open human decisions and no in-flight tasks/i),
		).toBeInTheDocument()
	})

	it('opens on hover and closes on mouse leave (desktop pattern)', async () => {
		const user = userEvent.setup()
		render(
			<TestWrapper>
				<IndicatorBadgeChip result={makeResult({ state: 'progressing' })} workspaceId="ws-1" />
			</TestWrapper>,
		)
		const trigger = screen.getByRole('button', { name: 'Status: progressing' })
		await user.hover(trigger)
		expect(trigger).toHaveAttribute('aria-expanded', 'true')
		await user.unhover(trigger)
		expect(trigger).toHaveAttribute('aria-expanded', 'false')
	})

	it('is read-only — no approve/answer buttons appear inside the popover', async () => {
		const user = userEvent.setup()
		const result: BetStatusResult = {
			state: 'waiting_on_human',
			pendingAction: {
				kind: 'waiting_on_human',
				tasks: [{ id: 'task-1', title: 'Decide pricing', driver: null, status: 'todo' }],
			},
			decisionsSoFar: [],
		}
		render(
			<TestWrapper>
				<IndicatorBadgeChip result={result} workspaceId="ws-1" />
			</TestWrapper>,
		)
		await user.click(screen.getByRole('button', { name: 'Status: waiting on human' }))
		await screen.findByText('Waiting: Decide pricing')
		expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /answer/i })).not.toBeInTheDocument()
	})
})
