import { RelatedObjectsTable } from '@/components/objects/related-objects-table'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildActorListItem, buildObjectResponse, buildRelationshipResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>working</span>,
}))

function buildRow(
	objectOverrides: Parameters<typeof buildObjectResponse>[0] = {},
	relOverrides: Parameters<typeof buildRelationshipResponse>[0] = {},
) {
	const object = buildObjectResponse(objectOverrides)
	const rel = buildRelationshipResponse({ targetId: object.id, ...relOverrides })
	return { rel, object }
}

const baseProps = {
	workspaceId: 'ws-1',
	actors: [],
	onDeleteRelationship: vi.fn(),
}

describe('RelatedObjectsTable', () => {
	it('renders a table header with the expected columns', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow()]} />)

		expect(screen.getByRole('columnheader', { name: /title/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /relationship/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /^type$/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /owner/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /updated/i })).toBeInTheDocument()
	})

	it('renders one row per related object with title, relationship type, and status', () => {
		const rows = [
			buildRow({ title: 'Alpha', status: 'active' }, { type: 'blocks' }),
			buildRow({ title: 'Beta', status: 'done' }, { type: 'relates_to' }),
		]

		render(<RelatedObjectsTable {...baseProps} rows={rows} />)

		expect(screen.getByText('Alpha')).toBeInTheDocument()
		expect(screen.getByText('Beta')).toBeInTheDocument()
		expect(screen.getByText('blocks')).toBeInTheDocument()
		expect(screen.getByText('relates to')).toBeInTheDocument()
	})

	it('renders "Untitled" for objects without a title', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow({ title: null })]} />)

		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('renders owner name from the actors lookup', () => {
		const actor = buildActorListItem({ id: 'actor-99', name: 'Ada Lovelace' })
		const row = buildRow({ owner: actor.id })

		render(<RelatedObjectsTable {...baseProps} actors={[actor]} rows={[row]} />)

		expect(screen.getByText('Ada Lovelace')).toBeInTheDocument()
	})

	it('renders a dash when the object has no owner', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow({ owner: null })]} />)

		// At least one em-dash in the owner column
		expect(screen.getAllByText('—').length).toBeGreaterThan(0)
	})

	it('calls onDeleteRelationship with the relationship id when the X button is clicked', async () => {
		const user = userEvent.setup()
		const onDelete = vi.fn()
		const row = buildRow({}, { id: 'rel-42' })

		render(<RelatedObjectsTable {...baseProps} rows={[row]} onDeleteRelationship={onDelete} />)

		await user.click(screen.getByTitle('Remove link'))
		expect(onDelete).toHaveBeenCalledWith('rel-42')
	})

	it('calls onNavigate when a row is clicked', async () => {
		const user = userEvent.setup()
		const onNavigate = vi.fn()
		const row = buildRow({ id: 'obj-target', title: 'Target' })

		render(<RelatedObjectsTable {...baseProps} rows={[row]} onNavigate={onNavigate} />)

		// Click the relationship badge cell — anywhere on the row outside the title link
		await user.click(screen.getByText(row.rel.type.replace(/_/g, ' ')))
		expect(onNavigate).toHaveBeenCalledWith('ws-1', 'obj-target')
	})

	it('sorts rows by title when the Title header is clicked', async () => {
		const user = userEvent.setup()
		const rows = [
			buildRow({ title: 'Charlie' }),
			buildRow({ title: 'Alpha' }),
			buildRow({ title: 'Bravo' }),
		]

		render(<RelatedObjectsTable {...baseProps} rows={rows} />)

		await user.click(screen.getByRole('button', { name: /title/i }))

		const bodyRows = screen.getAllByRole('row').slice(1) // skip header
		expect(within(bodyRows[0]).getByText('Alpha')).toBeInTheDocument()
		expect(within(bodyRows[1]).getByText('Bravo')).toBeInTheDocument()
		expect(within(bodyRows[2]).getByText('Charlie')).toBeInTheDocument()
	})
})
