import { ConversationTranscript } from '@/components/sindre/conversation-transcript'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ChatMessage } from '@/lib/chat-store'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import type { ReactNode } from 'react'
import { describe, expect, it, vi } from 'vitest'

Element.prototype.scrollTo = vi.fn()

function Providers({ children }: { children: ReactNode }) {
	return <TooltipProvider>{children}</TooltipProvider>
}

function userMessage(overrides: Partial<Extract<ChatMessage, { role: 'user' }>> = {}) {
	const base: Extract<ChatMessage, { role: 'user' }> = {
		id: 'msg_u',
		role: 'user',
		senderId: 'user-1',
		senderName: 'You',
		text: 'Hello',
		createdAt: Date.now(),
	}
	return { ...base, ...overrides }
}

describe('ConversationTranscript user message status', () => {
	it('renders message normally when no status is set', () => {
		render(
			<Providers>
				<ConversationTranscript
					messages={[userMessage()]}
					currentUserId="user-1"
					onRegenerate={vi.fn()}
					onRetryUserMessage={vi.fn()}
					onEditUserMessage={vi.fn()}
				/>
			</Providers>,
		)
		expect(screen.getByText('Hello')).toBeInTheDocument()
		expect(screen.queryByRole('button', { name: /retry/i })).not.toBeInTheDocument()
		expect(screen.queryByText(/sending/i)).not.toBeInTheDocument()
	})

	it('shows a sending hint while the optimistic write is in flight', () => {
		render(
			<Providers>
				<ConversationTranscript
					messages={[userMessage({ status: 'sending' })]}
					currentUserId="user-1"
					onRegenerate={vi.fn()}
					onRetryUserMessage={vi.fn()}
					onEditUserMessage={vi.fn()}
				/>
			</Providers>,
		)
		expect(screen.getByText(/sending/i)).toBeInTheDocument()
	})

	it('surfaces an error message plus retry button when the persist call failed', async () => {
		const onRetry = vi.fn()
		render(
			<Providers>
				<ConversationTranscript
					messages={[
						userMessage({ id: 'msg_failed', status: 'error', errorText: 'Network error' }),
					]}
					currentUserId="user-1"
					onRegenerate={vi.fn()}
					onRetryUserMessage={onRetry}
					onEditUserMessage={vi.fn()}
				/>
			</Providers>,
		)
		expect(screen.getByText('Network error')).toBeInTheDocument()
		const retry = screen.getByRole('button', { name: /retry/i })
		await userEvent.click(retry)
		expect(onRetry).toHaveBeenCalledWith('msg_failed')
	})

	it('falls back to a generic copy when errorText is absent', () => {
		render(
			<Providers>
				<ConversationTranscript
					messages={[userMessage({ status: 'error' })]}
					currentUserId="user-1"
					onRegenerate={vi.fn()}
					onRetryUserMessage={vi.fn()}
					onEditUserMessage={vi.fn()}
				/>
			</Providers>,
		)
		expect(screen.getByText(/couldn['’]t send/i)).toBeInTheDocument()
	})
})
