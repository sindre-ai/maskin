import { HandoffCard } from '@/components/chat/handoff-card'
import { HelperQuestionCard } from '@/components/chat/helper-question-card'
import { PREVIEW_BOUNDS_ATTR } from '@/components/chat/linked-object-reference'
import { useThreadsPane } from '@/components/chat/threads-context'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useActors } from '@/hooks/use-actors'
import { useBackfilledRunActivity } from '@/hooks/use-backfilled-run-activity'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import {
	type MessageTurnActivity,
	useConversationActivity,
} from '@/hooks/use-conversation-activity'
import { useConversationThreads } from '@/hooks/use-conversation-threads'
import { useActiveSessionsForConversation } from '@/hooks/use-sessions'
import { dropPlainTail, parseIntroView } from '@/lib/agent-intro'
import type { MessageMetadata, MessageResponse, SessionResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	type RedoneTurns,
	dropRedoneFailedTurns,
	redoKey,
	snapshotRedo,
	supersededFailedReplyIds,
} from '@/lib/failed-turns'
import { groupHandoffsByNextMessage } from '@/lib/handed-off-strip'
import { extractLinkedObjectIds } from '@/lib/linked-objects'
import { isTimelineMessage } from '@/lib/message-threads'
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { MessageActivity } from './message-activity'
import { MessageBubble } from './message-bubble'
import { MessageDivider, isNewDay } from './message-divider'
import { NeededTools } from './needed-tools'
import { MessageThreadPill } from './replies/message-thread-pill'
import { ResumeBanner } from './resume-banner'
import { type MessageSpawnInfo, deriveMessageSpawnMap } from './spawn-indicator'
import { SuggestedSteps } from './suggested-steps'
import { VoiceCallBoundary, deriveVoiceCallBoundaries } from './voice-call-boundary'

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
	/** Fills the composer with a fill step's prompt. */
	onPickStep?: (prompt: string) => void
	/** Sends a send step's label as the person's message, with the intro step marker. */
	onSendStep?: (content: string, metadata: MessageMetadata) => void
	/** A step send is in flight. */
	sendingStep?: boolean
	/** Opens the reply thread rooted at this message id. Without it bubbles have no Reply action. */
	onOpenReplies?: (rootId: number) => void
}

