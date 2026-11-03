import { RelativeTime } from '@/components/shared/relative-time'
import type { MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useRef } from 'react'

/** How stale the last thing you read has to be before this counts as "picking
 *  back up" rather than just "there are unread messages". */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

const MAX_LINES = 3

interface ResumeBannerProps {
	conversationId: string
	messages: MessageResponse[]
	lastReadMessageId: number | null
}

function firstLine(content: string): string {
	const line = content.split('\n').find((l) => l.trim().length > 0) ?? ''
	return line.trim().slice(0, 140)
}

/**
 * "Picking up where you left off" (mockup 615–622) — what happened in this
 * thread while you were away. Derived entirely from data the thread already
 * fetched: everything newer than your `last_read_message_id`, shown only when
 * the last thing you *did* read is old enough that you've genuinely been gone.
 */
export function ResumeBanner({ conversationId, messages, lastReadMessageId }: ResumeBannerProps) {
	const self = getStoredActor()
	// Latch the read cursor the first time we actually have one:
	// `$conversationId.tsx` marks the thread read on open, so reading it live
	// would make the banner vanish a beat after it appeared.
	//
	// The cursor and `messages` come from two independent queries
	// (`useConversation` / `useConversationMessages` — see `thread-messages.tsx`),
	// so latching merely on `messages.length > 0` stored `null` whenever the
	// messages resolved first and suppressed the banner for the whole mount.
	// Waiting for a non-null cursor costs nothing: a null cursor means the
	// reader has never read this thread, which is not "picking back up" anyway.
	//
	// The latch is keyed by conversation because `ThreadMessages` is mounted
	// without a `key`, so the router reuses this instance when only the
	// `$conversationId` param changes. Message ids are globally sequential, so a
	// cursor carried over from the previous thread fails deterministically:
	// recent → old suppresses the banner entirely (nothing is `> cursor`), and
	// old → recent resolves `lastRead` to a message from the other conversation.
	// Keying here rather than relying on a `key` at the call site keeps the
	// invariant next to the state that depends on it.
	const latchedRef = useRef<{ conversationId: string; cursor: number } | null>(null)
	if (latchedRef.current?.conversationId !== conversationId) {
		latchedRef.current = null
	}
	if (latchedRef.current === null && messages.length > 0 && lastReadMessageId !== null) {
		latchedRef.current = { conversationId, cursor: lastReadMessageId }
	}
	const cursor = latchedRef.current?.cursor ?? null

	if (cursor === null) return null

	const unread = messages.filter((m) => m.id > cursor && m.actorId !== self?.id)
	if (unread.length === 0) return null

	const lastRead = [...messages].reverse().find((m) => m.id <= cursor)
	if (!lastRead?.createdAt) return null
	const lastReadAt = new Date(lastRead.createdAt).getTime()
	if (Number.isNaN(lastReadAt)) return null
	if (Date.now() - lastReadAt < STALE_AFTER_MS) return null

	const lines = unread.slice(0, MAX_LINES)
	const overflow = unread.length - lines.length

	return (
		<div className="rounded-lg border-l-2 border-brand bg-muted p-3.5">
			<div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1">
				<span className="eyebrow">Picking up where you left off</span>
				<span className="flex items-center gap-1 text-[11px] text-muted-foreground">
					last spoke
					<RelativeTime date={lastRead.createdAt} />
				</span>
			</div>
			<ul className="flex flex-col gap-1 text-xs leading-normal text-muted-foreground">
				{lines.map((m) => (
					<li key={m.id} className="flex gap-2">
						<span aria-hidden className="shrink-0 text-brand-subtle-foreground">
							→
						</span>
						<span className="min-w-0">
							{m.actorName}: {firstLine(m.content) || 'shared an attachment'}
						</span>
					</li>
				))}
				{overflow > 0 ? (
					<li className="pl-5">
						+{overflow} more {overflow === 1 ? 'message' : 'messages'}
					</li>
				) : null}
			</ul>
		</div>
	)
}
