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
import { useEffect, useRef, useState } from 'react'
import { MessageActivity } from './message-activity'
import { MessageBubble } from './message-bubble'
import { MessageDivider, isNewDay } from './message-divider'
import { ResumeBanner } from './resume-banner'

interface ThreadMessagesProps {
	workspaceId: string
	conversationId: string
	className?: string
}

export function ThreadMessages({ workspaceId, conversationId, className }: ThreadMessagesProps) {
	const { data, isLoading, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useConversationMessages(conversationId, workspaceId)
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const messages = flattenMessagesOldestFirst(data)
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
			className={cn('flex flex-1 flex-col gap-4 overflow-y-auto px-3 pt-4 pb-2', className)}
		>
			<ResumeBanner
				messages={messages}
				lastReadMessageId={conversation?.last_read_message_id ?? null}
			/>
			{hasNextPage ? (
				<div className="flex justify-center">
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
			<div className="flex flex-col gap-4">
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
								<MessageActivity key={turn.sessionId} workspaceId={workspaceId} turn={turn} />
							))}
							<MessageBubble workspaceId={workspaceId} message={message} />
							{turnsBelowHere.map((turn) => (
								<MessageActivity key={turn.sessionId} workspaceId={workspaceId} turn={turn} />
							))}
						</div>
					)
				})}
			</div>
			<div ref={bottomAnchorRef} />
		</div>
	)
}
