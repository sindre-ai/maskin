import { RelationshipsTable } from '@/components/activity/relationships-table'
import type { ObjectResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

function indexById(objects: ObjectResponse[]) {
	const map = new Map<string, ObjectResponse>()
	for (const obj of objects) map.set(obj.id, obj)
	return map
}

describe('RelationshipsTable', () => {
	it('groups rows by edge type (AC-U12)', () => {
		const targetA = buildObjectResponse({ id: 'a', title: 'Source insight' })
		const targetB = buildObjectResponse({ id: 'b', title: 'Child task', type: 'task' })
		const relA = buildRelationshipResponse({
			id: 'r-a',
			type: 'informs',
			sourceId: 'a',
			targetId: 'bet-1',
		})
		const relB = buildRelationshipResponse({
			id: 'r-b',
			type: 'breaks_into',
			sourceId: 'bet-1',
			targetId: 'b',
		})
		render(
			<RelationshipsTable
				objectId="bet-1"
				relationships={[relA, relB]}
				objectsById={indexById([targetA, targetB])}
				workspaceId="ws-1"
			/>,
		)
		expect(screen.getByText(/informs/i)).toBeInTheDocument()
		expect(screen.getByText(/breaks into/i)).toBeInTheDocument()
		expect(screen.getByText('Source insight')).toBeInTheDocument()
		expect(screen.getByText('Child task')).toBeInTheDocument()
	})

	it('renders the empty hint when there are no relationships', () => {
		render(
			<RelationshipsTable
				objectId="bet-1"
				relationships={[]}
				objectsById={new Map()}
				workspaceId="ws-1"
			/>,
		)
		expect(screen.getByText(/no related objects yet/i)).toBeInTheDocument()
	})

	it('shows a muted fallback when the linked object cannot be resolved', () => {
		const rel = buildRelationshipResponse({
			id: 'r-missing',
			type: 'informs',
			sourceId: 'gone',
			targetId: 'bet-1',
			sourceTitle: 'Deleted insight',
		})
		render(
			<RelationshipsTable
				objectId="bet-1"
				relationships={[rel]}
				objectsById={new Map()}
				workspaceId="ws-1"
			/>,
		)
		expect(screen.getByText('Deleted insight')).toBeInTheDocument()
	})

	it("shows sourceTitle, not the viewed object's own targetTitle, for a missing inbound link", () => {
		// The backend denormalizes both endpoints' titles onto every relationship,
		// including the currently-viewed object's own title as `targetTitle`.
		// For an inbound edge the missing object is the source — the fallback
		// must read `sourceTitle`, not `targetTitle`.
		const rel = buildRelationshipResponse({
			id: 'r-missing-inbound',
			type: 'informs',
			sourceId: 'gone',
			targetId: 'bet-1',
			sourceTitle: 'Deleted insight',
			targetTitle: 'My own bet title',
		})
		render(
			<RelationshipsTable
				objectId="bet-1"
				relationships={[rel]}
				objectsById={new Map()}
				workspaceId="ws-1"
			/>,
		)
		expect(screen.getByText('Deleted insight')).toBeInTheDocument()
		expect(screen.queryByText('My own bet title')).not.toBeInTheDocument()
	})

	it('calls onDelete with the relationship id when remove button is clicked', async () => {
		const user = userEvent.setup()
		const onDelete = vi.fn()
		const linked = buildObjectResponse({ id: 'obj-link', title: 'Linked' })
		const rel = buildRelationshipResponse({
			id: 'r-remove',
			type: 'relates_to',
			sourceId: 'bet-1',
			targetId: 'obj-link',
		})
		render(
			<RelationshipsTable
				objectId="bet-1"
				relationships={[rel]}
				objectsById={indexById([linked])}
				workspaceId="ws-1"
				onDelete={onDelete}
			/>,
		)
		await user.click(screen.getByRole('button', { name: /remove link/i }))
		expect(onDelete).toHaveBeenCalledWith('r-remove')
	})
})
