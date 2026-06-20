import { ThreadPanel } from '@/components/sindre/thread-panel'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ChatMessage } from '@/lib/chat-store'
import { EMPTY_SINDRE_SELECTION } from '@/lib/sindre-selection'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { describe, expect, it, vi } from 'vitest'

global.ResizeObserver = vi.fn().mockImplementation(() => ({
	observe: vi.fn(),
	unobserve: vi.fn(),
	disconnect: vi.fn(),
}))

const parentMessage: ChatMessage = {
	id: 'msg-root',
	role: 'user',
	senderId: 'user-1',
	senderName: 'Magnus',
	text: 'Should we ship this on Friday?',
	createdAt: Date.now() - 60_000,
	remoteId: 50,
}

const replyA: ChatMessage = {
	id: 'msg-reply-a',
	role: 'agent',
	senderId: 'agent-1',
	senderName: 'Sindre',
	events: [{ kind: 'text', text: 'Yes — staging is clean.' }],
	status: 'complete',
	createdAt: Date.now() - 30_000,
	remoteId: 51,
	parentRemoteId: 50,
}

const renderPanel = (overrides: Partial<React.ComponentProps<typeof ThreadPanel>> = {}) => {
	const baseProps: React.ComponentProps<typeof ThreadPanel> = {
		workspaceId: 'ws-1',
		parent: parentMessage,
		replies: [replyA],
		currentUserId: 'user-1',
		agents: [{ id: 'agent-1', name: 'Sindre', isDefault: true }],
		draft: '',
		onDraftChange: vi.fn(),
		onSend: vi.fn(),
		onStop: vi.fn(),
		isBusy: false,
		selection: EMPTY_SINDRE_SELECTION,
		onDispatchSelection: vi.fn(),
		onRegenerate: vi.fn(),
		onEditUserMessage: vi.fn(),
		onClose: vi.fn(),
	}
	return render(
		<TooltipProvider>
			<ThreadPanel {...baseProps} {...overrides} />
		</TooltipProvider>,
	)
}

describe('ThreadPanel', () => {
	it('renders the parent message and its reply count', () => {
		renderPanel()
		expect(screen.getByText('Should we ship this on Friday?')).toBeInTheDocument()
		expect(screen.getByText('1 reply')).toBeInTheDocument()
	})

	it('renders each reply in the transcript', () => {
		const replyB: ChatMessage = {
			...replyA,
			id: 'msg-reply-b',
			remoteId: 52,
			senderId: 'user-1',
			senderName: 'Magnus',
			role: 'user',
			text: 'Sounds good.',
		}
		renderPanel({ replies: [replyA, replyB] })
		expect(screen.getByText('2 replies')).toBeInTheDocument()
		expect(screen.getByText('Yes — staging is clean.')).toBeInTheDocument()
		expect(screen.getByText('Sounds good.')).toBeInTheDocument()
	})

	it('says "No replies yet" when the thread is empty', () => {
		renderPanel({ replies: [] })
		expect(screen.getByText('No replies yet')).toBeInTheDocument()
	})

	it('fires onClose when the close button is clicked', async () => {
		const onClose = vi.fn()
		renderPanel({ onClose })
		await userEvent.click(screen.getByLabelText('Close thread'))
		expect(onClose).toHaveBeenCalled()
	})
})
