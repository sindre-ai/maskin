import { ConversationTranscript } from '@/components/sindre/conversation-transcript'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ChatMessage } from '@/lib/chat-store'
import { render, screen } from '@testing-library/react'
import type { ReactElement } from 'react'
import { describe, expect, it, vi } from 'vitest'

function renderInProvider(ui: ReactElement) {
	return render(<TooltipProvider>{ui}</TooltipProvider>)
}

vi.mock('@/hooks/use-reactions', () => ({
	useReactionsByObject: () => ({ data: { reactionsByEventId: {} } }),
	useToggleReaction: () => ({ mutate: vi.fn() }),
}))

vi.mock('@/lib/auth', () => ({
	getStoredActor: () => ({ id: 'user-1', name: 'Alice', type: 'human' }),
}))

function userMessage(overrides: Partial<Extract<ChatMessage, { role: 'user' }>>): ChatMessage {
	return {
		id: 'm1',
		role: 'user',
		senderId: 'user-1',
		senderName: 'Alice',
		text: 'hello',
		createdAt: Date.now(),
		...overrides,
	}
}

function agentMessage(): ChatMessage {
	return {
		id: 'm2',
		role: 'agent',
		senderId: 'agent-1',
		senderName: 'Sindre',
		events: [{ kind: 'text', text: 'hi back' }],
		status: 'complete',
		createdAt: Date.now() + 1000,
	}
}

describe('ConversationTranscript reactions wiring', () => {
	const baseProps = {
		currentUserId: 'user-1',
		onRegenerate: vi.fn(),
		onEditUserMessage: vi.fn(),
		workspaceId: 'ws-1',
		conversationId: 'conv-1',
	}

	it('mounts ReactionsBar on a persisted user message (has remoteId)', () => {
		renderInProvider(
			<ConversationTranscript {...baseProps} messages={[userMessage({ remoteId: 42 })]} />,
		)
		// The picker trigger from ReactionsBar exposes this aria-label.
		expect(screen.getByRole('button', { name: 'Add reaction' })).toBeInTheDocument()
	})

	it('omits ReactionsBar on a local-only user message (no remoteId yet)', () => {
		renderInProvider(<ConversationTranscript {...baseProps} messages={[userMessage({})]} />)
		expect(screen.queryByRole('button', { name: 'Add reaction' })).not.toBeInTheDocument()
	})

	it('omits ReactionsBar on agent messages (no persisted events.id)', () => {
		renderInProvider(<ConversationTranscript {...baseProps} messages={[agentMessage()]} />)
		expect(screen.queryByRole('button', { name: 'Add reaction' })).not.toBeInTheDocument()
	})

	it('omits ReactionsBar when conversationId is unset', () => {
		renderInProvider(
			<ConversationTranscript
				{...baseProps}
				conversationId={null}
				messages={[userMessage({ remoteId: 42 })]}
			/>,
		)
		expect(screen.queryByRole('button', { name: 'Add reaction' })).not.toBeInTheDocument()
	})
})
