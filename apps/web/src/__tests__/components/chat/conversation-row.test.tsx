import { ConversationRow } from '@/components/chat/conversation-row'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

const dmParticipant = [{ name: 'Sindre', type: 'agent' }]
const roomParticipants = [
	{ name: 'Strategist', type: 'agent' },
	{ name: 'Magnus', type: 'human' },
	{ name: 'Designer', type: 'agent' },
]

describe('ConversationRow', () => {
	it('renders title and preview', () => {
		render(
			<ConversationRow
				type="dm"
				title="Q3 bet restructuring"
				preview="Let's break the For You page bet"
				timestamp={null}
				unread={false}
				participants={dmParticipant}
			/>,
		)
		expect(screen.getByText('Q3 bet restructuring')).toBeInTheDocument()
		expect(screen.getByText("Let's break the For You page bet")).toBeInTheDocument()
	})

	it('shows unread dot when unread is true', () => {
		render(
			<ConversationRow
				type="dm"
				title="Test"
				preview={null}
				timestamp={null}
				unread={true}
				participants={dmParticipant}
			/>,
		)
		expect(screen.getByLabelText('Unread')).toBeInTheDocument()
	})

	it('hides unread dot when unread is false', () => {
		render(
			<ConversationRow
				type="dm"
				title="Test"
				preview={null}
				timestamp={null}
				unread={false}
				participants={dmParticipant}
			/>,
		)
		expect(screen.queryByLabelText('Unread')).not.toBeInTheDocument()
	})

	it('renders dm variant with single agent avatar', () => {
		render(
			<ConversationRow
				type="dm"
				title="DM conversation"
				preview={null}
				timestamp={null}
				unread={false}
				participants={dmParticipant}
			/>,
		)
		expect(screen.getByTitle('Sindre')).toBeInTheDocument()
	})

	it('renders room variant with facepile avatars', () => {
		render(
			<ConversationRow
				type="room"
				title="Engineering room"
				preview={null}
				timestamp={null}
				unread={false}
				participants={roomParticipants}
			/>,
		)
		expect(screen.getByTitle('Strategist')).toBeInTheDocument()
		expect(screen.getByTitle('Magnus')).toBeInTheDocument()
		expect(screen.getByTitle('Designer')).toBeInTheDocument()
	})

	it('caps facepile at 3 avatars even when more participants provided', () => {
		const manyParticipants = [
			...roomParticipants,
			{ name: 'Extra1', type: 'agent' },
			{ name: 'Extra2', type: 'human' },
		]
		render(
			<ConversationRow
				type="room"
				title="Big room"
				preview={null}
				timestamp={null}
				unread={false}
				participants={manyParticipants}
			/>,
		)
		expect(screen.getByTitle('Strategist')).toBeInTheDocument()
		expect(screen.getByTitle('Magnus')).toBeInTheDocument()
		expect(screen.getByTitle('Designer')).toBeInTheDocument()
		expect(screen.queryByTitle('Extra1')).not.toBeInTheDocument()
	})

	it('falls back to "Untitled" when title is null', () => {
		render(
			<ConversationRow
				type="dm"
				title={null}
				preview={null}
				timestamp={null}
				unread={false}
			/>,
		)
		expect(screen.getByText('Untitled')).toBeInTheDocument()
	})

	it('calls onClick when clicked', async () => {
		const onClick = vi.fn()
		render(
			<ConversationRow
				type="dm"
				title="Test"
				preview={null}
				timestamp={null}
				unread={false}
				participants={dmParticipant}
				onClick={onClick}
			/>,
		)
		await userEvent.click(screen.getByRole('button'))
		expect(onClick).toHaveBeenCalledOnce()
	})

	it('calls onClick on Enter key', async () => {
		const onClick = vi.fn()
		render(
			<ConversationRow
				type="dm"
				title="Test"
				preview={null}
				timestamp={null}
				unread={false}
				participants={dmParticipant}
				onClick={onClick}
			/>,
		)
		screen.getByRole('button').focus()
		await userEvent.keyboard('{Enter}')
		expect(onClick).toHaveBeenCalledOnce()
	})

	it('meets 44px minimum touch target', () => {
		render(
			<ConversationRow
				type="dm"
				title="Test"
				preview={null}
				timestamp={null}
				unread={false}
				participants={dmParticipant}
			/>,
		)
		const el = screen.getByRole('button')
		expect(el.className).toMatch(/min-h-\[44px\]/)
	})
})
