import type { ActorListItem, LoopSummary, SessionResponse, TriggerResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../mocks/router')
	return {
		...mockTanStackRouter(),
		createFileRoute: () => (options: Record<string, unknown>) => options,
	}
})

const mockUseLoops = vi.fn()
vi.mock('@/hooks/use-loops', () => ({
	useLoops: () => mockUseLoops(),
}))

const mockUseTriggers = vi.fn()
vi.mock('@/hooks/use-triggers', () => ({
	useTriggers: () => mockUseTriggers(),
	useUpdateTrigger: () => ({ mutate: mockUpdateTrigger, isPending: false }),
}))

const mockUseActors = vi.fn()
vi.mock('@/hooks/use-actors', () => ({
	useActors: () => mockUseActors(),
}))

const mockUseWorkspaceSessions = vi.fn()
vi.mock('@/hooks/use-sessions', () => ({
	useWorkspaceSessions: () => mockUseWorkspaceSessions(),
}))

const mockUseConversations = vi.fn()
vi.mock('@/hooks/use-conversations', () => ({
	useConversationsInfinite: () => mockUseConversations(),
}))

const mockUpdateTrigger = vi.fn()
vi.mock('@/hooks/use-user-display-settings', () => ({
	useUserDisplaySettings: () => ({ data: null, isFetched: true }),
	useUpdateUserDisplaySettings: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/components/objects/data-table/display-panel', () => ({
	DisplayPanel: () => <button type="button">Display</button>,
}))

vi.mock('@/components/shared/create-picker', () => ({
	CreatePicker: () => null,
	isCreateShortcut: () => false,
}))

vi.mock('@/components/layout/page-header', () => ({
	PageHeader: ({ title, subtitle }: { title: string; subtitle?: string }) => (
		<h1>
			{title}
			{subtitle ? ` ${subtitle}` : ''}
		</h1>
	),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: () => ({ workspaceId: 'ws-1' }),
}))

import { Route } from '@/routes/_authed/$workspaceId/loops/index'

const LoopsPage = (Route as unknown as { component: React.FC }).component

