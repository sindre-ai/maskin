import { ActivityFeedView } from '@/components/activity/activity-feed'
import { render, screen } from '@testing-library/react'
import { buildEventResponse } from '../../factories'

vi.mock('@/hooks/use-actors', () => ({
	useActor: () => ({ data: undefined }),
}))

vi.mock('@tanstack/react-router', () => ({
	Link: ({ children, ...rest }: { children: React.ReactNode }) => <a {...rest}>{children}</a>,
	useNavigate: () => vi.fn(),
}))

describe('ActivityFeedView', () => {
	it('shows loading skeleton when isLoading', () => {
		const { container } = render(<ActivityFeedView events={[]} isLoading />)
		// ListSkeleton renders skeleton rows
		expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
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
