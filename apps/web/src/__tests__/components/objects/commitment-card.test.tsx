import { CommitmentCard } from '@/components/objects/commitment-card'
import { render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'
import { TestWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-objects', () => ({
	useObject: (id: string) => ({
		data: {
			id,
			type: 'bet',
			title: 'Source bet: customer bugs fixed <1 day',
			status: 'succeeded',
		},
		isLoading: false,
	}),
}))

function renderCommitmentCard(object = buildObjectResponse({ type: 'commitment' })) {
	return render(
		<TestWrapper>
			<CommitmentCard object={object} workspaceId="ws-1" />
		</TestWrapper>,
	)
}

describe('CommitmentCard', () => {
	it('renders the commitment title', () => {
		const object = buildObjectResponse({
			type: 'commitment',
			title: 'Customer bugs fixed <1 day',
			status: 'holding',
		})
		renderCommitmentCard(object)
		expect(screen.getByText('Customer bugs fixed <1 day')).toBeInTheDocument()
	})

	it('falls back to "Untitled commitment" when title is empty', () => {
		const object = buildObjectResponse({ type: 'commitment', title: null, status: 'holding' })
		renderCommitmentCard(object)
		expect(screen.getByText('Untitled commitment')).toBeInTheDocument()
	})

	it('renders the health-state chip for holding', () => {
		const object = buildObjectResponse({ type: 'commitment', status: 'holding' })
		renderCommitmentCard(object)
		expect(screen.getByText('holding')).toBeInTheDocument()
	})

	it('renders the amber chip class for at-risk', () => {
		const object = buildObjectResponse({ type: 'commitment', status: 'at-risk' })
		const { container } = renderCommitmentCard(object)
		const badge = container.querySelector('.bg-status-at_risk-bg.text-status-at_risk-text')
		expect(badge).not.toBeNull()
		expect(badge?.textContent).toContain('at-risk')
	})

	it('renders the red chip class for breached', () => {
		const object = buildObjectResponse({ type: 'commitment', status: 'breached' })
		const { container } = renderCommitmentCard(object)
		const badge = container.querySelector('.bg-status-breached-bg.text-status-breached-text')
		expect(badge).not.toBeNull()
		expect(badge?.textContent).toContain('breached')
	})

	it('renders the neutral chip class for holding', () => {
		const object = buildObjectResponse({ type: 'commitment', status: 'holding' })
		const { container } = renderCommitmentCard(object)
		const badge = container.querySelector('.bg-status-holding-bg.text-status-holding-text')
		expect(badge).not.toBeNull()
	})

	it('renders floor and cadence when present', () => {
		const object = buildObjectResponse({
			type: 'commitment',
			status: 'holding',
			metadata: {
				floor: '<1 day median',
				cadence: 'weekly',
			},
		})
		renderCommitmentCard(object)
		expect(screen.getByText('Floor')).toBeInTheDocument()
		expect(screen.getByText('<1 day median')).toBeInTheDocument()
		expect(screen.getByText('Cadence')).toBeInTheDocument()
		expect(screen.getByText('weekly')).toBeInTheDocument()
	})

	it('omits floor and cadence rows when metadata is missing', () => {
		const object = buildObjectResponse({ type: 'commitment', status: 'holding', metadata: null })
		renderCommitmentCard(object)
		expect(screen.queryByText('Floor')).not.toBeInTheDocument()
		expect(screen.queryByText('Cadence')).not.toBeInTheDocument()
	})

	it('renders the source-bet link when source_bet_id is set', () => {
		const object = buildObjectResponse({
			type: 'commitment',
			status: 'holding',
			metadata: {
				source_bet_id: 'bet-abc-123',
			},
		})
		renderCommitmentCard(object)
		expect(screen.getByText('Source bet')).toBeInTheDocument()
		const link = screen.getByRole('link')
		expect(link.getAttribute('href')).toBe('/$workspaceId/objects/$objectId')
		expect(link.textContent).toContain('Source bet: customer bugs fixed <1 day')
	})

	it('renders last_breach_at as a relative timestamp when present', () => {
		const object = buildObjectResponse({
			type: 'commitment',
			status: 'breached',
			metadata: {
				last_breach_at: '2026-07-10T12:00:00.000Z',
			},
		})
		const { container } = renderCommitmentCard(object)
		expect(screen.getByText('Last breach')).toBeInTheDocument()
		const timeEl = container.querySelector('time')
		expect(timeEl?.getAttribute('datetime')).toBe('2026-07-10T12:00:00.000Z')
	})

	it('omits last_breach_at row when metadata is missing', () => {
		const object = buildObjectResponse({
			type: 'commitment',
			status: 'holding',
			metadata: { floor: '<1 day' },
		})
		renderCommitmentCard(object)
		expect(screen.queryByText('Last breach')).not.toBeInTheDocument()
	})
})
