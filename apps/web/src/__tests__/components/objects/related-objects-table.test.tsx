import { RelatedObjectsTable } from '@/components/objects/related-objects-table'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { buildObjectResponse, buildRelationshipResponse } from '../../factories'

vi.mock('@tanstack/react-router', async () => {
	const { mockTanStackRouter } = await import('../../mocks/router')
	return mockTanStackRouter()
})

vi.mock('@/components/shared/agent-working-badge', () => ({
	AgentWorkingBadge: () => <span>working</span>,
}))

const isMobileMock = vi.fn(() => false)
vi.mock('@/hooks/use-mobile', () => ({
	useIsMobile: () => isMobileMock(),
}))

beforeEach(() => {
	isMobileMock.mockReturnValue(false)
})

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
	onDeleteRelationship: vi.fn(),
}

describe('RelatedObjectsTable', () => {
	it('renders a table header with the expected columns', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow()]} />)

		expect(screen.getByRole('columnheader', { name: /title/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /relationship/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /status/i })).toBeInTheDocument()
		expect(screen.getByRole('columnheader', { name: /^type$/i })).toBeInTheDocument()
	})

	it('does not render Owner or Updated columns', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow()]} />)

		expect(screen.queryByRole('columnheader', { name: /owner/i })).not.toBeInTheDocument()
		expect(screen.queryByRole('columnheader', { name: /updated/i })).not.toBeInTheDocument()
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

	it('lets the Title column expand to fill remaining width', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow({ title: 'Long linked title' })]} />)

		const titleHeader = screen.getByRole('columnheader', { name: /title/i })
		expect(titleHeader.className).toMatch(/\bw-full\b/)

		const titleCell = screen.getByText('Long linked title').closest('td')
		expect(titleCell?.className).toMatch(/\bmax-w-0\b/)

		const statusHeader = screen.getByRole('columnheader', { name: /status/i })
		expect(statusHeader.className).not.toMatch(/\bw-full\b/)
	})

	it('does not cap the title Link with a max-width literal', () => {
		render(<RelatedObjectsTable {...baseProps} rows={[buildRow({ title: 'Growable' })]} />)

		const link = screen.getByText('Growable')
		expect(link.className).not.toMatch(/max-w-\[/)
		expect(link.className).toMatch(/\btruncate\b/)
		expect(link.className).toMatch(/\bmin-w-0\b/)
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

	describe('on mobile (<768px)', () => {
		beforeEach(() => {
			isMobileMock.mockReturnValue(true)
		})

		it('renders a list of cards instead of a table', () => {
			const rows = [
				buildRow({ title: 'Alpha', status: 'active' }, { type: 'blocks' }),
				buildRow({ title: 'Beta', status: 'done' }, { type: 'relates_to' }),
			]

			render(<RelatedObjectsTable {...baseProps} rows={rows} />)

			expect(screen.queryByRole('table')).not.toBeInTheDocument()
			const list = screen.getByRole('list', { name: /related objects/i })
			expect(within(list).getAllByRole('listitem')).toHaveLength(2)
			expect(screen.getByText('Alpha')).toBeInTheDocument()
			expect(screen.getByText('Beta')).toBeInTheDocument()
			expect(screen.getByText('blocks')).toBeInTheDocument()
			expect(screen.getByText('relates to')).toBeInTheDocument()
		})

		it('keeps the Remove link button visible without hover', () => {
			render(<RelatedObjectsTable {...baseProps} rows={[buildRow()]} />)

			const removeButton = screen.getByRole('button', { name: /remove link/i })
			expect(removeButton.className).not.toMatch(/opacity-0/)
			expect(removeButton.className).not.toMatch(/group-hover/)
		})

		it('calls onNavigate when a card is tapped', async () => {
			const user = userEvent.setup()
			const onNavigate = vi.fn()
			const row = buildRow({ id: 'obj-target', title: 'Target' }, { type: 'relates_to' })

			render(<RelatedObjectsTable {...baseProps} rows={[row]} onNavigate={onNavigate} />)

			await user.click(screen.getByText('relates to'))
			expect(onNavigate).toHaveBeenCalledWith('ws-1', 'obj-target')
		})

		it('calls onDeleteRelationship when the Remove link button is tapped', async () => {
			const user = userEvent.setup()
			const onDelete = vi.fn()
			const row = buildRow({}, { id: 'rel-99' })

			render(<RelatedObjectsTable {...baseProps} rows={[row]} onDeleteRelationship={onDelete} />)

			await user.click(screen.getByRole('button', { name: /remove link/i }))
			expect(onDelete).toHaveBeenCalledWith('rel-99')
		})
	})
})
