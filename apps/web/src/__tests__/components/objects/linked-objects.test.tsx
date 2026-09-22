import { AddLinkForm, LinkedObjectsView } from '@/components/objects/linked-objects'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'
import { createWorkspaceWrapper } from '../../setup'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>working</span>,
}))

const baseProps = {
	objectId: 'obj-1',
	objectType: 'bet',
	workspaceId: 'ws-1',
	relationshipTypes: ['informs', 'breaks_into'],
	onCreateRelationship: vi.fn(),
	onDeleteRelationship: vi.fn(),
}

describe('LinkedObjectsView', () => {
	it('shows "Related (N)" header with correct count', () => {
		const target = buildObjectResponse({ id: 'obj-2', title: 'Linked' })
		const rel = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-2' })

		render(
			<LinkedObjectsView {...baseProps} asSource={[rel]} asTarget={[]} allObjects={[target]} />,
		)

		expect(screen.getByText('Related (1)')).toBeInTheDocument()
	})

	it('renders linked object titles', () => {
		const target = buildObjectResponse({ id: 'obj-2', title: 'My Insight' })
		const rel = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-2' })

		render(
			<LinkedObjectsView {...baseProps} asSource={[rel]} asTarget={[]} allObjects={[target]} />,
		)

		expect(screen.getByText('My Insight')).toBeInTheDocument()
	})

	it('resolves linked objects regardless of canonical or legacy sourceType/targetType labels', () => {
		// Two edges pointing at the same object endpoint: one written with
		// canonical type labels ('object'), one with legacy specialized labels
		// ('insight', 'bet'). Both should render the linked object identically.
		const target = buildObjectResponse({ id: 'obj-2', title: 'Shared Target' })

		const canonicalRel = buildRelationshipResponse({
			id: 'rel-canonical',
			sourceId: 'obj-1',
			targetId: 'obj-2',
			sourceType: 'object',
			targetType: 'object',
		})
		const legacyRel = buildRelationshipResponse({
			id: 'rel-legacy',
			sourceId: 'obj-1',
			targetId: 'obj-2',
			sourceType: 'insight',
			targetType: 'bet',
		})

		render(
			<LinkedObjectsView
				{...baseProps}
				asSource={[canonicalRel, legacyRel]}
				asTarget={[]}
				allObjects={[target]}
			/>,
		)

		// Both edges resolve to the same target object, producing two rows
		// with the same title. Verify both rows are present.
		expect(screen.getAllByText('Shared Target')).toHaveLength(2)
		expect(screen.getByText('Related (2)')).toBeInTheDocument()
	})

	it('shows "Untitled" for objects without title', () => {
		const target = buildObjectResponse({ id: 'obj-2', title: null })
		const rel = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-2' })

		render(
			<LinkedObjectsView {...baseProps} asSource={[rel]} asTarget={[]} allObjects={[target]} />,
		)

		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('shows a Controls popover with type filter when 2+ types present', async () => {
		const user = userEvent.setup()
		const obj2 = buildObjectResponse({ id: 'obj-2', type: 'insight', title: 'Insight' })
		const obj3 = buildObjectResponse({ id: 'obj-3', type: 'task', title: 'Task' })
		const rel1 = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-2' })
		const rel2 = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-3' })

		render(
			<LinkedObjectsView
				{...baseProps}
				asSource={[rel1, rel2]}
				asTarget={[]}
				allObjects={[obj2, obj3]}
			/>,
		)

		await user.click(screen.getByRole('button', { name: /controls/i }))
		expect(screen.getByText('Filter by type')).toBeInTheDocument()
		// Type names also appear in the table's Type column, so query all
		expect(screen.getAllByText('insight').length).toBeGreaterThan(0)
		expect(screen.getAllByText('task').length).toBeGreaterThan(0)
	})

	it('does not show Controls popover with single type', () => {
		const obj2 = buildObjectResponse({ id: 'obj-2', type: 'insight', title: 'A' })
		const rel = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-2' })

		render(<LinkedObjectsView {...baseProps} asSource={[rel]} asTarget={[]} allObjects={[obj2]} />)

		expect(screen.queryByRole('button', { name: /controls/i })).not.toBeInTheDocument()
	})

	it('shows "Add link" button', () => {
		render(<LinkedObjectsView {...baseProps} asSource={[]} asTarget={[]} allObjects={[]} />)

		expect(screen.getByRole('button', { name: 'Add link' })).toBeInTheDocument()
	})

	it('resolves linked objects from connectedObjects when missing from allObjects', () => {
		// The picker (allObjects) is paginated and may not contain the linked object;
		// connectedObjects (from the graph endpoint) is the authoritative source.
		const linkedTask = buildObjectResponse({ id: 'task-99', title: 'Far Task', type: 'task' })
		const rel = buildRelationshipResponse({
			id: 'rel-far',
			sourceId: 'task-99',
			targetId: 'obj-1',
			type: 'breaks_into',
		})

		render(
			<LinkedObjectsView
				{...baseProps}
				asSource={[]}
				asTarget={[rel]}
				allObjects={[]}
				connectedObjects={[linkedTask]}
			/>,
		)

		expect(screen.getByText('Far Task')).toBeInTheDocument()
		expect(screen.getByText('Related (1)')).toBeInTheDocument()
	})

	it('calls onDeleteRelationship when remove button clicked', async () => {
		const user = userEvent.setup()
		const onDelete = vi.fn()
		const target = buildObjectResponse({ id: 'obj-2', title: 'Target' })
		const rel = buildRelationshipResponse({ id: 'rel-1', sourceId: 'obj-1', targetId: 'obj-2' })

		render(
			<LinkedObjectsView
				{...baseProps}
				onDeleteRelationship={onDelete}
				asSource={[rel]}
				asTarget={[]}
				allObjects={[target]}
			/>,
		)

		await user.click(screen.getByTitle('Remove link'))
		expect(onDelete).toHaveBeenCalledWith('rel-1')
	})

	// ── Slice 1: files as first-class endpoints ───────────────────────

	it('renders a FileRow for a file-endpoint edge with hydrated name', () => {
		// A relationship whose endpoint id resolves in `files[]` (the graph
		// endpoint's hydrated file summary) — the resolver picks the file up
		// via the fileMap and renders it as a FileRow with its filename +
		// mime/size meta.
		const file = {
			id: 'file-1',
			name: 'design.md',
			mimeType: 'text/markdown',
			sizeBytes: 4096,
			url: 'https://example.com/f/file-1',
		}
		const rel = buildRelationshipResponse({
			id: 'rel-file',
			sourceId: 'obj-1',
			targetId: 'file-1',
			sourceType: 'object',
			targetType: 'file',
			type: 'attached',
		})

		render(
			<LinkedObjectsView
				{...baseProps}
				asSource={[rel]}
				asTarget={[]}
				allObjects={[]}
				files={[file]}
			/>,
		)

		// Filename lives inside an <a> — carrying the accessible name for the
		// row because the mime tile is aria-hidden per Designer §7.
		expect(screen.getByRole('link', { name: /design\.md/ })).toBeInTheDocument()
		// The mono meta line renders mime + human-readable size ("text/markdown · 4 KB").
		expect(screen.getByText(/text\/markdown/)).toBeInTheDocument()
	})

	it('shows the empty state with Link to object / Link to file CTAs when no rows', () => {
		render(<LinkedObjectsView {...baseProps} asSource={[]} asTarget={[]} allObjects={[]} />)
		expect(screen.getByText('No links yet')).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Link to object' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Link to file' })).toBeInTheDocument()
	})

	it('shows a loading skeleton band when isLoading', () => {
		render(
			<LinkedObjectsView {...baseProps} isLoading asSource={[]} asTarget={[]} allObjects={[]} />,
		)
		expect(screen.getByLabelText('Loading related items')).toBeInTheDocument()
	})

	it('shows the inline error card with a Retry button when isError', async () => {
		const user = userEvent.setup()
		const onRetry = vi.fn()
		render(
			<LinkedObjectsView
				{...baseProps}
				isError
				errorStatus={500}
				onRetry={onRetry}
				asSource={[]}
				asTarget={[]}
				allObjects={[]}
			/>,
		)
		expect(screen.getByRole('alert')).toHaveTextContent("Couldn't load related items.")
		expect(screen.getByRole('alert')).toHaveTextContent('failed · 500')
		await user.click(screen.getByRole('button', { name: 'Retry' }))
		expect(onRetry).toHaveBeenCalled()
	})
})

