import { ObjectDetailShell } from '@/components/objects/object-detail-shell'
import { fireEvent, render, screen } from '@testing-library/react'
import { buildObjectResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/hooks/use-subscriptions', () => ({
	useSubscribe: () => ({ mutate: vi.fn() }),
	useUnsubscribe: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => false,
	useIsTouchViewport: () => false,
}))

// CommentInput dependencies — stub the API-driven hooks it reaches for.
vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'actor-1', name: 'Alice', type: 'human' }),
}))

vi.mock('@/hooks/use-events', () => ({
	useCreateComment: () => ({ mutate: vi.fn(), isPending: false }),
}))

vi.mock('@/hooks/use-actors', () => ({
	useActors: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-objects', () => ({
	useUpdateObject: () => ({ mutate: vi.fn() }),
	useDeleteObject: () => ({ mutate: vi.fn(), isPending: false }),
	useObject: () => ({ data: undefined, isLoading: false }),
	useObjectGraph: () => ({ data: { events: [], relationships: [], connected_objects: [] } }),
	useObjects: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-workspaces', () => ({
	useWorkspaceMembers: () => ({ data: [] }),
}))

vi.mock('@/hooks/use-relationships', () => ({
	useCreateRelationship: () => ({ mutate: vi.fn() }),
	useDeleteRelationship: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

describe('ObjectDetailShell', () => {
	const workspace = {
		settings: {
			statuses: {
				bet: ['proposed', 'active', 'done'],
			},
		},
	}

	it('renders ask banner with the open question when _ask metadata present', () => {
		const object = buildObjectResponse({
			type: 'bet',
			metadata: { _ask: 'Should we ship this?' },
		})
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace),
		})
		expect(screen.getByText('Open question')).toBeInTheDocument()
		expect(screen.getByText('Should we ship this?')).toBeInTheDocument()
	})

	it('Answer it moves focus to the answer control', () => {
		const object = buildObjectResponse({
			type: 'bet',
			metadata: { _ask: 'Should we ship this?' },
		})
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace),
		})

		const textarea = screen.getByPlaceholderText(/write a comment/i)
		const answerButton = screen.getByRole('button', { name: /answer it/i })
		fireEvent.click(answerButton)
		expect(document.activeElement).toBe(textarea)
	})

	it('omits the ask banner when no _ask metadata', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace),
		})
		expect(screen.queryByText('Open question')).not.toBeInTheDocument()
	})

	it('renders comment input at the bottom of the shell', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace),
		})
		expect(screen.getByPlaceholderText(/write a comment/i)).toBeInTheDocument()
	})

	it('mounts an Activity / Timeline / Related tab strip below the body', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDetailShell object={object} />, {
			wrapper: createWorkspaceWrapper(workspace),
		})
		expect(screen.getByRole('tab', { name: /^Activity$/ })).toBeInTheDocument()
		expect(screen.getByRole('tab', { name: /^Timeline$/ })).toBeInTheDocument()
		// Related trigger carries the live count (0 with no seeded relationships).
		expect(screen.getByRole('tab', { name: /^Related \(0\)$/ })).toBeInTheDocument()
	})
})