export function ThreadMessages({
	workspaceId,
	conversationId,
	className,
	onPickStep,
	onSendStep,
	sendingStep = false,
	onOpenReplies,
}: ThreadMessagesProps) {
	const { data, isLoading, isError, refetch, fetchNextPage, hasNextPage, isFetchingNextPage } =
		useConversationMessages(conversationId, workspaceId)
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const threadsPane = useThreadsPane()
	// `messages` is everything the pages hold, replies included: activity pairing, answered
	// questions and failed-turn logic need the full list. `timeline` is what the main chat draws.
	const messages = flattenMessagesOldestFirst(data)
	const timeline = useMemo(() => messages.filter(isTimelineMessage), [messages])
	// The step row is disabled only once the actor list has loaded and the intro's
	// agent is not in it. While it loads, or when it fails, the row stays usable.
	const actors = useActors(workspaceId)
	const handoffs = useConversationThreads(workspaceId, conversationId)
	// Each handoff is its own row in the timeline, at the moment its session was
	// created: before the first message written after it, or at the foot of the
	// thread when nothing has been written since.
	const showHandoffCards = Boolean(threadsPane)
	const handoffsByNextMessage = useMemo(() => {
		if (!showHandoffCards) return new Map<number | 'end', typeof handoffs>()
		return groupHandoffsByNextMessage(handoffs, timeline)
	}, [handoffs, timeline, showHandoffCards])
	const renderHandoffCards = (items: typeof handoffs | undefined) =>
		items && items.length > 0 && threadsPane ? (
			<div className="ml-[39px] flex max-w-[660px] flex-col gap-2">
				{items.map((session) => (
					<HandoffCard key={session.id} session={session} onViewThread={threadsPane.openThread} />
				))}
			</div>
		) : null
	const { byReplyMessageId, byTriggerMessageId, fallback } = useConversationActivity(
		workspaceId,
		conversationId,
		messages,
	)
	// A turn with no message tag yet hangs under the newest message. A reply that stays in its thread
	// is not drawn here, so that wait is shown by the thread pane instead.
	const newestMessage = messages[messages.length - 1]
	const fallbackIsInThread = !!newestMessage && !isTimelineMessage(newestMessage)
	// Replies copied in from a background run, whose thinking and tool calls live in that run's log.
	const backfilledActivity = useBackfilledRunActivity(workspaceId, messages)
	// Every session `useActiveSessionsForConversation` returns already carries
	// `config.conversation.message_id` — the message that triggered its spawn.
	// Building the map here keeps MessageBubble stateless about sessions and
	// the query cache-shared with useConversationActivity above (same key).
	const { data: sessionList } = useActiveSessionsForConversation(workspaceId, conversationId)
	const spawnByMessageId = useMemo<Map<number, MessageSpawnInfo>>(
		() => deriveMessageSpawnMap((sessionList ?? []) as SessionResponse[]),
		[sessionList],
	)

	// Head/tail dividers for each run of voice-call messages. Derived from the
	// messages themselves (metadata.source === 'voice').
	const voiceBoundaries = useMemo(() => deriveVoiceCallBoundaries(timeline), [timeline])

	// Which agent questions already have a human answer, so an answered set of
	// options collapses instead of inviting a second, contradictory pick.
	const answeredQuestionIds = new Set(
		messages
			.map((m) => m.metadata?.question_answer?.question_message_id)
			.filter((id): id is number => typeof id === 'number'),
	)

	// A helper's question and the person's answer are a conversation with that
	// helper, which lives in its thread. Until it is answered the question stays
	// here with its buttons; once answered, both messages leave the main chat.
	const helperQuestionIds = new Set(
		messages.filter((m) => m.metadata?.question?.reply_to_session).map((m) => m.id),
	)
	// Turns the person redid in this view, with what had already failed at that
	// moment. Those failed notices leave the timeline so the new attempt takes
	// their place; a later failure of the new attempt stays visible.
	const [redoneTurns, setRedoneTurns] = useState<RedoneTurns>(new Map())
	const supersededFailedIds = useMemo(
		() => supersededFailedReplyIds(messages, redoneTurns),
		[messages, redoneTurns],
	)
	const handleRetried = (retried: MessageResponse) => {
		const key = redoKey(retried)
		setRedoneTurns((prev) =>
			new Map(prev).set(key, snapshotRedo(messages, byTriggerMessageId.get(key) ?? [])),
		)
	}
	const visibleMessages = timeline.filter((m) => {
		if (supersededFailedIds.has(m.id)) return false
		// A helper's result handed to the agent that started it: the agent gets it, the
		// person reads it in the helper's thread as its final output.
		if (m.metadata?.helper_return) return false
		// A card button's nudge to the agent: delivered, but not something to read.
		if (m.metadata?.hidden_from_chat) return false
		if (helperQuestionIds.has(m.id)) return !answeredQuestionIds.has(m.id)
		const answered = m.metadata?.question_answer?.question_message_id
		return !(typeof answered === 'number' && helperQuestionIds.has(answered))
	})

	// A turn a hidden nudge started (a card's Done or Save) has no bubble to hang under, so it
	// hangs under the last message the person can see. Without it the wait for the agent's
	// answer would show nothing at all.
	const turnsFromHidden = new Map<number, MessageTurnActivity[]>()
	const visibleIds = new Set(visibleMessages.map((m) => m.id))
	let lastVisibleId: number | null = null
	for (const m of messages) {
		if (visibleIds.has(m.id)) {
			lastVisibleId = m.id
			continue
		}
		const turns = m.metadata?.hidden_from_chat ? byTriggerMessageId.get(m.id) : undefined
		if (turns && lastVisibleId !== null) {
			turnsFromHidden.set(lastVisibleId, [...(turnsFromHidden.get(lastVisibleId) ?? []), ...turns])
		}
	}

	// A linked object's card shows once, on the first message that links it; later
	// messages keep the link but not another copy of the card. Only messages that
	// draw cards count: your own bubble draws none, so a link you posted first must
	// not hide the card from the agent's reply.
	const ownActorId = getStoredActor()?.id
	const shownLinkedObjectIdsByMessage = useMemo(() => {
		const seen = new Set<string>()
		const byMessage = new Map<number, ReadonlySet<string>>()
		for (const m of visibleMessages) {
			byMessage.set(m.id, new Set(seen))
			if (m.kind !== 'message' || m.actorId === ownActorId) continue
			for (const id of extractLinkedObjectIds(m.content)) seen.add(id)
		}
		return byMessage
	}, [visibleMessages, ownActorId])

	const scrollerRef = useRef<HTMLDivElement | null>(null)
	const bottomAnchorRef = useRef<HTMLDivElement | null>(null)
	const topSentinelRef = useRef<HTMLDivElement | null>(null)
	const lastMessageCountRef = useRef(0)
	// Snapshot of scrollHeight/scrollTop taken right before an older-page fetch,
	// used to keep the reader's visual anchor stable when the prepended messages
	// grow the scroller upward. Cleared once applied.
	const scrollAnchorRef = useRef<{ scrollHeight: number; scrollTop: number } | null>(null)
	const pageCount = data?.pages.length ?? 0
	// A ref, not state: it only steers scrolling, and it has to be reset
	// synchronously when the reader opens a different conversation.
	const nearBottomRef = useRef(true)
	const messagesContentRef = useRef<HTMLDivElement | null>(null)
	const hasMessages = timeline.length > 0

	// Opening a conversation always starts at its newest message. This component
	// is reused across conversations, so without a reset the previous thread's
	// message count and scroll position leak into the next one.
	// biome-ignore lint/correctness/useExhaustiveDependencies: conversationId is the trigger — a different thread was opened — and its value is not read inside the effect.
	useLayoutEffect(() => {
		lastMessageCountRef.current = 0
		nearBottomRef.current = true
	}, [conversationId])

	// Auto-scroll to the newest message on first load and whenever a new
	// message arrives while the user is already near the bottom (own sends,
	// SSE-delivered replies). Doesn't yank the view when the user has
	// scrolled up to read history.
	useEffect(() => {
		if (timeline.length === lastMessageCountRef.current) return
		const grew = timeline.length > lastMessageCountRef.current
		lastMessageCountRef.current = timeline.length
		if (!grew) return
		if (!nearBottomRef.current) return
		bottomAnchorRef.current?.scrollIntoView({ block: 'end' })
	}, [timeline.length])

	// Rows keep growing after they mount (markdown, images, activity cards,
	// session chips), which pushes the newest message below the fold of a view
	// that was scrolled to the bottom a moment earlier. Follow that growth for as
	// long as the reader hasn't scrolled away.
	// biome-ignore lint/correctness/useExhaustiveDependencies: hasMessages and conversationId only decide when the scroller element exists / is replaced, so the observer re-attaches to it; neither is read inside.
	useEffect(() => {
		const content = messagesContentRef.current
		if (!content || typeof ResizeObserver === 'undefined') return
		const observer = new ResizeObserver(() => {
			if (nearBottomRef.current) bottomAnchorRef.current?.scrollIntoView({ block: 'end' })
		})
		observer.observe(content)
		return () => observer.disconnect()
	}, [hasMessages, conversationId])

	// Auto-load older messages when the user scrolls to the top of the thread.
	// The button below stays as an accessible fallback for keyboard users and
	// for the case where the observer misses (jsdom, disabled JS, etc.), but
	// the observer is what most readers actually hit — mirrors the pattern
	// every modern chat surface uses.
	useEffect(() => {
		const sentinel = topSentinelRef.current
		const scroller = scrollerRef.current
		if (!sentinel || !scroller) return
		if (!hasNextPage || isFetchingNextPage) return
		const observer = new IntersectionObserver(
			(entries) => {
				if (!entries.some((e) => e.isIntersecting)) return
				scrollAnchorRef.current = {
					scrollHeight: scroller.scrollHeight,
					scrollTop: scroller.scrollTop,
				}
				fetchNextPage()
			},
			{ root: scroller, rootMargin: '200px 0px 0px 0px' },
		)
		observer.observe(sentinel)
		return () => observer.disconnect()
	}, [hasNextPage, isFetchingNextPage, fetchNextPage])

	// After an older page is prepended, restore the reader's visual anchor —
	// otherwise the freshly-added messages push what they were reading down
	// and out of view. Runs on pageCount change so an SSE-delivered new
	// message at the bottom doesn't trip it.
	// biome-ignore lint/correctness/useExhaustiveDependencies: pageCount is the trigger — a new page just landed — and its value is not read inside the effect.
	useEffect(() => {
		const scroller = scrollerRef.current
		const anchor = scrollAnchorRef.current
		if (!scroller || !anchor) return
		const delta = scroller.scrollHeight - anchor.scrollHeight
		scrollAnchorRef.current = null
		if (delta > 0) scroller.scrollTop = anchor.scrollTop + delta
	}, [pageCount])

	const handleScroll = () => {
		const el = scrollerRef.current
		if (!el) return
		const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight
		nearBottomRef.current = distanceFromBottom < 120
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

	// Replies are not in `timeline`, so a loaded page of only replies is not an empty chat:
	// older pages may still hold top-level messages.
	if (timeline.length === 0 && !hasNextPage) {
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
			// The scroller clips a chip's hover preview, so the preview places itself inside it.
			{...{ [PREVIEW_BOUNDS_ATTR]: '' }}
			className={cn(
				// `min-w-0` caps min-content on the cross axis, so a wide descendant
				// (markdown table, long unbroken URL) can't push the flex column past
				// its container and up into the page's `overflow-auto` shell.
				'flex min-w-0 flex-1 flex-col gap-[18px] overflow-y-auto px-[var(--chat-gut)] pt-[18px] pb-1.5',
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
				messages={timeline}
				lastReadMessageId={conversation?.last_read_message_id ?? null}
			/>
			{hasNextPage ? (
				<div className="flex flex-col items-center gap-1">
					{/* Sentinel above the button. When it scrolls into the scroller's
					    viewport (with a 200px rootMargin) the IntersectionObserver
					    fires fetchNextPage — the reader never has to spot the button
					    to load older messages. The button stays as the fallback path
					    for keyboard users and jsdom-shaped test environments. */}
					<div ref={topSentinelRef} data-testid="thread-messages-top-sentinel" aria-hidden />
					<Button
						type="button"
						variant="ghost"
						size="sm"
						onClick={() => {
							const scroller = scrollerRef.current
							if (scroller) {
								scrollAnchorRef.current = {
									scrollHeight: scroller.scrollHeight,
									scrollTop: scroller.scrollTop,
								}
							}
							fetchNextPage()
						}}
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
			<div ref={messagesContentRef} className="flex flex-col gap-4">
				{visibleMessages.map((message, index) => {
					const prev = visibleMessages[index - 1]
					const isLast = index === visibleMessages.length - 1
					// Turns this message's own reply resulted from render above
					// it; turns this message triggered (still in progress, no
					// reply yet) render below it, in the gap before that reply
					// lands — see useConversationActivity's doc comment.
					const turnsAbove =
						byReplyMessageId.get(message.id) ?? backfilledActivity.get(message.id) ?? []
					const turnsBelow = dropRedoneFailedTurns(
						[
							...(byTriggerMessageId.get(message.id) ?? []),
							...(turnsFromHidden.get(message.id) ?? []),
						],
						message.id,
						redoneTurns,
					)
					const turnsBelowHere =
						isLast && !fallbackIsInThread ? [...turnsBelow, ...fallback] : turnsBelow
					// A helper's question is put to the person from outside this chat, so it
					// is drawn as a card rather than as a message from the helper.
					const helperQuestion = message.metadata?.question?.reply_to_session
						? message.metadata.question
						: null
					if (helperQuestion) {
						return (
							<Fragment key={message.id}>
								{renderHandoffCards(handoffsByNextMessage.get(message.id))}
								<HelperQuestionCard
									workspaceId={workspaceId}
									conversationId={conversationId}
									questionMessageId={message.id}
									actorId={message.actorId}
									actorName={message.actorName}
									question={helperQuestion}
									answered={answeredQuestionIds.has(message.id)}
									onViewThread={threadsPane?.openThread}
								/>
							</Fragment>
						)
					}
					// An agent intro written with steps and tools: the buttons and rows replace
					// the plain list and tools sentence at the end of its body.
					const intro = message.actorType === 'agent' ? parseIntroView(message.metadata) : null
					const bubbleMessage = intro
						? { ...message, content: dropPlainTail(message.content, intro.plainTail) }
						: message
					// The steps go once the person has written anything after the intro, an
					// unsent-yet bubble included. The tool rows stay.
					const showSteps =
						intro?.steps != null &&
						onPickStep != null &&
						onSendStep != null &&
						!timeline.slice(timeline.indexOf(message) + 1).some((m) => m.actorType === 'human')
					return (
						<Fragment key={message.id}>
							{renderHandoffCards(handoffsByNextMessage.get(message.id))}
							<div data-message-id={message.id} className="flex flex-col gap-1 scroll-mt-[60px]">
								{/* A divider separates two days; there is nothing above the
							    first message to separate it from, so the thread doesn't
							    open with a "Today" rule floating over its own first line. */}
								{index > 0 && isNewDay(message.createdAt, prev?.createdAt ?? null) ? (
									<MessageDivider date={message.createdAt} />
								) : null}
								{voiceBoundaries.get(message.id)?.start ? (
									<VoiceCallBoundary variant="start" {...voiceBoundaries.get(message.id)?.start} />
								) : null}
								{/* A finished turn belongs to the reply it produced, so it
							    renders *inside* that message under the agent's name
							    rather than as a separate row above it — which read as
							    a stray line belonging to nothing. Live turns stay
							    standalone below their trigger, where they carry their
							    own avatar. */}
								<MessageBubble
									workspaceId={workspaceId}
									message={bubbleMessage}
									questionAnswered={answeredQuestionIds.has(message.id)}
									spawnInfo={spawnByMessageId.get(message.id)}
									onRetried={handleRetried}
									onReplyInThread={
										onOpenReplies
											? () => onOpenReplies(message.threadRootId ?? message.id)
											: undefined
									}
									shownLinkedObjectIds={shownLinkedObjectIdsByMessage.get(message.id)}
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
								{message.thread && onOpenReplies ? (
									<MessageThreadPill
										summary={message.thread}
										own={message.actorId === ownActorId}
										onOpen={() => onOpenReplies(message.id)}
									/>
								) : null}
								{intro && (showSteps || intro.tools) ? (
									<div className="ml-[39px] flex max-w-[660px] flex-col gap-3">
										{showSteps && intro.steps ? (
											<SuggestedSteps
												steps={intro.steps}
												onPickStep={onPickStep}
												onSendStep={(step, stepIndex) =>
													onSendStep(step.prompt, {
														from_suggested_step: { intro_message_id: message.id, index: stepIndex },
													})
												}
												sending={sendingStep}
												disabled={
													actors.isSuccess && !actors.data.some((a) => a.id === message.actorId)
												}
											/>
										) : null}
										{intro.tools ? (
											<NeededTools
												workspaceId={workspaceId}
												conversationId={conversationId}
												agentId={message.actorId}
												agentName={message.actorName}
												tools={intro.tools}
											/>
										) : null}
									</div>
								) : null}
								{turnsBelowHere.map((turn, turnIndex) => (
									<MessageActivity
										key={`${turn.sessionId}-below-${turnIndex}`}
										workspaceId={workspaceId}
										turn={turn}
									/>
								))}
								{voiceBoundaries.get(message.id)?.end ? <VoiceCallBoundary variant="end" /> : null}
							</div>
						</Fragment>
					)
				})}
				{/* Handoffs created after the newest message: the person sees the work
				    begin instead of waiting for the agent's next message. */}
				{renderHandoffCards(handoffsByNextMessage.get('end'))}
			</div>
			<div ref={bottomAnchorRef} />
		</div>
	)
}
