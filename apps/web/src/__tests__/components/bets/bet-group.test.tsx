import { BetGroup } from '@/components/bets/bet-group'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		children,
		...rest
	}: { children: React.ReactNode; to: string; params: Record<string, string> }) => (
		<a href={rest.to} {...rest}>
			{children}
		</a>
	),
}))

describe('BetGroup', () => {
	it('returns null when bets array is empty', () => {
		const { container } = render(
			<BetGroup status="active" bets={[]} relationships={[]} workspaceId="ws-1" />,
		)
		expect(container.firstChild).toBeNull()
	})

	it('renders status heading with underscores replaced by spaces', () => {
		const bets = [buildObjectResponse({ type: 'bet', title: 'A bet' })]
		render(<BetGroup status="in_progress" bets={bets} relationships={[]} workspaceId="ws-1" />)
		expect(screen.getByText('in progress')).toBeInTheDocument()
	})

	it('renders a BetCard per bet', () => {
		const bets = [
			buildObjectResponse({ id: 'bet-1', type: 'bet', title: 'Bet One' }),
			buildObjectResponse({ id: 'bet-2', type: 'bet', title: 'Bet Two' }),
		]
		render(<BetGroup status="active" bets={bets} relationships={[]} workspaceId="ws-1" />)
		expect(screen.getByText('Bet One')).toBeInTheDocument()
		expect(screen.getByText('Bet Two')).toBeInTheDocument()
	})

	it('computes correct insight and task counts from relationships', () => {
		const bet = buildObjectResponse({ id: 'bet-1', type: 'bet', title: 'My Bet' })
		const relationships = [
			buildRelationshipResponse({ sourceId: 'insight-1', targetId: 'bet-1', type: 'informs' }),
			buildRelationshipResponse({ sourceId: 'insight-2', targetId: 'bet-1', type: 'informs' }),
			buildRelationshipResponse({ sourceId: 'bet-1', targetId: 'task-1', type: 'breaks_into' }),
		]

		render(
			<BetGroup status="active" bets={[bet]} relationships={relationships} workspaceId="ws-1" />,
		)

		expect(screen.getByText('2 insights')).toBeInTheDocument()
		expect(screen.getByText('1 task')).toBeInTheDocument()
	})
})
