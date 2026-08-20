import { MessageBubble } from '@/components/chat/message-bubble'
import type { MessageResponse } from '@/lib/api'
import { render, screen } from '@testing-library/react'
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
