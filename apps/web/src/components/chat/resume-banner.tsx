import { RelativeTime } from '@/components/shared/relative-time'
import type { MessageResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { RotateCcw } from 'lucide-react'
import { useRef } from 'react'

/** How stale the last thing you read has to be before this counts as "picking
 *  back up" rather than just "there are unread messages". */
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

const MAX_LINES = 3

interface ResumeBannerProps {
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
export function ResumeBanner({ messages, lastReadMessageId }: ResumeBannerProps) {
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
	const latchedRef = useRef<number | null>(null)
	if (latchedRef.current === null && messages.length > 0 && lastReadMessageId !== null) {
		latchedRef.current = lastReadMessageId
	}
	const cursor = latchedRef.current

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
		<div className="rounded-xl border border-brand-subtle bg-brand-subtle px-4 py-3">
			<div className="flex items-center gap-2">
				<span className="grid h-[17px] w-[17px] shrink-0 place-items-center rounded bg-brand-subtle-foreground text-primary-foreground">
					<RotateCcw size={9} aria-hidden />
				</span>
				<span className="eyebrow text-brand-subtle-foreground">Picking up where you left off</span>
				<span className="ml-auto flex shrink-0 items-center gap-1 text-[10.5px] text-brand-subtle-foreground">
					last spoke
					<RelativeTime date={lastRead.createdAt} />
				</span>
			</div>
			<ul className="mt-2 flex flex-col gap-1.5">
				{lines.map((m) => (
					<li key={m.id} className="flex gap-2 text-xs leading-normal text-foreground">
						<span aria-hidden className="shrink-0 text-brand-subtle-foreground">
							→
						</span>
						<span className="min-w-0">
							{m.actorName}: {firstLine(m.content) || 'shared an attachment'}
						</span>
					</li>
				))}
				{overflow > 0 ? (
					<li className="pl-5 text-xs text-muted-foreground">
						+{overflow} more {overflow === 1 ? 'message' : 'messages'}
					</li>
				) : null}
			</ul>
		</div>
	)
}
