import {
	DeleteConfirmDialog,
	type DeleteDialogChildTask,
	ObjectDocumentView,
} from '@/components/objects/object-document'
import { render, screen, within } from '@testing-library/react'
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
	onUpdateOwner: vi.fn(),
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

	describe('OwnerSelect', () => {
		const members = [
			{ actorId: 'actor-alice', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
			{ actorId: 'actor-bot', role: 'member', joinedAt: null, name: 'Bot', type: 'agent' },
		]

		it('does not render owner select when members are not provided', () => {
			const object = buildObjectResponse({ owner: null })
			render(<ObjectDocumentView {...baseProps} object={object} />)
			expect(screen.queryByText('Unassigned')).not.toBeInTheDocument()
		})

		it('shows "Unassigned" when owner is null', () => {
			const object = buildObjectResponse({ owner: null })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText('Unassigned')).toBeInTheDocument()
		})

		it('shows owner name when owner is a current member', () => {
			const object = buildObjectResponse({ owner: 'actor-alice' })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText('Alice')).toBeInTheDocument()
		})

		it('shows "Unknown" fallback when owner is set but not in members', () => {
			const object = buildObjectResponse({ owner: 'actor-removed-12345678-abcd' })
			render(<ObjectDocumentView {...baseProps} object={object} members={members} />)
			expect(screen.getByText(/Unknown \(actor-re\)/)).toBeInTheDocument()
		})

		it('calls onUpdateOwner with actor id when selecting a member', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const onUpdateOwner = vi.fn()
			const object = buildObjectResponse({ owner: null })
			render(
				<ObjectDocumentView
					{...baseProps}
					object={object}
					members={members}
					onUpdateOwner={onUpdateOwner}
				/>,
			)

			const triggers = screen.getAllByRole('combobox')
			await user.click(triggers[triggers.length - 1])
			await user.click(screen.getByRole('option', { name: /Alice/ }))

			expect(onUpdateOwner).toHaveBeenCalledWith('actor-alice')
		})

		it('calls onUpdateOwner with null when selecting "Unassigned"', async () => {
			const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
			const onUpdateOwner = vi.fn()
			const object = buildObjectResponse({ owner: 'actor-alice' })
			render(
				<ObjectDocumentView
					{...baseProps}
					object={object}
					members={members}
					onUpdateOwner={onUpdateOwner}
				/>,
			)

			const triggers = screen.getAllByRole('combobox')
			await user.click(triggers[triggers.length - 1])
			await user.click(screen.getByRole('option', { name: /Unassigned/ }))

			expect(onUpdateOwner).toHaveBeenCalledWith(null)
		})
	})
})

