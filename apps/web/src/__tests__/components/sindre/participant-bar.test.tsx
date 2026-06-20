import { ParticipantBar } from '@/components/sindre/participant-bar'
import type { ConversationParticipant } from '@/hooks/use-sindre-conversation'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const SINDRE: ConversationParticipant = {
	id: 'a-sindre',
	name: 'Sindre',
	kind: 'agent',
	role: 'Default chat agent',
	isDefault: true,
}

function human(id: string, name: string): ConversationParticipant {
	return { id, name, kind: 'human', role: null, isDefault: false }
}

function renderBar(participants: ConversationParticipant[]) {
	const onAdd = vi.fn()
	const onRemove = vi.fn()
	render(
		<ParticipantBar
			participants={participants}
			allActors={participants}
			workingAgentIds={[]}
			onAdd={onAdd}
			onRemove={onRemove}
		/>,
	)
	return { onAdd, onRemove }
}

describe('ParticipantBar', () => {
	it('renders no +N more chip when participants fit the mobile cap', () => {
		renderBar([SINDRE, human('u-1', 'Alice'), human('u-2', 'Bob')])
		expect(screen.queryByRole('button', { name: /more participant/i })).not.toBeInTheDocument()
	})

	it('marks overflow chips as mobile-hidden and surfaces a +N more trigger', () => {
		const { container } = render(
			<ParticipantBar
				participants={[
					SINDRE,
					human('u-1', 'Alice'),
					human('u-2', 'Bob'),
					human('u-3', 'Carol'),
					human('u-4', 'Dave'),
				]}
				allActors={[]}
				workingAgentIds={[]}
				onAdd={vi.fn()}
				onRemove={vi.fn()}
			/>,
		)

		// Two overflow participants → cap is 3 (Sindre, Alice, Bob visible).
		const more = screen.getByRole('button', { name: /show 2 more participants/i })
		expect(more).toHaveTextContent('+2 more')

		// Overflow chips still render in the DOM so desktop CSS shows them; the
		// `data-overflow` marker proves they collapse on ≤639px via `max-sm:hidden`.
		const overflowChips = container.querySelectorAll('[data-overflow="true"]')
		expect(overflowChips).toHaveLength(2)
		for (const chip of overflowChips) {
			expect(chip).toHaveClass('max-sm:hidden')
		}
	})

	it('lists hidden participants in the overflow popover and forwards remove', async () => {
		const user = userEvent.setup()
		const { onRemove } = renderBar([
			SINDRE,
			human('u-1', 'Alice'),
			human('u-2', 'Bob'),
			human('u-3', 'Carol'),
			human('u-4', 'Dave'),
		])

		await user.click(screen.getByRole('button', { name: /show 2 more participants/i }))

		// Carol and Dave were not visible before the click — the popover surfaces them.
		// Bob (in the visible cap) is not duplicated inside the overflow list.
		const list = await screen.findByRole('list')
		expect(within(list).getByText('Carol')).toBeInTheDocument()
		expect(within(list).getByText('Dave')).toBeInTheDocument()
		expect(within(list).queryByText('Bob')).not.toBeInTheDocument()

		await user.click(within(list).getByRole('button', { name: /remove carol/i }))
		expect(onRemove).toHaveBeenCalledWith('u-3')
	})
})
