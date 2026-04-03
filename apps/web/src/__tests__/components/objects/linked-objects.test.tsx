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

	it('shows filter buttons when 2+ types present', () => {
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

		expect(screen.getByText('All 2')).toBeInTheDocument()
		expect(screen.getByText('insights 1')).toBeInTheDocument()
		expect(screen.getByText('tasks 1')).toBeInTheDocument()
	})

	it('does not show filter buttons with single type', () => {
		const obj2 = buildObjectResponse({ id: 'obj-2', type: 'insight', title: 'A' })
		const rel = buildRelationshipResponse({ sourceId: 'obj-1', targetId: 'obj-2' })

		render(<LinkedObjectsView {...baseProps} asSource={[rel]} asTarget={[]} allObjects={[obj2]} />)

		expect(screen.queryByText('All 1')).not.toBeInTheDocument()
	})

	it('shows "+ link" button', () => {
		render(<LinkedObjectsView {...baseProps} asSource={[]} asTarget={[]} allObjects={[]} />)

		expect(screen.getByText('+ link')).toBeInTheDocument()
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