function buildLoop(overrides: Partial<LoopSummary> = {}): LoopSummary {
	return {
		id: 'loop-1',
		workspaceId: 'ws-1',
		name: 'Customer feedback',
		content: 'Every customer who gives feedback hears back within 30 days',
		status: 'learning',
		pill: 'learning',
		entryCondition: null,
		closeCondition: null,
		inProgressCount: 6,
		closedCount: 128,
		medianTimeToCloseMs: 11 * 24 * 3600 * 1000,
		agentIds: [],
		triggerIds: [],
		waitingOnViewer: false,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

function buildActor(overrides: Partial<ActorListItem> = {}): ActorListItem {
	return {
		id: 'actor-1',
		type: 'agent',
		name: 'Compass',
		email: null,
		description: null,
		isSystem: false,
		agentState: 'idle',
		...overrides,
	}
}

function buildTrigger(overrides: Partial<TriggerResponse> = {}): TriggerResponse {
	return {
		id: 't-1',
		workspaceId: 'ws-1',
		name: 'Nightly sweep',
		type: 'cron',
		targetActorId: 'actor-1',
		config: { expression: '0 3 * * *' },
		enabled: true,
		createdAt: '2026-08-01T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		...overrides,
	} as TriggerResponse
}

function buildConversation(overrides: Record<string, unknown> = {}) {
	return {
		id: 'conv-1',
		workspaceId: 'ws-1',
		title: 'Look into the recent churn spike',
		createdBy: 'human-1',
		lastMessageAt: '2026-08-04T00:00:00.000Z',
		createdAt: '2026-08-04T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		pinned: false,
		archived: false,
		unread_count: 0,
		snippet: 'Drafting a summary',
		participants: [
			{
				actorId: 'actor-1',
				actorName: 'Compass',
				actorType: 'agent' as const,
				joinedAt: null,
				addedBy: null,
			},
		],
		...overrides,
	}
}

function buildSession(overrides: Partial<SessionResponse> = {}): SessionResponse {
	return {
		id: 's-1',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		triggerId: null,
		status: 'running',
		actionPrompt: 'Look into the recent churn spike',
		startedAt: '2026-08-04T00:00:00.000Z',
		createdAt: '2026-08-04T00:00:00.000Z',
		updatedAt: '2026-08-04T00:00:00.000Z',
		currentActivity: 'Drafting a summary',
		...overrides,
	} as SessionResponse
}

beforeEach(() => {
	vi.clearAllMocks()
	mockUseLoops.mockReturnValue({ data: [], isLoading: false })
	mockUseTriggers.mockReturnValue({ data: [] })
	mockUseActors.mockReturnValue({ data: [] })
	mockUseWorkspaceSessions.mockReturnValue({ data: [] })
	mockUseConversations.mockReturnValue({
		data: { pages: [{ conversations: [], has_more: false }] },
	})
})

describe('LoopsPage', () => {
	it('renders the empty state when there are no loops', () => {
		render(<LoopsPage />)

		expect(screen.getByText('No loops running here yet')).toBeInTheDocument()
	})

	it('lists standalone triggers for a workspace that has triggers but no loops', () => {
		// The fold-in's core regression: with /triggers gone, the only way into a
		// trigger is this list, so it must not be gated on a loop existing.
		mockUseTriggers.mockReturnValue({ data: [buildTrigger()] })
		mockUseActors.mockReturnValue({ data: [buildActor()] })

		render(<LoopsPage />)

		expect(screen.getByText('Not tied to a loop')).toBeInTheDocument()
		expect(screen.getByText('Nightly sweep')).toBeInTheDocument()
		// The loops empty state renders inline as a section, not as the whole page.
		expect(screen.getByText('No loops running here yet')).toBeInTheDocument()
	})

	it('treats a trigger the loop names in triggerIds as tied, not standalone', () => {
		const actors = [buildActor({ id: 'actor-1', name: 'Compass' })]
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ agentIds: ['actor-1'], triggerIds: ['t-tied'] })],
			isLoading: false,
		})
		mockUseTriggers.mockReturnValue({
			data: [buildTrigger({ id: 't-tied', targetActorId: 'actor-1' })],
		})
		mockUseActors.mockReturnValue({ data: actors })

		render(<LoopsPage />)

		expect(screen.getByText('Customer feedback')).toBeInTheDocument()
		// The section always renders — /triggers redirects here, so it is the only
		// way in; with nothing standalone it shows its own empty state.
		expect(screen.getByText('Not tied to a loop')).toBeInTheDocument()
		expect(screen.getByText('No workspace-wide automations yet')).toBeInTheDocument()
	})

	it('keeps a trigger standalone even when it shares an agent with a loop', () => {
		// The old heuristic keyed off targetActorId and wrongly hid this row.
		const actors = [buildActor({ id: 'actor-1', name: 'Compass' })]
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ agentIds: ['actor-1'], triggerIds: [] })],
			isLoading: false,
		})
		mockUseTriggers.mockReturnValue({
			data: [
				buildTrigger({ id: 't-shared', name: 'Shared agent sweep', targetActorId: 'actor-1' }),
			],
		})
		mockUseActors.mockReturnValue({ data: actors })

		render(<LoopsPage />)

		expect(screen.getByText('Not tied to a loop')).toBeInTheDocument()
		expect(screen.getByText('Shared agent sweep')).toBeInTheDocument()
	})

	it('flips a standalone trigger through its inline switch without navigating', async () => {
		const user = userEvent.setup()
		mockUseTriggers.mockReturnValue({ data: [buildTrigger()] })
		mockUseActors.mockReturnValue({ data: [buildActor()] })

		render(<LoopsPage />)

		await user.click(screen.getByRole('switch', { name: /disable nightly sweep/i }))

		expect(mockUpdateTrigger).toHaveBeenCalledWith({ id: 't-1', data: { enabled: false } })
	})

	it('renders "Assigned in chat" from conversations that have an agent participant', () => {
		mockUseActors.mockReturnValue({ data: [buildActor({ id: 'actor-1', name: 'Compass' })] })
		mockUseConversations.mockReturnValue({
			data: { pages: [{ conversations: [buildConversation()], has_more: false }] },
		})
		mockUseWorkspaceSessions.mockReturnValue({
			data: [buildSession({ triggerId: null, actorId: 'actor-1', status: 'running' })],
		})

		render(<LoopsPage />)

		expect(screen.getByText('Assigned in chat')).toBeInTheDocument()
		expect(screen.getByText('Look into the recent churn spike')).toBeInTheDocument()
		expect(screen.getByText('Compass')).toBeInTheDocument()
		expect(screen.getByText('Working')).toBeInTheDocument()
	})

	it('links an assigned-in-chat row back to its conversation', () => {
		mockUseActors.mockReturnValue({ data: [buildActor({ id: 'actor-1', name: 'Compass' })] })
		mockUseConversations.mockReturnValue({
			data: { pages: [{ conversations: [buildConversation()], has_more: false }] },
		})

		render(<LoopsPage />)

		const link = screen.getByRole('link', { name: /look into the recent churn spike/i })
		expect(link).toHaveAttribute('href', '/$workspaceId/chats/$conversationId')
		expect(link.getAttribute('params')).toBeDefined()
	})

	it('renders the "Assigned in chat" empty state when no conversation has an agent', () => {
		mockUseConversations.mockReturnValue({
			data: {
				pages: [{ conversations: [buildConversation({ participants: [] })], has_more: false }],
			},
		})

		render(<LoopsPage />)

		expect(screen.getByText('Assigned in chat')).toBeInTheDocument()
		expect(screen.getByText('Nothing handed to an agent in chat')).toBeInTheDocument()
	})

	it('renders the list skeleton while loops are loading', () => {
		mockUseLoops.mockReturnValue({ data: undefined, isLoading: true })

		const { container } = render(<LoopsPage />)
		expect(screen.queryByText('No loops running here yet')).not.toBeInTheDocument()
		expect(container.querySelector('.animate-pulse')).toBeInTheDocument()
	})

	it('shows the error card, not the empty state, when the loops fetch fails', () => {
		mockUseLoops.mockReturnValue({
			data: undefined,
			isLoading: false,
			isError: true,
			error: new Error('boom'),
			refetch: vi.fn(),
		})

		render(<LoopsPage />)

		expect(screen.getByText("Couldn't load loops")).toBeInTheDocument()
		expect(screen.queryByText('No loops running here yet')).not.toBeInTheDocument()
	})

	it('names the loop an assigned-in-chat row feeds, via the agent that runs it', () => {
		mockUseLoops.mockReturnValue({
			data: [buildLoop({ name: 'Churn watch', agentIds: ['actor-1'] })],
			isLoading: false,
		})
		mockUseActors.mockReturnValue({ data: [buildActor({ id: 'actor-1', name: 'Compass' })] })
		mockUseConversations.mockReturnValue({
			data: { pages: [{ conversations: [buildConversation()], has_more: false }] },
		})

		render(<LoopsPage />)

		expect(screen.getByText('feeds Churn watch')).toBeInTheDocument()
	})
})
