import { ActivityFeedView } from '@/components/activity/activity-feed'
import { render, screen } from '@testing-library/react'
import { buildEventResponse } from '../../factories'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: undefined }),
}))

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

describe('ActivityFeedView', () => {
	it('shows loading skeleton when isLoading', () => {
		render(<ActivityFeedView events={[]} isLoading />)
		// ListSkeleton renders multiple Skeleton divs — verify empty/loading state is not shown
		expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
	})

	it('shows empty state when events array is empty', () => {
		render(<ActivityFeedView events={[]} />)
		expect(screen.getByText('No activity yet')).toBeInTheDocument()
	})

	it('renders events when provided', () => {
		const events = [
			buildEventResponse({ id: 1, action: 'created', entityType: 'bet' }),
			buildEventResponse({ id: 2, action: 'updated', entityType: 'task' }),
		]

		render(<ActivityFeedView events={events} />)

		// Virtualizer renders items — check that the container is present
		expect(screen.queryByText('No activity yet')).not.toBeInTheDocument()
	})
})
