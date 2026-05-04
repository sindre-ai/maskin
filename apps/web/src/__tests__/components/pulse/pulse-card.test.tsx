import { PulseCard, resolveActions } from '@/components/pulse/pulse-card'
import type { NotificationResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorListItem, buildNotificationResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

/** Build a notification with metadata that includes nested objects (e.g. actions).
 * SafeMetadata doesn't allow nested objects, but the runtime API returns them. */
function buildNotificationWithActions(
	overrides: Omit<Partial<NotificationResponse>, 'metadata'> & {
		metadata: Record<string, unknown>
	},
): NotificationResponse {
	return {
		...buildNotificationResponse(
			// biome-ignore lint/suspicious/noExplicitAny: test helper — runtime metadata has nested objects
			overrides as any,
		),
	}
}

const mockNavigate = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return {
		...mockTanStackRouter(),
		useNavigate: () => mockNavigate,
	}
})

describe('PulseCard', () => {
	const wrapper = createWorkspaceWrapper()
	const actorsById = new Map([['actor-1', buildActorListItem({ id: 'actor-1', name: 'Bot' })]])

	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('renders notification title', () => {
		const notification = buildNotificationResponse({ title: 'New Pattern' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('New Pattern')).toBeInTheDocument()
	})

	it('renders notification content', () => {
		const notification = buildNotificationResponse({ content: 'Details here' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('Details here')).toBeInTheDocument()
	})

	it('shows type label badge', () => {
		const notification = buildNotificationResponse({ type: 'recommendation' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('Pattern detected')).toBeInTheDocument()
	})

	it('shows urgency label when present', () => {
		const notification = buildNotificationResponse({
			metadata: { urgency_label: 'Critical' },
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('Critical')).toBeInTheDocument()
	})

	it('shows tags', () => {
		const notification = buildNotificationResponse({
			metadata: { tags: ['bug', 'performance'] },
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('bug')).toBeInTheDocument()
		expect(screen.getByText('performance')).toBeInTheDocument()
	})

	it('shows agent suggestion', () => {
		const notification = buildNotificationResponse({
			metadata: { suggestion: 'Consider upgrading' },
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('Consider upgrading')).toBeInTheDocument()
	})

	it('shows Dismiss button', () => {
		const notification = buildNotificationResponse()
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByRole('button', { name: 'Dismiss' })).toBeInTheDocument()
	})

	it('calls onDismiss when Dismiss clicked', async () => {
		const user = userEvent.setup()
		const onDismiss = vi.fn()
		const notification = buildNotificationResponse({ id: 'n-1' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={onDismiss}
			/>,
			{ wrapper },
		)

		await user.click(screen.getByRole('button', { name: 'Dismiss' }))
		expect(onDismiss).toHaveBeenCalledWith('n-1')
	})

	it('shows View objects for recommendation type', () => {
		const notification = buildNotificationResponse({ type: 'recommendation' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByRole('button', { name: /View objects/ })).toBeInTheDocument()
	})

	it('shows Review tasks for alert type', () => {
		const notification = buildNotificationResponse({ type: 'alert' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByRole('button', { name: /Review tasks/ })).toBeInTheDocument()
	})

	it('shows source actor name when available', () => {
		const notification = buildNotificationResponse({ sourceActorId: 'actor-1' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByText('Bot')).toBeInTheDocument()
	})

	it('renders custom metadata.actions buttons', () => {
		const notification = buildNotificationWithActions({
			metadata: {
				actions: [
					{ label: 'Approve', response: 'approved' },
					{ label: 'Reject', response: 'rejected', variant: 'destructive' },
				],
			},
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Reject' })).toBeInTheDocument()
	})

	it('calls onAction with response for actions that have response', async () => {
		const user = userEvent.setup()
		const onAction = vi.fn()
		const notification = buildNotificationWithActions({
			metadata: {
				actions: [{ label: 'Approve', response: 'approved' }],
			},
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={onAction}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)

		await user.click(screen.getByRole('button', { name: 'Approve' }))
		expect(onAction).toHaveBeenCalledWith(notification, 'approved', undefined)
	})

	it('navigates directly for navigate-only actions without calling onAction', async () => {
		const user = userEvent.setup()
		const onAction = vi.fn()
		const notification = buildNotificationWithActions({
			objectId: '00000000-0000-0000-0000-000000000001',
			metadata: {
				actions: [{ label: 'Go to object', navigate: { to: 'object' } }],
			},
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={onAction}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)

		await user.click(screen.getByRole('button', { name: /Go to object/ }))
		expect(onAction).not.toHaveBeenCalled()
		expect(mockNavigate).toHaveBeenCalled()
	})

	it('renders navigate-only actions from metadata.actions', () => {
		const notification = buildNotificationWithActions({
			metadata: {
				actions: [{ label: 'View Activity', navigate: { to: 'activity' } }],
			},
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByRole('button', { name: /View Activity/ })).toBeInTheDocument()
	})

	it('hides action buttons and dismiss for resolved notifications', () => {
		const notification = buildNotificationResponse({
			type: 'recommendation',
			status: 'resolved',
		})
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.queryByRole('button', { name: 'Dismiss' })).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /View objects/ })).not.toBeInTheDocument()
	})

	it('shows Talk to Sindre button', () => {
		const notification = buildNotificationResponse()
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.getByRole('button', { name: /Talk to Sindre/ })).toBeInTheDocument()
	})

	it('hides Talk to Sindre button for resolved notifications', () => {
		const notification = buildNotificationResponse({ status: 'resolved' })
		render(
			<PulseCard
				notification={notification}
				actorsById={actorsById}
				onAction={vi.fn()}
				onDismiss={vi.fn()}
			/>,
			{ wrapper },
		)
		expect(screen.queryByRole('button', { name: /Talk to Sindre/ })).not.toBeInTheDocument()
	})
})

describe('resolveActions', () => {
	it('returns custom actions from metadata.actions', () => {
		const notification = buildNotificationResponse()
		const metadata = {
			actions: [
				{ label: 'Do thing', response: 'do_thing' },
				{ label: 'Go', navigate: { to: 'activity' } },
			],
		} as Record<string, unknown>
		const result = resolveActions(notification, metadata)
		expect(result).toHaveLength(2)
		expect(result[0].label).toBe('Do thing')
		expect(result[1].label).toBe('Go')
	})

	it('filters out invalid actions from metadata.actions', () => {
		const notification = buildNotificationResponse()
		const metadata = {
			actions: [
				{ label: 'Valid', response: 'ok' },
				{ label: 'No response or navigate' },
				'not an object',
			],
		} as Record<string, unknown>
		const result = resolveActions(notification, metadata)
		expect(result).toHaveLength(1)
		expect(result[0].label).toBe('Valid')
	})

	it('returns empty array for needs_input type without custom actions', () => {
		const notification = buildNotificationResponse({ type: 'needs_input' })
		const metadata = { input_type: 'confirmation' }
		const result = resolveActions(notification, metadata)
		expect(result).toHaveLength(0)
	})

	it('returns View object for recommendation with objectId', () => {
		const notification = buildNotificationResponse({
			type: 'recommendation',
			objectId: '00000000-0000-0000-0000-000000000001',
		})
		const result = resolveActions(notification, {})
		expect(result).toHaveLength(1)
		expect(result[0].label).toBe('View object')
		expect(result[0].navigate?.to).toBe('object')
	})

	it('returns View objects for recommendation without objectId', () => {
		const notification = buildNotificationResponse({
			type: 'recommendation',
			objectId: null,
		})
		const result = resolveActions(notification, {})
		expect(result).toHaveLength(1)
		expect(result[0].label).toBe('View objects')
		expect(result[0].navigate?.to).toBe('objects')
	})

	it('returns Review for alert with objectId', () => {
		const notification = buildNotificationResponse({
			type: 'alert',
			objectId: '00000000-0000-0000-0000-000000000001',
		})
		const result = resolveActions(notification, {})
		expect(result).toHaveLength(1)
		expect(result[0].label).toBe('Review')
	})

	it('returns empty array for good_news without objectId', () => {
		const notification = buildNotificationResponse({
			type: 'good_news',
			objectId: null,
		})
		const result = resolveActions(notification, {})
		expect(result).toHaveLength(0)
	})
})
