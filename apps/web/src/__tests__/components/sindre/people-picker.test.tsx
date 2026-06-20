import { PeoplePicker } from '@/components/sindre/people-picker'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { fireEvent, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const SINDRE: ConversationParticipant = {
	id: 'a-sindre',
	name: 'Sindre',
	kind: 'agent',
	role: 'Default chat agent',
	isDefault: true,
}
const STRATEGIST: ConversationParticipant = {
	id: 'a-strategist',
	name: 'Strategist',
	kind: 'agent',
	role: 'Bet shaping',
	isDefault: false,
}
const SEBASTIAN: ConversationParticipant = {
	id: 'u-sebastian',
	name: 'Sebastian',
	kind: 'human',
	role: 'CEO',
	isDefault: false,
}
const MAGNUS: ConversationParticipant = {
	id: 'u-magnus',
	name: 'Magnus',
	kind: 'human',
	role: 'CTO',
	isDefault: false,
}

function renderPicker({
	participants = [SINDRE],
	allActors = [SINDRE, STRATEGIST, SEBASTIAN, MAGNUS],
	onAdd = vi.fn(),
}: {
	participants?: ConversationParticipant[]
	allActors?: ConversationParticipant[]
	onAdd?: (id: string) => void
} = {}) {
	render(
		<PeoplePicker
			trigger={<button type="button">Open picker</button>}
			participants={participants}
			allActors={allActors}
			onAdd={onAdd}
		/>,
	)
	return { onAdd }
}

describe('PeoplePicker', () => {
	it('lists humans + agents and adds a human on click', async () => {
		const user = userEvent.setup()
		const { onAdd } = renderPicker()

		await user.click(screen.getByRole('button', { name: /open picker/i }))

		// All tab is active by default → both sections render.
		const panel = screen.getByRole('tabpanel')
		expect(within(panel).getByRole('button', { name: /add sebastian/i })).toBeInTheDocument()
		expect(within(panel).getByRole('button', { name: /add strategist/i })).toBeInTheDocument()

		await user.click(within(panel).getByRole('button', { name: /add sebastian/i }))
		expect(onAdd).toHaveBeenCalledWith('u-sebastian')
	})

	it('disables already-present participants', async () => {
		const user = userEvent.setup()
		const onAdd = vi.fn()
		renderPicker({ participants: [SINDRE, SEBASTIAN], onAdd })

		await user.click(screen.getByRole('button', { name: /open picker/i }))

		const sebastianRow = screen.getByRole('button', {
			name: /sebastian already in conversation/i,
		})
		expect(sebastianRow).toBeDisabled()

		await user.click(sebastianRow)
		expect(onAdd).not.toHaveBeenCalled()
	})

	it('filters by name and role via the search input', async () => {
		const user = userEvent.setup()
		renderPicker()

		await user.click(screen.getByRole('button', { name: /open picker/i }))

		const search = screen.getByPlaceholderText(/search workspace/i)
		fireEvent.change(search, { target: { value: 'CTO' } })

		expect(screen.queryByRole('button', { name: /add sebastian/i })).not.toBeInTheDocument()
		expect(screen.getByRole('button', { name: /add magnus/i })).toBeInTheDocument()
	})

	it('switches to the People-only tab', async () => {
		const user = userEvent.setup()
		renderPicker()

		await user.click(screen.getByRole('button', { name: /open picker/i }))
		await user.click(screen.getByRole('tab', { name: /^people$/i }))

		const peopleTabPanel = screen.getByRole('tabpanel')
		expect(
			within(peopleTabPanel).getByRole('button', { name: /add sebastian/i }),
		).toBeInTheDocument()
		expect(
			within(peopleTabPanel).queryByRole('button', { name: /add strategist/i }),
		).not.toBeInTheDocument()
	})
})
