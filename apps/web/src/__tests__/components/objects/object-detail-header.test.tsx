import { ObjectDetailHeader } from '@/components/objects/object-detail-header'
import type { MemberResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent, { PointerEventsCheckLevel } from '@testing-library/user-event'
import { buildObjectResponse } from '../../factories'

const members: MemberResponse[] = [
	{ actorId: 'a-1', role: 'owner', joinedAt: null, name: 'Alice', type: 'human' },
	{ actorId: 'a-2', role: 'member', joinedAt: null, name: 'Bob', type: 'agent' },
]

function renderHeader(overrides = {}) {
	const props = {
		object: buildObjectResponse(),
		statuses: ['active', 'archived'],
		members,
		onStatusChange: vi.fn(),
		onDriverChange: vi.fn(),
		...overrides,
	}
	render(<ObjectDetailHeader {...props} />)
	return props
}

describe('ObjectDetailHeader', () => {
	it('renders the type tag and the static title as an h1', () => {
		renderHeader({ object: buildObjectResponse({ type: 'bet', title: 'Ship object detail' }) })
		expect(
			screen.getByRole('heading', { level: 1, name: 'Ship object detail' }),
		).toBeInTheDocument()
		expect(screen.getByText('bet')).toBeInTheDocument()
	})

	it('falls back to Untitled when the title is missing', () => {
		renderHeader({ object: buildObjectResponse({ title: null }) })
		expect(screen.getByRole('heading', { level: 1, name: 'Untitled' })).toBeInTheDocument()
	})

	it('fires onStatusChange when a status is picked from the dropdown', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const props = renderHeader()

		const triggers = screen.getAllByRole('combobox')
		// StatusSelect is the first combobox (mounted before OwnerSelect).
		await user.click(triggers[0])
		await user.click(screen.getByRole('option', { name: 'archived' }))

		expect(props.onStatusChange).toHaveBeenCalledWith('archived')
	})

	it('fires onDriverChange with the member id when a driver is picked', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const props = renderHeader()

		const triggers = screen.getAllByRole('combobox')
		await user.click(triggers[triggers.length - 1])
		await user.click(screen.getByRole('option', { name: /alice/i }))

		expect(props.onDriverChange).toHaveBeenCalledWith('a-1')
	})

	it('fires onDriverChange with null when the driver is unassigned', async () => {
		const user = userEvent.setup({ pointerEventsCheck: PointerEventsCheckLevel.Never })
		const props = renderHeader({
			object: buildObjectResponse({ driver: 'a-1' }),
		})

		const triggers = screen.getAllByRole('combobox')
		await user.click(triggers[triggers.length - 1])
		await user.click(screen.getByRole('option', { name: /^unassigned$/i }))

		expect(props.onDriverChange).toHaveBeenCalledWith(null)
	})
})
