import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mockSave = vi.fn()

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

vi.mock('@/hooks/use-notification-preferences', () => ({
	useNotificationPreferences: () => ({
		data: {
			timezone: 'Europe/Copenhagen',
			quiet_hours_start: null,
			quiet_hours_end: null,
			categories: {
				needs_you: true,
				conversation: true,
				digest: true,
				tips: true,
				flow_activity: false,
			},
			browser_categories: {
				needs_you: true,
				conversation: true,
				digest: true,
				tips: true,
				flow_activity: false,
			},
			browser_not_asked: [],
			briefing_enabled: true,
			briefing_time: 510,
			email_digest_enabled: true,
			// Old saved choices still come back from the API; the page must not show them.
			email_categories: { needs_you: true, conversation: true, tips: true, flow_activity: false },
			marketplace_picks_enabled: false,
			email_rhythm: 'daily',
			muted_workspace_ids: [],
			updated_at: null,
		},
		isLoading: false,
		isError: false,
		error: null,
		refetch: vi.fn(),
	}),
	useUpdateNotificationPreferences: () => ({ mutate: mockSave, isPending: false }),
}))

vi.mock('@/hooks/use-web-push', () => ({ useWebPush: () => ({ state: 'unavailable' }) }))
vi.mock('@/hooks/use-workspaces', () => ({ useWorkspaces: () => ({ data: [] }) }))
vi.mock('@/hooks/use-document-title', () => ({ useDocumentTitle: vi.fn() }))
vi.mock('sonner', () => ({ toast: { error: vi.fn(), success: vi.fn() } }))
vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => <div>Error</div>,
}))

import { Route } from '@/routes/_authed/$workspaceId/settings/notifications'

const NotificationsPage = (Route as unknown as { component: React.FC }).component

describe('NotificationsPage email switches', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('has no Email switch for Needs you, Chat replies or Tips and updates', () => {
		render(<NotificationsPage />)
		for (const title of ['Needs you', 'Chat replies', 'Tips and updates']) {
			expect(screen.getByRole('switch', { name: title })).toBeInTheDocument()
			expect(screen.getByRole('switch', { name: `${title} in the browser` })).toBeInTheDocument()
			expect(screen.queryByRole('switch', { name: `${title} by email` })).not.toBeInTheDocument()
		}
	})

	it('keeps the Email switches for Digests, Flow activity and Marketplace picks', () => {
		render(<NotificationsPage />)
		expect(screen.getByRole('switch', { name: 'Digests by email' })).toBeInTheDocument()
		expect(screen.getByRole('switch', { name: 'Flow activity by email' })).toBeInTheDocument()
		expect(screen.getByRole('switch', { name: 'Marketplace picks by email' })).toBeInTheDocument()
	})
})
