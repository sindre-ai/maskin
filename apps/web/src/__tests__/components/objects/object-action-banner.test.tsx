import { ObjectActionBanner } from '@/components/objects/object-action-banner'
import { render, screen } from '@testing-library/react'
import { buildNotificationResponse } from '../../factories'

const mockNotifications = vi.fn()

vi.mock('@/hooks/use-notifications', () => ({
	useObjectNotifications: () => ({ data: mockNotifications() }),
	useRespondNotification: () => ({ mutate: vi.fn() }),
}))

describe('ObjectActionBanner', () => {
	it('returns null when no notifications', () => {
		mockNotifications.mockReturnValue(undefined)
		const { container } = render(<ObjectActionBanner objectId="obj-1" workspaceId="ws-1" />)
		expect(container.firstChild).toBeNull()
	})

	it('returns null when notifications array is empty', () => {
		mockNotifications.mockReturnValue([])
		const { container } = render(<ObjectActionBanner objectId="obj-1" workspaceId="ws-1" />)
		expect(container.firstChild).toBeNull()
	})

	it('renders notification title', () => {
		mockNotifications.mockReturnValue([
			buildNotificationResponse({ title: 'Agent needs approval' }),
		])
		render(<ObjectActionBanner objectId="obj-1" workspaceId="ws-1" />)
		expect(screen.getByText('Agent needs approval')).toBeInTheDocument()
	})

	it('renders notification content', () => {
		mockNotifications.mockReturnValue([
			buildNotificationResponse({ title: 'Title', content: 'Some details' }),
		])
		render(<ObjectActionBanner objectId="obj-1" workspaceId="ws-1" />)
		expect(screen.getByText('Some details')).toBeInTheDocument()
	})

	it('shows NotificationInput when input_type is set', () => {
		mockNotifications.mockReturnValue([
			buildNotificationResponse({
				title: 'Confirm?',
				metadata: { input_type: 'confirmation' },
			}),
		])
		render(<ObjectActionBanner objectId="obj-1" workspaceId="ws-1" />)
		expect(screen.getByRole('button', { name: 'Yes' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'No' })).toBeInTheDocument()
	})
})
