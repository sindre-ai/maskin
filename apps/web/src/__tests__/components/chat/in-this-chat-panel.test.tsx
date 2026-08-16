import { buildActorListItem } from '@/__tests__/factories'
import { InThisChatPanel, type Participant } from '@/components/chat/in-this-chat-panel'
import { fireEvent, render, screen } from '@testing-library/react'
import { Toaster } from 'sonner'
import { describe, expect, it, vi } from 'vitest'

function renderPanel(overrides: Partial<React.ComponentProps<typeof InThisChatPanel>> = {}) {
	const onAddParticipant = vi.fn()
	const onRemoveParticipant = vi.fn()
	const props: React.ComponentProps<typeof InThisChatPanel> = {
		trigger: <button type="button">Open panel</button>,
		participants: [],
		availableActors: [],
		onAddParticipant,
		onRemoveParticipant,
		conversationUrl: 'https://example.com/ws/chats/session-1',
		hasChiefOfStaff: false,
		...overrides,
	}
	const utils = render(
		<>
			<InThisChatPanel {...props} />
			<Toaster />
		</>,
	)
	return { onAddParticipant, onRemoveParticipant, ...utils }
}

describe('InThisChatPanel', () => {
	it('renders participants when opened and hides the remove control on locked rows', async () => {
		const participants: Participant[] = [
			{
				id: 'cos',
				name: 'Chief of Staff',
				type: 'agent',
				role: 'chief-of-staff',
				roleLine: 'Routes your ask to the right specialist',
				locked: true,
			},
			{ id: 'me', name: 'Me', type: 'human', isSelf: true },
			{
				id: 'analyst',
				name: 'Product Analyst',
				type: 'agent',
				pulledInLine: 'Pulled in by Chief of Staff',
			},
		]
		renderPanel({ participants, hasChiefOfStaff: true })

		fireEvent.click(screen.getByRole('button', { name: /open panel/i }))
		expect(await screen.findByText('In this chat')).toBeInTheDocument()
		// Locked default row shows the "Default" pill and no remove button.
		expect(screen.getByText('Default')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /remove chief of staff/i })).not.toBeInTheDocument()
		// Specialist row is removable.
		expect(screen.getByRole('button', { name: /remove product analyst/i })).toBeInTheDocument()
		// Explainer swaps to the CoS-explicit copy.
		expect(screen.getByText(/everyone talks to chief of staff first/i)).toBeInTheDocument()
	})

	it('search filters the available-actors list and adds on click', async () => {
		const onAddParticipant = vi.fn()
		renderPanel({
			availableActors: [
				buildActorListItem({ id: 'a-analyst', name: 'Product Analyst', type: 'agent' }),
				buildActorListItem({ id: 'a-marketer', name: 'Marketer', type: 'agent' }),
			],
			onAddParticipant,
		})

		fireEvent.click(screen.getByRole('button', { name: /open panel/i }))
		const input = await screen.findByLabelText('Search people and agents')
		fireEvent.change(input, { target: { value: 'analyst' } })

		const match = await screen.findByRole('button', { name: /product analyst/i })
		expect(match).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /marketer/i })).not.toBeInTheDocument()

		fireEvent.click(match)
		expect(onAddParticipant).toHaveBeenCalledTimes(1)
		expect(onAddParticipant.mock.calls[0]?.[0]).toMatchObject({ name: 'Product Analyst' })
	})

	it('copy-link writes the URL to the clipboard and invite renders a mailto link', async () => {
		const writeText = vi.fn().mockResolvedValue(undefined)
		Object.defineProperty(navigator, 'clipboard', {
			configurable: true,
			value: { writeText },
		})
		renderPanel({ conversationUrl: 'https://example.com/ws/chats/xyz' })

		fireEvent.click(screen.getByRole('button', { name: /open panel/i }))
		fireEvent.click(await screen.findByRole('button', { name: /copy link/i }))
		expect(writeText).toHaveBeenCalledWith('https://example.com/ws/chats/xyz')

		const invite = screen.getByRole('link', { name: /invite someone by email/i })
		expect(invite).toHaveAttribute('href', expect.stringContaining('mailto:'))
		expect(invite.getAttribute('href')).toContain(
			encodeURIComponent('https://example.com/ws/chats/xyz'),
		)
	})
})
