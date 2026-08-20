import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import { cn } from '@/lib/cn'
import { useEffect, useMemo, useRef, useState } from 'react'
import { MessageActivity } from './message-activity'
import { MessageBubble } from './message-bubble'
import { MessageDivider, isNewDay } from './message-divider'

interface ThreadMessagesProps {
	workspaceId: string
	conversationId: string
	className?: string
}

export function ThreadMessages({ workspaceId, conversationId, className }: ThreadMessagesProps) {
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useConversationMessages(conversationId, workspaceId)
	const messages = flattenMessagesOldestFirst(data)
	// Reuses the same query the route already fetches for the header/composer
	// (queryKeys.conversations.detail) — no extra network round trip.
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const participantNames = useMemo(() => {
		const map = new Map<string, string>()
		for (const p of conversation?.participants ?? []) map.set(p.actorId, p.actorName)
		return map
	}, [conversation])
	const { byReplyMessageId, byTriggerMessageId, fallback } = useConversationActivity(
		workspaceId,
		conversationId,
		messages,
	)

	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const bottomAnchorRef = useRef<HTMLDivElement | null>(null)
	const lastMessageCountRef = useRef(0)
	const [isNearBottom, setIsNearBottom] = useState(true)

	// Auto-scroll to the newest message on first load and whenever a new
	// message arrives while the user is already near the bottom (own sends,
	// SSE-delivered replies). Doesn't yank the view when the user has
	// scrolled up to read history.
	useEffect(() => {
		if (messages.length === lastMessageCountRef.current) return
		const grew = messages.length > lastMessageCountRef.current
		lastMessageCountRef.current = messages.length
		if (!grew) return
		if (!isNearBottom) return
		bottomAnchorRef.current?.scrollIntoView({ block: 'end' })
	}, [messages.length, isNearBottom])

	const handleScroll = () => {
		const el = scrollerRef.current
		if (!el) return
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
		setIsNearBottom(distanceFromBottom < 120)
	}

	if (isLoading) {
		return (
			<div className={cn('flex flex-1 items-center justify-center', className)}>
				<Spinner />
			</div>
		)
	}

	if (messages.length === 0) {
		return (
			<div className={cn('flex flex-1 flex-col', className)}>
				<EmptyState
					className="flex-1"
					title="No messages yet"
					description="Send the first message to get the conversation started."
				/>
			</div>
		)
	}

	return (
		<div
			ref={scrollerRef}
			onScroll={handleScroll}
			data-testid="thread-messages"
			className={cn('flex flex-1 flex-col overflow-y-auto p-3', className)}
		>
			{hasNextPage ? (
				<div className="flex justify-center pb-3">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => fetchNextPage()}
						disabled={isFetchingNextPage}
					>
						{isFetchingNextPage ? <Spinner /> : 'Load older messages'}
					</Button>
				</div>
			) : null}
			<div className="flex flex-col gap-3">
				{messages.map((message, index) => {
					const prev = messages[index - 1]
					const isLast = index === messages.length - 1
					// Turns this message's own reply resulted from render above
					// it; turns this message triggered (still in progress, no
					// reply yet) render below it, in the gap before that reply
					// lands — see useConversationActivity's doc comment.
					const turnsAbove = byReplyMessageId.get(message.id) ?? []
					const turnsBelow = byTriggerMessageId.get(message.id) ?? []
					const turnsBelowHere = isLast ? [...turnsBelow, ...fallback] : turnsBelow
					return (
						<div key={message.id} className="flex flex-col gap-1">
							{isNewDay(message.createdAt, prev?.createdAt ?? null) ? (
								<MessageDivider date={message.createdAt} />
							) : null}
							{turnsAbove.map((turn) => (
								<MessageActivity key={turn.sessionId} turn={turn} />
							))}
							<MessageBubble
								workspaceId={workspaceId}
								message={message}
								participantNames={participantNames}
							/>
							{turnsBelowHere.map((turn) => (
								<MessageActivity key={turn.sessionId} turn={turn} />
							))}
						</div>
					)
				})}
			</div>
			<div ref={bottomAnchorRef} />
		</div>
	)
}
