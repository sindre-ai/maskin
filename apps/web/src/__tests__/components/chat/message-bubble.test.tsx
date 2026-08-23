import { MessageBubble } from '@/components/chat/message-bubble'
import type { MessageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'
import { TestWrapper } from '../../setup'

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'human-1', name: 'You' }),
}))

function buildMessage(overrides: Partial<MessageResponse> = {}): MessageResponse {
	return {
		id: 1,
		conversationId: 'convo-1',
		actorId: 'human-1',
		actorName: 'You',
		actorType: 'human',
		kind: 'message',
		content: 'hey team',
		metadata: null,
		sessionId: null,
		createdAt: new Date().toISOString(),
		editedAt: null,
		...overrides,
	}
}

describe('MessageBubble mentions', () => {
	it('renders an @mention chip for metadata.mentions, resolved via participantNames', () => {
		const message = buildMessage({ metadata: { mentions: ['agent-1'] } })
		const participantNames = new Map([['agent-1', 'Builder']])
		render(
			<MessageBubble workspaceId="ws-1" message={message} participantNames={participantNames} />,
			{ wrapper: TestWrapper },
		)
		expect(screen.getByText('@Builder')).toBeInTheDocument()
	})

	it('falls back to the raw actor id when the name is not resolvable', () => {
		const message = buildMessage({
			actorId: 'other-1',
			actorName: 'Someone Else',
			metadata: { mentions: ['agent-unknown'] },
		})
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.getByText('@agent-unknown')).toBeInTheDocument()
	})

	it('renders no context row when there are no mentions, objects, or notifications', () => {
		const message = buildMessage()
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.queryByLabelText('Attached context')).not.toBeInTheDocument()
	})
})

describe('MessageBubble context objects/notifications', () => {
	it('renders one chip per selected object and notification, in order', () => {
		const message = buildMessage({
			metadata: {
				context_objects: [
					{ id: 'obj-1', title: 'First bet', type: 'bet' },
					{ id: 'obj-2', title: 'Second bet', type: 'bet' },
				],
				context_notifications: [{ id: 'notif-1', title: 'Heads up' }],
			},
		})
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.getByText('First bet')).toBeInTheDocument()
		expect(screen.getByText('Second bet')).toBeInTheDocument()
		expect(screen.getByText('Heads up')).toBeInTheDocument()
	})
})

describe('MessageBubble pending final output', () => {
	const agentMessage = () =>
		buildMessage({
			actorId: 'agent-1',
			actorName: 'Builder',
			actorType: 'agent',
			content: 'Here is **the answer**.',
			metadata: { source: 'final_output' },
			createdAt: null,
		})

	it('shows a finishing-up status instead of a timestamp while unsaved', () => {
		render(<MessageBubble workspaceId="ws-1" message={agentMessage()} pending />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('Finishing up…')).toBeInTheDocument()
	})

	it('says the output is not saved once the persisted row is overdue', () => {
		render(<MessageBubble workspaceId="ws-1" message={agentMessage()} pending unconfirmed />, {
			wrapper: TestWrapper,
		})
		// The text stays on screen — losing the agent's answer would be worse
		// than showing it unlabelled — but it is not passed off as saved.
		expect(screen.getByText('Not saved yet')).toBeInTheDocument()
		expect(screen.getByText('the answer')).toBeInTheDocument()
	})

	it('renders the pending content as markdown, not escaped text', () => {
		render(<MessageBubble workspaceId="ws-1" message={agentMessage()} pending />, {
			wrapper: TestWrapper,
		})
		expect(screen.getByText('the answer').tagName).toBe('STRONG')
	})

	it('renders a normal timestamp when not pending', () => {
		const message = { ...agentMessage(), createdAt: new Date().toISOString() }
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.queryByText('Finishing up…')).not.toBeInTheDocument()
	})
})

describe('MessageBubble edit and retry', () => {
	it('shows edit and retry actions on own persisted messages', () => {
		render(<MessageBubble workspaceId="ws-1" message={buildMessage()} />, { wrapper: TestWrapper })
		expect(screen.getByLabelText('Edit message')).toBeInTheDocument()
		expect(screen.getByLabelText('Ask agents to respond again')).toBeInTheDocument()
	})

	it("hides the actions on other participants' messages", () => {
		const message = buildMessage({ actorId: 'other-1', actorName: 'Someone Else' })
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.queryByLabelText('Edit message')).not.toBeInTheDocument()
		expect(screen.queryByLabelText('Ask agents to respond again')).not.toBeInTheDocument()
	})

	it('opens an inline editor prefilled with the current content when edit is clicked', async () => {
		const user = userEvent.setup()
		render(<MessageBubble workspaceId="ws-1" message={buildMessage()} />, { wrapper: TestWrapper })
		await user.click(screen.getByLabelText('Edit message'))
		const editor = screen.getByLabelText('Edit message', { selector: 'textarea' })
		expect(editor).toHaveValue('hey team')
		expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument()
		expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument()
	})

	it('marks edited messages with an (edited) label', () => {
		const message = buildMessage({ editedAt: new Date().toISOString() })
		render(<MessageBubble workspaceId="ws-1" message={message} />, { wrapper: TestWrapper })
		expect(screen.getByText('(edited)')).toBeInTheDocument()
	})
})
