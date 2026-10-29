import { MessageThreadPill } from '@/components/chat/replies/message-thread-pill'
import type { ReplyThreadSummary } from '@/lib/api'
import { fireEvent, render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

function summary(overrides: Partial<ReplyThreadSummary> = {}): ReplyThreadSummary {
	return {
		replyCount: 3,
		lastReplyId: 9,
		lastReplyAt: null,
		unreadCount: 0,
		participants: [
			{ actorId: 'a1', actorName: 'Forge', actorType: 'agent' },
			{ actorId: 'h1', actorName: 'Ada', actorType: 'human' },
		],
		...overrides,
	}
}

describe('MessageThreadPill', () => {
	it('reads the reply count and opens the thread on click', () => {
		const onOpen = vi.fn()
		render(<MessageThreadPill summary={summary()} onOpen={onOpen} />)
		const pill = screen.getByRole('button', { name: '3 replies. Open thread' })
		expect(pill).toHaveTextContent('3 replies')
		fireEvent.click(pill)
		expect(onOpen).toHaveBeenCalledTimes(1)
	})

	it('shows the unread variant with the new-reply count', () => {
		render(<MessageThreadPill summary={summary({ unreadCount: 2 })} onOpen={vi.fn()} />)
		const pill = screen.getByRole('button', { name: '2 new replies. Open thread' })
		expect(pill.className).toContain('text-brand')
		expect(pill.className).not.toContain('text-muted-foreground')
	})

	it('keeps a read thread muted', () => {
		render(<MessageThreadPill summary={summary()} onOpen={vi.fn()} />)
		expect(screen.getByRole('button', { name: /Open thread/ }).className).toContain(
			'text-muted-foreground',
		)
	})
})
