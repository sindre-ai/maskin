import { BetCard } from '@/components/bets/bet-card'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

describe('BetCard', () => {
	it('renders bet title', () => {
		const bet = buildObjectResponse({ type: 'bet', title: 'Launch mobile app' })
		render(<BetCard bet={bet} workspaceId="ws-1" insightCount={2} taskCount={3} />)
		expect(screen.getByText('Launch mobile app')).toBeInTheDocument()
	})

	it('renders "Untitled bet" when title is null', () => {
		const bet = buildObjectResponse({ type: 'bet', title: null })
		render(<BetCard bet={bet} workspaceId="ws-1" insightCount={0} taskCount={0} />)
		expect(screen.getByText('Untitled bet')).toBeInTheDocument()
	})

	it('renders status badge', () => {
		const bet = buildObjectResponse({ status: 'proposed' })
		render(<BetCard bet={bet} workspaceId="ws-1" insightCount={0} taskCount={0} />)
		expect(screen.getByText('proposed')).toBeInTheDocument()
	})

	it('shows insight count with correct pluralization', () => {
		const bet = buildObjectResponse()
		const { rerender } = render(
			<BetCard bet={bet} workspaceId="ws-1" insightCount={1} taskCount={0} />,
		)
		expect(screen.getByText('1 insight')).toBeInTheDocument()

		rerender(<BetCard bet={bet} workspaceId="ws-1" insightCount={3} taskCount={0} />)
		expect(screen.getByText('3 insights')).toBeInTheDocument()
	})

	it('shows task count with correct pluralization', () => {
		const bet = buildObjectResponse()
		const { rerender } = render(
			<BetCard bet={bet} workspaceId="ws-1" insightCount={0} taskCount={1} />,
		)
		expect(screen.getByText('1 task')).toBeInTheDocument()

		rerender(<BetCard bet={bet} workspaceId="ws-1" insightCount={0} taskCount={5} />)
		expect(screen.getByText('5 tasks')).toBeInTheDocument()
	})
})
