import { BoardCard } from '@/components/objects/board/board-card'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorListItem, buildObjectResponse } from '../../../factories'

const navigateSpy = vi.fn()

vi.mock('@tanstack/react-router', () => ({
	Link: ({
		to,
		params,
		children,
		onClick,
		...rest
	}: {
		to: string
		params?: Record<string, string>
		children: React.ReactNode
		onClick?: (e: React.MouseEvent) => void
		[key: string]: unknown
	}) => {
		let href = to
		if (params) {
			for (const [k, v] of Object.entries(params)) {
				href = href.replace(`$${k}`, v)
			}
		}
		return (
			<a
				href={href}
				onClick={(e) => {
					e.preventDefault()
					navigateSpy(href)
					onClick?.(e)
				}}
				{...rest}
			>
				{children}
			</a>
		)
	},
}))

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: ({ sessionId }: { sessionId: string }) => (
		<span data-testid="agent-working-badge">agent working ({sessionId})</span>
	),
}))

beforeEach(() => {
	navigateSpy.mockClear()
})

describe('BoardCard', () => {
	it('renders the title, status, type, owner, and updated timestamp', () => {
		const actors = [buildActorListItem({ id: 'actor-7', name: 'Magnus' })]
		const obj = buildObjectResponse({
			id: 'obj-1',
			type: 'task',
			status: 'in_progress',
			title: 'Wire up board',
			driver: 'actor-7',
			updatedAt: new Date(Date.now() - 60_000).toISOString(),
		})
		render(<BoardCard object={obj} workspaceId="ws-1" actors={actors} />)
		expect(screen.getByText('Wire up board')).toBeInTheDocument()
		expect(screen.getByText('in progress')).toBeInTheDocument()
		expect(screen.getByText('task')).toBeInTheDocument()
		expect(screen.getByText('Magnus')).toBeInTheDocument()
		// Relative time renders as a <time> element.
		expect(screen.getByRole('time')).toBeInTheDocument()
	})

	it('falls back to "Untitled" when the title is empty', () => {
		render(<BoardCard object={buildObjectResponse({ title: '' })} workspaceId="ws-1" />)
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('shows the AgentWorkingBadge when activeSessionId is set', () => {
		render(
			<BoardCard object={buildObjectResponse({ activeSessionId: 'sess-42' })} workspaceId="ws-1" />,
		)
		expect(screen.getByTestId('agent-working-badge')).toBeInTheDocument()
	})

	it('respects display property visibility', () => {
		const actors = [buildActorListItem({ id: 'actor-7', name: 'Magnus' })]
		const obj = buildObjectResponse({
			id: 'obj-1',
			type: 'task',
			status: 'todo',
			title: 'Visible properties',
			driver: 'actor-7',
			metadata: { priority: 'High' },
		})
		render(
			<BoardCard
				object={obj}
				workspaceId="ws-1"
				actors={actors}
				columns={[
					{ id: 'title', label: 'Title', canHide: false },
					{ id: 'status', label: 'Status', canHide: true },
					{ id: 'owner', label: 'Owner', canHide: true },
					{ id: 'metadata.priority', label: 'priority', canHide: true },
				]}
				columnVisibility={{ owner: false }}
			/>,
		)

		expect(screen.getByText('todo')).toBeInTheDocument()
		expect(screen.queryByText('Magnus')).not.toBeInTheDocument()
		expect(screen.getByText(/priority:/)).toBeInTheDocument()
		expect(screen.getByText(/High/)).toBeInTheDocument()
	})

	it('does not show the AgentWorkingBadge when activeSessionId is null', () => {
		render(<BoardCard object={buildObjectResponse({ activeSessionId: null })} workspaceId="ws-1" />)
		expect(screen.queryByTestId('agent-working-badge')).not.toBeInTheDocument()
	})

	it('links to the object detail route with the right workspace and object ids', () => {
		const obj = buildObjectResponse({ id: 'obj-abc', title: 'X' })
		render(<BoardCard object={obj} workspaceId="ws-xyz" />)
		const link = screen.getByTestId('board-card')
		expect(link.tagName).toBe('A')
		expect(link).toHaveAttribute('href', '/ws-xyz/objects/obj-abc')
	})

	it('navigates to the object detail route when clicked', async () => {
		const user = userEvent.setup()
		const obj = buildObjectResponse({ id: 'obj-abc', title: 'X' })
		render(<BoardCard object={obj} workspaceId="ws-xyz" />)
		await user.click(screen.getByTestId('board-card'))
		expect(navigateSpy).toHaveBeenCalledWith('/ws-xyz/objects/obj-abc')
	})
})
