import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

// TanStack Router requires a router context — mock it
vi.mock('@tanstack/react-router', () => ({
	createFileRoute: () => () => null,
	useNavigate: () => vi.fn(),
	useSearch: () => ({}),
	Link: ({ children }: { children: React.ReactNode }) => children,
}))

// Mock hooks used by the route module
vi.mock('@/hooks/use-threads', () => ({
	useThreads: vi.fn(() => ({ data: [], isLoading: false })),
	useThread: vi.fn(() => ({ data: null, isLoading: false })),
	useCreateThread: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
	usePostThreadEvent: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
	useResolveThread: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
	useUpdateThread: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
	useRemoveThreadParticipant: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
	useAddThreadParticipant: vi.fn(() => ({ mutate: vi.fn(), isPending: false })),
	useThreadEventStream: vi.fn(),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: vi.fn(() => ({ data: [] })),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: vi.fn(() => null),
}))

vi.mock('@/lib/workspace-context', () => ({
	useWorkspace: vi.fn(() => ({ workspaceId: 'ws-1' })),
}))

vi.mock('sonner', () => ({
	toast: { error: vi.fn(), success: vi.fn() },
}))

import type { ActorListItem, ThreadEventResponse } from '@/lib/api'
import { ThreadEventItem } from '@/routes/_authed/$workspaceId/threads/index'
import type React from 'react'

function buildEvent(overrides: Partial<ThreadEventResponse> = {}): ThreadEventResponse {
	return {
		id: 'event-1',
		threadId: 'thread-1',
		actorId: 'actor-abc123',
		kind: 'message',
		body: 'Hello world',
		createdAt: '2024-01-01T00:00:00Z',
		...overrides,
	}
}

function buildActorListItem(
	id: string,
	name: string,
	type: 'human' | 'agent' = 'human',
): ActorListItem {
	return { id, name, type, email: null }
}

describe('ThreadEventItem', () => {
	it('renders system events as centered pills', () => {
		const event = buildEvent({ kind: 'system', body: 'Thread created' })
		render(<ThreadEventItem event={event} actorsById={new Map()} />)

		expect(screen.getByText('Thread created')).toBeInTheDocument()
		// System events don't render an avatar
		expect(screen.queryByRole('img')).not.toBeInTheDocument()
	})

	it('renders resolve event as pill with kind text when no body', () => {
		const event = buildEvent({ kind: 'resolve', body: undefined })
		render(<ThreadEventItem event={event} actorsById={new Map()} />)

		expect(screen.getByText('resolve')).toBeInTheDocument()
	})

	it('renders message events with body text', () => {
		const event = buildEvent({ kind: 'message', body: 'Hello from Alice' })
		render(<ThreadEventItem event={event} actorsById={new Map()} />)

		expect(screen.getByText('Hello from Alice')).toBeInTheDocument()
	})

	it('falls back to truncated UUID when actorsById has no match', () => {
		const event = buildEvent({ actorId: 'abc12345-uuid' })
		render(<ThreadEventItem event={event} actorsById={new Map()} />)

		// First 8 chars of actorId shown as name
		expect(screen.getByText('abc12345')).toBeInTheDocument()
	})

	it('resolves actor name from actorsById map', () => {
		const event = buildEvent({ actorId: 'actor-1' })
		const actorsById = new Map([['actor-1', buildActorListItem('actor-1', 'Alice')]])
		render(<ThreadEventItem event={event} actorsById={actorsById} />)

		expect(screen.getAllByText('Alice').length).toBeGreaterThan(0)
	})

	it('renders join events as system pills', () => {
		const event = buildEvent({ kind: 'join', body: 'Alice joined the thread' })
		render(<ThreadEventItem event={event} actorsById={new Map()} />)

		expect(screen.getByText('Alice joined the thread')).toBeInTheDocument()
	})
})
