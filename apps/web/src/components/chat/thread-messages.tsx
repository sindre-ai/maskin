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

// A thread nobody has touched in this long reads as history rather than as a
// live conversation — the mockup's `chatIsOld` note (623–625).
const OLD_THREAD_DAYS = 30

export function isOldThread(lastMessageAt: string | null | undefined, now = new Date()): boolean {
	if (!lastMessageAt) return false
	const then = new Date(lastMessageAt).getTime()
	if (Number.isNaN(then)) return false
	return now.getTime() - then > OLD_THREAD_DAYS * 86_400_000
}

interface ThreadMessagesProps {
	workspaceId: string
	conversationId: string
	className?: string
}

export function ThreadMessages({ workspaceId, conversationId, className }: ThreadMessagesProps) {
	const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useConversationMessages(conversationId, workspaceId)
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const messages = flattenMessagesOldestFirst(data)
	const { byReplyMessageId, byTriggerMessageId, fallback } = useConversationActivity(
		workspaceId,
		conversationId,
		messages,
	)

	// Which agent questions already have a human answer, so an answered set of
	// options collapses instead of inviting a second, contradictory pick.
	const answeredQuestionIds = new Set(
		messages
			.map((m) => m.metadata?.question_answer?.question_message_id)
			.filter((id): id is number => typeof id === 'number'),
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

	// A failed fetch must not borrow the empty state: "No messages yet — send the
	// first message" tells a reader with a full thread that it is empty and
	// invites them to start it over. Same reasoning as `conversation-list.tsx`.
	//
	// Only when nothing loaded, though. An infinite query flips to `error` when
	// *any* page rejects while keeping the pages it already has, so a failed
	// "Load older messages" would otherwise replace a thread the reader is
	// mid-way through reading with a whole-surface error.
	if (isError && messages.length === 0) {
		return (
			<div className={cn('flex flex-1 flex-col', className)}>
				<EmptyState
					className="flex-1"
					title="Couldn't load this conversation"
					description="Something went wrong reaching the server. Nothing has been lost — this is only the view."
					action={
						<Button variant="link" size="sm" onClick={() => refetch()}>
							Try again →
						</Button>
					}
				/>
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
			className={cn(
				'flex flex-1 flex-col gap-[18px] overflow-y-auto px-[var(--chat-gut)] pt-[18px] pb-1.5',
				className,
			)}
		>
			{isOldThread(conversation?.lastMessageAt) ? (
				<p className="text-center text-[10.5px] leading-[1.5] text-muted-foreground">
					Retrieved from your history · the reasoning is still on file
				</p>
			) : null}
			<ResumeBanner
				conversationId={conversationId}
				messages={messages}
				lastReadMessageId={conversation?.last_read_message_id ?? null}
			/>
			{hasNextPage ? (
				<div className="flex flex-col items-center gap-1">
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => fetchNextPage()}
						disabled={isFetchingNextPage}
					>
						{isFetchingNextPage ? <Spinner /> : 'Load older messages'}
					</Button>
					{/* The whole-surface error state is reserved for a thread that
					    loaded nothing, so a page that fails partway has to say so
					    here — otherwise the button just stops doing anything. */}
					{isError ? (
						<p className="text-[10.5px] text-muted-foreground">
							Couldn't reach the older messages. Try again.
						</p>
					) : null}
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
							{/* A divider separates two days; there is nothing above the
							    first message to separate it from, so the thread doesn't
							    open with a "Today" rule floating over its own first line. */}
							{index > 0 && isNewDay(message.createdAt, prev?.createdAt ?? null) ? (
								<MessageDivider date={message.createdAt} />
							) : null}
							{/* A finished turn belongs to the reply it produced, so it
							    renders *inside* that message under the agent's name
							    rather than as a separate row above it — which read as
							    a stray line belonging to nothing. Live turns stay
							    standalone below their trigger, where they carry their
							    own avatar. */}
							<MessageBubble
								workspaceId={workspaceId}
								message={message}
								questionAnswered={answeredQuestionIds.has(message.id)}
								// Keyed by index as well as session: one session can put two
								// turns under the same message (a result segment plus the
								// live turn that follows it), so `sessionId` alone is not
								// unique and React would reconcile the two as one row.
								activity={turnsAbove.map((turn, turnIndex) => (
									<MessageActivity
										key={`${turn.sessionId}-above-${turnIndex}`}
										workspaceId={workspaceId}
										turn={turn}
										layout="inline"
									/>
								))}
							/>
							{turnsBelowHere.map((turn, turnIndex) => (
								<MessageActivity
									key={`${turn.sessionId}-below-${turnIndex}`}
									workspaceId={workspaceId}
									turn={turn}
								/>
							))}
						</div>
					)
				})}
			</div>
			<div ref={bottomAnchorRef} />
		</div>
	)
}
