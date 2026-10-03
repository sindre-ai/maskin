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
	it('renders the title, status, type, driver, and updated timestamp', () => {
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
		// The driver renders as an avatar whose accessible name is the driver's name.
		expect(screen.getByTitle('Magnus')).toBeInTheDocument()
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
					{ id: 'driver', label: 'Driver', canHide: true },
					{ id: 'metadata.priority', label: 'priority', canHide: true },
				]}
				columnVisibility={{ driver: false }}
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

	describe('advance affordance', () => {
		// The card body is a `<Link>` (`<a>`), so a `<button>` inside it is
		// invalid HTML — React 19 logs `<button> cannot be a descendant of <a>`
		// on every render, spamming the console on the Board view. The advance
		// affordance renders as `<span role="button">` for that reason.
		it('renders the advance affordance without nesting a <button> inside the link', () => {
			const onAdvance = vi.fn()
			render(
				<BoardCard
					object={buildObjectResponse({ id: 'x', title: 'X' })}
					workspaceId="ws-1"
					onAdvance={onAdvance}
					advanceLabel="Move to In Progress"
				/>,
			)
			const advance = screen.getByRole('button', { name: 'Move to In Progress' })
			expect(advance.tagName).toBe('SPAN')
			expect(screen.getByTestId('board-card').querySelector('button')).toBeNull()
		})

		it('invokes onAdvance on click without navigating the card link', async () => {
			const user = userEvent.setup()
			const onAdvance = vi.fn()
			render(
				<BoardCard
					object={buildObjectResponse({ id: 'x', title: 'X' })}
					workspaceId="ws-1"
					onAdvance={onAdvance}
					advanceLabel="Move to In Progress"
				/>,
			)
			await user.click(screen.getByRole('button', { name: 'Move to In Progress' }))
			expect(onAdvance).toHaveBeenCalledTimes(1)
			expect(navigateSpy).not.toHaveBeenCalled()
		})

		it('invokes onAdvance on Enter and Space so keyboard users can reach it', async () => {
			const user = userEvent.setup()
			const onAdvance = vi.fn()
			render(
				<BoardCard
					object={buildObjectResponse({ id: 'x', title: 'X' })}
					workspaceId="ws-1"
					onAdvance={onAdvance}
					advanceLabel="Move to In Progress"
				/>,
			)
			const advance = screen.getByRole('button', { name: 'Move to In Progress' })
			advance.focus()
			await user.keyboard('{Enter}')
			await user.keyboard(' ')
			expect(onAdvance).toHaveBeenCalledTimes(2)
			expect(navigateSpy).not.toHaveBeenCalled()
		})

		it('is reachable in the tab order', () => {
			render(
				<BoardCard
					object={buildObjectResponse({ id: 'x', title: 'X' })}
					workspaceId="ws-1"
					onAdvance={() => {}}
					advanceLabel="Advance"
				/>,
			)
			expect(screen.getByRole('button', { name: 'Advance' })).toHaveAttribute('tabindex', '0')
		})
	})
})
