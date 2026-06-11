import { ObjectDocumentView } from '@/components/objects/object-document'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { buildActorResponse, buildObjectResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>agent working</span>,
}))

vi.mock('@/components/shared/markdown-content', () => ({
	MarkdownContent: ({ content }: { content: string }) => <div>{content}</div>,
}))

vi.mock('@/components/activity/object-activity', () => ({
	ObjectActivity: () => <div data-testid="object-activity" />,
}))

vi.mock('@/components/shared/subscribe-toggle', () => ({
	SubscribeToggle: () => <div data-testid="subscribe-toggle" />,
}))

vi.mock('@/components/objects/metadata-properties', () => ({
	MetadataProperties: () => <div data-testid="metadata-properties" />,
}))

vi.mock('@/components/objects/linked-objects', () => ({
	LinkedObjects: () => <div data-testid="linked-objects" />,
}))

vi.mock('@/components/objects/object-files', () => ({
	ObjectFiles: () => <div data-testid="object-files" />,
}))

const baseProps = {
	workspaceId: 'ws-1',
	statuses: ['proposed', 'active', 'done'],
	onUpdateTitle: vi.fn(),
	onUpdateContent: vi.fn(),
	onUpdateStatus: vi.fn(),
	onUpdateDriver: vi.fn(),
	onDelete: vi.fn(),
}

