import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import type { MessageTurnActivity } from '@/hooks/use-conversation-activity'
import { useConversationActivity } from '@/hooks/use-conversation-activity'
import type { MessageResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useEffect, useMemo, useRef, useState } from 'react'
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
	const messages = flattenMessagesOldestFirst(data)
	// Reuses the same query the route already fetches for the header/composer
	// (queryKeys.conversations.detail) — no extra network round trip.
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const participantNames = useMemo(() => {
		const map = new Map<string, string>()
		for (const p of conversation?.participants ?? []) map.set(p.actorId, p.actorName)
		return map
	}, [conversation])
	const { byReplyMessageId, byTriggerMessageId, fallback, loadOlderActivity, olderActivity } =
		useConversationActivity(workspaceId, conversationId, messages)

	// The first turn rendered anywhere in the thread. It is the only one that
	// can have activity before it, so it carries the single "load earlier
	// activity" control (see MessageActivity's onLoadOlder doc). Compared by
	// object identity — turn objects are stable within a render, and that
	// avoids inventing a composite key that has to stay in sync with the
	// render order below.
	const oldestTurn = useMemo(() => {
		for (const message of messages) {
			const first = [
				...(byReplyMessageId.get(message.id) ?? []),
				...(byTriggerMessageId.get(message.id) ?? []),
			][0]
			if (first) return first
		}
		return fallback[0] ?? null
	}, [messages, byReplyMessageId, byTriggerMessageId, fallback])

	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const bottomAnchorRef = useRef<HTMLDivElement | null>(null)
	const lastGrowthKeyRef = useRef(0)
	const [isNearBottom, setIsNearBottom] = useState(true)

	// An optimistic final-output bubble is not a `messages` entry, so counting
	// messages alone would leave the agent's answer to appear silently below
	// the fold — at exactly the moment the user is waiting for it. Count both.
	const pendingFinalCount = countPendingFinalOutputs(byReplyMessageId, byTriggerMessageId, fallback)
	const growthKey = messages.length + pendingFinalCount

	// Auto-scroll to the newest content on first load and whenever the thread
	// grows while the user is already near the bottom (own sends, SSE-delivered
	// replies, an agent's turn closing). Doesn't yank the view when the user
	// has scrolled up to read history.
	useEffect(() => {
		if (growthKey === lastGrowthKeyRef.current) return
		const grew = growthKey > lastGrowthKeyRef.current
		lastGrowthKeyRef.current = growthKey
		if (!grew) return
		if (!isNearBottom) return
		bottomAnchorRef.current?.scrollIntoView({ block: 'end' })
	}, [growthKey, isNearBottom])

	const handleScroll = () => {
		const el = scrollerRef.current
		if (!el) return
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
		setIsNearBottom(distanceFromBottom < 120)
	}

	const olderActivityProps = (turn: MessageTurnActivity) =>
		turn === oldestTurn && olderActivity.available
			? {
					onLoadOlder: loadOlderActivity,
					isLoadingOlder: olderActivity.isLoading,
					olderExhausted: olderActivity.exhausted,
				}
			: {}

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
	if (isError) {
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
			className={cn('flex flex-1 flex-col gap-4 overflow-y-auto px-3 pt-4 pb-2', className)}
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
							{turnsAbove.map((turn, turnIndex) => (
								<MessageActivity
									key={`${turn.sessionId}-above-${turnIndex}`}
									workspaceId={workspaceId}
									turn={turn}
									{...olderActivityProps(turn)}
								/>
							))}
							<MessageBubble
								workspaceId={workspaceId}
								message={message}
								participantNames={participantNames}
							/>
							{turnsBelowHere.map((turn, turnIndex) => (
								<MessageActivity
									key={`${turn.sessionId}-below-${turnIndex}`}
									workspaceId={workspaceId}
									turn={turn}
									{...olderActivityProps(turn)}
								/>
							))}
							{/*
							 * Pending final outputs always render below the message,
							 * including those from `turnsAbove` — their dropdown sits
							 * above the reply that produced it, but the end-of-turn
							 * text comes after that reply chronologically.
							 */}
							{[...turnsAbove, ...turnsBelowHere].map((turn) =>
								turn.pendingFinalOutput ? (
									<MessageBubble
										key={turn.pendingFinalOutput.key}
										workspaceId={workspaceId}
										message={syntheticFinalOutputMessage(turn, conversationId, participantNames)}
										participantNames={participantNames}
										pending
										unconfirmed={turn.pendingFinalOutput.unconfirmed}
										isError={turn.pendingFinalOutput.isError}
									/>
								) : null,
							)}
						</div>
					)
				})}
			</div>
			<div ref={bottomAnchorRef} />
		</div>
	)
}

function countPendingFinalOutputs(
	byReplyMessageId: Map<number, MessageTurnActivity[]>,
	byTriggerMessageId: Map<number, MessageTurnActivity[]>,
	fallback: MessageTurnActivity[],
): number {
	let count = 0
	for (const turns of [...byReplyMessageId.values(), ...byTriggerMessageId.values(), fallback]) {
		for (const turn of turns) if (turn.pendingFinalOutput) count++
	}
	return count
}

/**
 * Shapes a pending final output as a MessageResponse so it can render through
 * MessageBubble unchanged — the point is that it looks exactly like the real
 * message it is about to become, so the swap is invisible.
 *
 * `id` is a placeholder: this is never inserted into the messages array and
 * never used as a React key (the caller keys off the log-derived
 * `pendingFinalOutput.key`), so it cannot collide with a real id or with
 * useSendMessage's negative optimistic ids.
 */
export function syntheticFinalOutputMessage(
	turn: MessageTurnActivity,
	conversationId: string,
	participantNames?: Map<string, string>,
): MessageResponse {
	return {
		id: -1,
		conversationId,
		actorId: turn.actorId,
		actorName: participantNames?.get(turn.actorId) ?? 'Agent',
		actorType: 'agent',
		kind: 'message',
		content: turn.pendingFinalOutput?.text ?? '',
		metadata: { source: 'final_output' },
		sessionId: turn.sessionId,
		createdAt: null,
		editedAt: null,
	}
}