describe('DeleteConfirmDialog cascade', () => {
	function buildChildTask(overrides: Partial<DeleteDialogChildTask> = {}): DeleteDialogChildTask {
		return {
			id: overrides.id ?? 'task-1',
			title: overrides.title ?? 'Task 1',
			status: overrides.status ?? 'in_progress',
			relationshipId: overrides.relationshipId ?? `rel-${overrides.id ?? 'task-1'}`,
		}
	}

	function getListbar() {
		const summary = screen.getByText(/will be deleted$/)
		// The summary span and the "Detach all instead" button share a parent.
		const bar = summary.parentElement
		if (!bar) throw new Error('Listbar parent missing')
		return bar
	}

	it('renders the plain confirm path when a bet has 0 child tasks', () => {
		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				objectTitle="Lonely bet"
				childTasks={[]}
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)

		expect(screen.getByRole('heading', { name: /delete this bet\?/i })).toBeInTheDocument()
		expect(screen.queryByText(/will be deleted$/)).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /detach all instead/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
	})

	it('renders 3 rows all-checked with the cascade-default listbar and button', () => {
		const childTasks = [
			buildChildTask({ id: 't1', title: 'First task', status: 'todo' }),
			buildChildTask({ id: 't2', title: 'Second task', status: 'in_progress' }),
			buildChildTask({ id: 't3', title: 'Third task', status: 'in_review' }),
		]

		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				objectTitle="Big bet"
				childTasks={childTasks}
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)

		const checkboxes = screen.getAllByRole('checkbox')
		expect(checkboxes).toHaveLength(3)
		for (const cb of checkboxes) {
			expect(cb).toHaveAttribute('aria-checked', 'true')
		}
		expect(within(getListbar()).getByText('3 of 3 will be deleted')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: /delete bet · 3 deleted · 0 kept/i }),
		).toBeInTheDocument()
	})

	it('updates listbar, button, and row styling when one row is unchecked', async () => {
		const user = userEvent.setup()
		const childTasks = [
			buildChildTask({ id: 't1', title: 'First task' }),
			buildChildTask({ id: 't2', title: 'Second task' }),
			buildChildTask({ id: 't3', title: 'Third task' }),
		]

		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				objectTitle="Big bet"
				childTasks={childTasks}
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)

		const secondCheckbox = screen.getByRole('checkbox', { name: /second task/i })
		await user.click(secondCheckbox)

		expect(secondCheckbox).toHaveAttribute('aria-checked', 'false')
		expect(within(getListbar()).getByText('2 of 3 will be deleted')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: /delete bet · 2 deleted · 1 kept/i }),
		).toBeInTheDocument()

		const secondTitleSpan = screen.getByText('Second task')
		expect(secondTitleSpan.className).toMatch(/line-through/)
	})

	it('starts every row OFF when every child task is done', () => {
		const childTasks = [
			buildChildTask({ id: 't1', title: 'Done one', status: 'done' }),
			buildChildTask({ id: 't2', title: 'Done two', status: 'done' }),
		]

		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				objectTitle="Wrapped bet"
				childTasks={childTasks}
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)

		for (const cb of screen.getAllByRole('checkbox')) {
			expect(cb).toHaveAttribute('aria-checked', 'false')
		}
		expect(within(getListbar()).getByText('0 of 2 will be deleted')).toBeInTheDocument()
		expect(
			screen.getByRole('button', { name: /delete bet · 0 deleted · 2 kept/i }),
		).toBeInTheDocument()
	})

	it('unchecks every row when "Detach all instead" is clicked', async () => {
		const user = userEvent.setup()
		const childTasks = [
			buildChildTask({ id: 't1', title: 'Task A' }),
			buildChildTask({ id: 't2', title: 'Task B' }),
			buildChildTask({ id: 't3', title: 'Task C' }),
		]

		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				objectTitle="Bet to drain"
				childTasks={childTasks}
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)

		await user.click(screen.getByRole('button', { name: /detach all instead/i }))

		for (const cb of screen.getAllByRole('checkbox')) {
			expect(cb).toHaveAttribute('aria-checked', 'false')
		}
		expect(
			screen.getByRole('button', { name: /delete bet · 0 deleted · 3 kept/i }),
		).toBeInTheDocument()
	})

	it('passes mixed selection to onConfirm — checked rows in deleteTaskIds, unchecked in detachRelationshipIds', async () => {
		const user = userEvent.setup()
		const onConfirm = vi.fn()
		const childTasks = [
			buildChildTask({ id: 't-keep', title: 'Task to keep', relationshipId: 'rel-keep' }),
			buildChildTask({ id: 't-go-1', title: 'Task to delete 1', relationshipId: 'rel-go-1' }),
			buildChildTask({ id: 't-go-2', title: 'Task to delete 2', relationshipId: 'rel-go-2' }),
		]

		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="bet"
				objectTitle="Mixed bet"
				childTasks={childTasks}
				onConfirm={onConfirm}
				isPending={false}
			/>,
		)

		await user.click(screen.getByRole('checkbox', { name: /task to keep/i }))
		await user.click(screen.getByRole('button', { name: /delete bet · 2 deleted · 1 kept/i }))

		// The dialog's job is to partition the selection. The cascade hook
		// (covered by use-objects.test.ts) runs detaches first, then deletes,
		// then the bet — preserving the kept-task edge before any failure can
		// drop it.
		expect(onConfirm).toHaveBeenCalledTimes(1)
		expect(onConfirm).toHaveBeenCalledWith({
			deleteTaskIds: ['t-go-1', 't-go-2'],
			detachRelationshipIds: ['rel-keep'],
		})
	})

	it('renders inline error + Retry, leaves the dialog open, and Retry fires onRetry not onConfirm', async () => {
		const user = userEvent.setup()
		const onConfirm = vi.fn()
		const onRetry = vi.fn()
		const onOpenChange = vi.fn()
		const childTasks = [
			buildChildTask({ id: 't1', title: 'First task' }),
			buildChildTask({ id: 't2', title: 'Second task' }),
		]

		render(
			<DeleteConfirmDialog
				open
				onOpenChange={onOpenChange}
				objectType="bet"
				objectTitle="Half-deleted bet"
				childTasks={childTasks}
				onConfirm={onConfirm}
				onRetry={onRetry}
				errorMessage="Network blew up halfway through"
				isPending={false}
			/>,
		)

		const alert = screen.getByRole('alert')
		expect(within(alert).getByText('Delete failed')).toBeInTheDocument()
		expect(within(alert).getByText(/network blew up halfway through/i)).toBeInTheDocument()

		const retryButton = screen.getByRole('button', { name: /^retry delete$/i })
		await user.click(retryButton)

		expect(onRetry).toHaveBeenCalledTimes(1)
		expect(onConfirm).not.toHaveBeenCalled()
		// The dialog stays open through retry — onOpenChange is the cancel-or-
		// close signal, never invoked by Retry.
		expect(onOpenChange).not.toHaveBeenCalled()
	})

	it('uses the simple confirm path for non-bet object types even when childTasks is passed', () => {
		render(
			<DeleteConfirmDialog
				open
				onOpenChange={vi.fn()}
				objectType="task"
				objectTitle="A task"
				childTasks={[buildChildTask({ id: 't1', title: 'Ignored sub-task' })]}
				onConfirm={vi.fn()}
				isPending={false}
			/>,
		)

		expect(screen.queryByText(/will be deleted$/)).not.toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /detach all instead/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('checkbox')).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /^delete$/i })).toBeInTheDocument()
	})
})
