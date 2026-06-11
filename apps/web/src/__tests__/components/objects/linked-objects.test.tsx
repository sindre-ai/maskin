import { LinkedObjectsView } from '@/components/objects/linked-objects'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'

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
})
