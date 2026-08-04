import { render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

const mockUseFlag = vi.fn()
vi.mock('@/hooks/use-foryou-redesign-flag', () => ({
	useForyouRedesignFlag: () => mockUseFlag(),
}))

// ForYouDashboard imports these; stub them so the flag=false branch renders
// without needing the full data-fetching stack.
vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))
vi.mock('@/hooks/use-subscriptions', () => ({
	useUnread: () => ({ data: { items: [] }, isLoading: false }),
	useMarkRead: () => ({ mutate: vi.fn(), isPending: false }),
}))
vi.mock('@/hooks/use-bets', () => ({
	useBets: () => ({ data: [{ id: 'bet-1' }], isLoading: false }),
}))
vi.mock('@/lib/new-conversation-context', () => ({
	useNewConversationComposer: () => ({ open: false, setOpen: vi.fn() }),
}))
vi.mock('sonner', () => ({ toast: vi.fn() }))
vi.mock('@/components/foryou/persistent-reply-bar', () => ({
	PersistentReplyBar: () => null,
}))
vi.mock('@/components/foryou/new-conversation-composer', () => ({
	NewConversationComposer: () => null,
}))
vi.mock('@/components/foryou/north-star-prompt-card', () => ({
	NorthStarPromptCard: () => null,
}))
vi.mock('@/components/foryou/onboarding-prompt-card', () => ({
	OnboardingPromptCard: () => null,
}))
vi.mock('@/components/foryou/unread-thread-card', () => ({
	UnreadThreadCard: () => null,
}))
vi.mock('@/components/foryou/sparse-composer', () => ({
	SparseComposer: () => null,
}))
vi.mock('@/components/shared/empty-state', () => ({
	EmptyState: ({ title }: { title: string }) => <div>{title}</div>,
}))
vi.mock('@/components/shared/loading-skeleton', () => ({
	CardSkeleton: () => null,
}))
vi.mock('@/components/shared/route-error', () => ({
	RouteError: () => null,
}))

import { Route } from '@/routes/_authed/$workspaceId/index'

const ForYouRoute = (Route as unknown as { component: React.FC }).component

beforeEach(() => {
	vi.clearAllMocks()
})

describe('For You route — founder canary gate', () => {
	it('renders the redesign shell when the flag is on', () => {
		mockUseFlag.mockReturnValue(true)
		render(<ForYouRoute />)
		expect(screen.getByTestId('foryou-redesign-root')).toBeInTheDocument()
		expect(screen.getByText(/founder canary/i)).toBeInTheDocument()
		// Non-founder feed markers must not appear behind the gate.
		expect(screen.queryByText('All caught up')).not.toBeInTheDocument()
	})

	it('renders the current dashboard when the flag is off', () => {
		mockUseFlag.mockReturnValue(false)
		render(<ForYouRoute />)
		expect(screen.queryByTestId('foryou-redesign-root')).not.toBeInTheDocument()
		expect(screen.getByText('All caught up')).toBeInTheDocument()
	})
})