describe('AddLinkForm — Objects | Files tab strip', () => {
	const commonProps = {
		objectId: 'obj-1',
		objectType: 'bet',
		allObjects: [buildObjectResponse({ id: 'obj-2', title: 'Related bet' })],
		relationshipTypes: ['informs', 'attached', 'relates_to'],
		existingRelationships: [],
		onCreateRelationship: vi.fn(),
		onClose: vi.fn(),
	}

	it('defaults to the Objects tab and can flip to Files via keyboard shortcut', async () => {
		const user = userEvent.setup()
		const Wrapper = createWorkspaceWrapper()
		render(<AddLinkForm {...commonProps} />, { wrapper: Wrapper })

		// Objects tab renders active — its aria-pressed reads true.
		expect(screen.getByRole('button', { name: /Objects/ })).toHaveAttribute('aria-pressed', 'true')
		expect(screen.getByRole('button', { name: /Files/ })).toHaveAttribute('aria-pressed', 'false')

		// Alt+F flips to Files; the search-input placeholder switches too.
		const search = screen.getByPlaceholderText(/Search objects/)
		await user.click(search)
		await user.keyboard('{Alt>}f{/Alt}')
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Files/ })).toHaveAttribute('aria-pressed', 'true'),
		)
		expect(screen.getByPlaceholderText(/Search files by name/)).toBeInTheDocument()

		// Alt+O jumps back.
		await user.keyboard('{Alt>}o{/Alt}')
		await waitFor(() =>
			expect(screen.getByRole('button', { name: /Objects/ })).toHaveAttribute(
				'aria-pressed',
				'true',
			),
		)
	})

	it('carries role=listbox with role=option children and aria-selected on the active row', () => {
		const Wrapper = createWorkspaceWrapper()
		render(
			<AddLinkForm
				{...commonProps}
				allObjects={[
					buildObjectResponse({ id: 'obj-2', title: 'Second bet', type: 'bet' }),
					buildObjectResponse({ id: 'obj-3', title: 'Third bet', type: 'bet' }),
				]}
			/>,
			{ wrapper: Wrapper },
		)

		const listbox = screen.getByRole('listbox', { name: 'Objects' })
		expect(listbox).toBeInTheDocument()
		const options = screen.getAllByRole('option')
		expect(options.length).toBeGreaterThan(0)
		expect(options[0]).toHaveAttribute('aria-selected', 'true')
	})
})