describe('ObjectDocumentView', () => {
	it('renders title in textarea', () => {
		const object = buildObjectResponse({ title: 'My Bet' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.getByDisplayValue('My Bet')).toBeInTheDocument()
	})

	it('renders type badge', () => {
		const object = buildObjectResponse({ type: 'bet' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.getByText('bet')).toBeInTheDocument()
	})

	it('shows creator name and avatar when provided', () => {
		const object = buildObjectResponse()
		const creator = buildActorResponse({ name: 'Alice' })
		render(<ObjectDocumentView {...baseProps} object={object} creator={creator} />)
		expect(screen.getByText('Alice')).toBeInTheDocument()
	})

	it('calls onUpdateTitle on blur when title changed', async () => {
		const user = userEvent.setup()
		const onUpdateTitle = vi.fn()
		const object = buildObjectResponse({ title: 'Original' })

		render(<ObjectDocumentView {...baseProps} object={object} onUpdateTitle={onUpdateTitle} />)

		const textarea = screen.getByDisplayValue('Original')
		await user.clear(textarea)
		await user.type(textarea, 'New Title')
		await user.tab()

		expect(onUpdateTitle).toHaveBeenCalledWith('New Title')
	})

	it('does not call onUpdateTitle on blur when title unchanged', async () => {
		const user = userEvent.setup()
		const onUpdateTitle = vi.fn()
		const object = buildObjectResponse({ title: 'Same' })

		render(<ObjectDocumentView {...baseProps} object={object} onUpdateTitle={onUpdateTitle} />)

		const textarea = screen.getByDisplayValue('Same')
		await user.click(textarea)
		await user.tab()

		expect(onUpdateTitle).not.toHaveBeenCalled()
	})

	it('shows "Saved" indicator when showSaved is true', () => {
		const object = buildObjectResponse()
		render(<ObjectDocumentView {...baseProps} object={object} showSaved />)
		expect(screen.getByText('Saved')).toBeInTheDocument()
	})

	it('does not show "Saved" indicator by default', () => {
		const object = buildObjectResponse()
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.queryByText('Saved')).not.toBeInTheDocument()
	})

	it('shows AgentWorkingBadge when activeSessionId present', () => {
		const object = buildObjectResponse({ activeSessionId: 'session-1' })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.getByText('agent working')).toBeInTheDocument()
	})

	it('does not show AgentWorkingBadge when no active session', () => {
		const object = buildObjectResponse({ activeSessionId: null })
		render(<ObjectDocumentView {...baseProps} object={object} />)
		expect(screen.queryByText('agent working')).not.toBeInTheDocument()
	})

	describe('ViewportChecklist', () => {
		it('renders for task in in_review status', () => {
			const object = buildObjectResponse({ type: 'task', status: 'in_review' })
			render(
				<ObjectDocumentView
					{...baseProps}
					statuses={[...baseProps.statuses, 'in_review']}
					object={object}
				/>,
			)
			expect(
				screen.getByText('Verify at all breakpoints before approving'),
			).toBeInTheDocument()
			expect(screen.getByText('Desktop (≥1024px)')).toBeInTheDocument()
			expect(screen.getByText('Tablet (768–1024px)')).toBeInTheDocument()
			expect(screen.getByText('Mobile (<768px)')).toBeInTheDocument()
		})

		it('does not render for task with a different status', () => {
			const object = buildObjectResponse({ type: 'task', status: 'active' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(
				screen.queryByText('Verify at all breakpoints before approving'),
			).not.toBeInTheDocument()
		})

		it('does not render for a non-task object with in_review status', () => {
			const object = buildObjectResponse({ type: 'bet', status: 'in_review' })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(
				screen.queryByText('Verify at all breakpoints before approving'),
			).not.toBeInTheDocument()
		})

		it('toggles checkboxes independently', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const object = buildObjectResponse({ type: 'task', status: 'in_review' })
			render(
				<ObjectDocumentView
					{...baseProps}
					statuses={[...baseProps.statuses, 'in_review']}
					object={object}
				/>,
			)
			const checkboxes = screen.getAllByRole('checkbox')
			expect(checkboxes[0]).toHaveAttribute('aria-checked', 'false')

			await user.click(checkboxes[0])
			expect(checkboxes[0]).toHaveAttribute('aria-checked', 'true')
			expect(checkboxes[1]).toHaveAttribute('aria-checked', 'false')
		})
	})

	describe('OwnerSelect', () => {
		const members = [
			{ actorId: 'actor-alice', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
			{ actorId: 'actor-bot', role: 'member', joinedAt: null, name: 'Bot', type: 'agent' },
		]

		it('does not render owner select when members are not provided', () => {
			const object = buildObjectResponse({ driver: null })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByText('Unassigned')).not.toBeInTheDocument()
		})

		it('shows "Unassigned" when owner is null', () => {
			const object = buildObjectResponse({ driver: null })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText('Driver: Unassigned')).toBeInTheDocument()
		})

		it('shows owner name when owner is a current member', () => {
			const object = buildObjectResponse({ driver: 'actor-alice' })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText('Alice')).toBeInTheDocument()
		})

		it('shows "Unknown" fallback when owner is set but not in members', () => {
			const object = buildObjectResponse({ driver: 'actor-removed-12345678-abcd' })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText(/Unknown \(actor-re\)/)).toBeInTheDocument()
		})

		it('calls onUpdateDriver with actor id when selecting a member', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const onUpdateDriver = vi.fn()
			const object = buildObjectResponse({ driver: null })
			render(
				<ObjectDocumentView
					{...baseProps}
					object={object}
					members={members}
					onUpdateDriver={onUpdateDriver}
				/>,
			)

			const triggers = screen.getAllByRole('combobox')
			await user.click(triggers[triggers.length - 1])
			await user.click(screen.getByRole('option', { name: /Alice/ }))

			expect(onUpdateDriver).toHaveBeenCalledWith('actor-alice')
		})

		it('calls onUpdateDriver with null when selecting "Unassigned"', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const onUpdateDriver = vi.fn()
			const object = buildObjectResponse({ driver: 'actor-alice' })
			render(
				<ObjectDocumentView
					{...baseProps}
					object={object}
					members={members}
					onUpdateDriver={onUpdateDriver}
				/>,
			)

			const triggers = screen.getAllByRole('combobox')
			await user.click(triggers[triggers.length - 1])
			await user.click(screen.getByRole('option', { name: /Unassigned/ }))

			expect(onUpdateDriver).toHaveBeenCalledWith(null)
		})
	})
})
