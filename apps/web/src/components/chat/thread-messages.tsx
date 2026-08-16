import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { flattenMessagesOldestFirst, useConversationMessages } from '@/hooks/use-conversation'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import { cn } from '@/lib/cn'
import { useEffect, useRef, useState } from 'react'
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
	const { byMessageId, fallback } = useConversationActivity(workspaceId, conversationId)

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
					const turns = byMessageId.get(message.id) ?? []
					const turnsHere = isLast ? [...turns, ...fallback] : turns
					return (
						<div key={message.id} className="flex flex-col gap-1">
							{isNewDay(message.createdAt, prev?.createdAt ?? null) ? (
								<MessageDivider date={message.createdAt} />
							) : null}
							<MessageBubble workspaceId={workspaceId} message={message} />
							{turnsHere.map((turn) => (
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
