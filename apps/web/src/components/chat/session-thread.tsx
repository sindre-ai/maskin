import { isSessionIdleAwaitingInput } from '@/components/agents/session-log-transcript'
import { Composer } from '@/components/chat/chat'
import { MessageActivity } from '@/components/chat/message-activity'
import { MessageBubble } from '@/components/chat/message-bubble'
import { QuestionOptions } from '@/components/chat/question-options'
import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { flattenMessagesOldestFirst, useConversationMessages } from '@/hooks/use-conversation'
import type { ConversationThread } from '@/hooks/use-conversation-threads'
import {
	useContinueSession,
	useSendSessionInput,
	useSession,
	useSessionChainLogs,
} from '@/hooks/use-sessions'
import { getStoredActor } from '@/lib/auth'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { failureText, statusToPill } from '@/lib/handed-off-strip'
import { buildThreadChat } from '@/lib/session-thread'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

const OLD_FOLLOW_UP_MARK = 'What the person says now:\n'

/**
 * The text of a thread's first message. Follow-ups started before the person's own words
 * became the prompt carry a wrapper around them: only what the person said is theirs.
 */
function promptText(prompt: string, isFollowUp: boolean): string {
	if (!isFollowUp) return prompt
	const at = prompt.indexOf(OLD_FOLLOW_UP_MARK)
	return at === -1 ? prompt : prompt.slice(at + OLD_FOLLOW_UP_MARK.length)
}

/**
 * A sub-session drawn as a normal chat: the same bubbles and composer as the main chat,
 * with the agent's replies, its steps, and anything the person sent into it. The
 * transcript is the session's own log, so nothing here is stored as a chat message.
 */
export function SessionThread({
	workspaceId,
	conversationId,
	thread,
}: {
	workspaceId: string
	conversationId: string
	thread: ConversationThread
}) {
	const pill = statusToPill(thread.status)
	const live = pill === 'WORKING' || pill === 'QUEUED'
	// The newest session is the one a message goes into and whose state the thread shows.
	const { data: session } = useSession(thread.latestId, workspaceId)
	const chainLogs = useSessionChainLogs(thread.sessionIds, workspaceId, { live })
	const isLoading = chainLogs.some((q) => q.isLoading)
	const logs = chainLogs[chainLogs.length - 1]?.data
	const { data: pages } = useConversationMessages(conversationId, workspaceId)
	const me = getStoredActor()

	// Whoever handed the work off wrote the message the thread hangs from: that is who
	// the first bubble belongs to.
	const author = useMemo(
		() => ({ id: me?.id ?? '', name: me?.name ?? 'You', type: 'human' as const }),
		[me?.id, me?.name],
	)
	// Whoever handed the work off wrote the message the thread hangs from: that is who the
	// first bubble belongs to.
	const handedOffBy = useMemo(() => {
		const from = flattenMessagesOldestFirst(pages).find((m) => m.id === thread.messageId)
		return from
			? { id: from.actorId, name: from.actorName, type: from.actorType }
			: { id: '', name: 'Handed off', type: 'agent' as const }
	}, [pages, thread.messageId])

	// One conversation: the first session, then each follow-up the person wrote, all in order.
	const chainData = chainLogs.map((q) => q.data)
	const chat = useMemo(() => {
		const parts = thread.sessionIds.map((sessionId, i) => {
			const follow = i > 0 ? thread.followUps[i - 1] : undefined
			return buildThreadChat(chainData[i] ?? [], {
				conversationId,
				sessionId,
				agent: { id: thread.actorId, name: thread.actorName, type: 'agent' },
				me: author,
				prompt: follow
					? {
							author,
							content: promptText(follow.actionPrompt, true),
							createdAt: follow.createdAt,
						}
					: { author: handedOffBy, content: thread.actionPrompt, createdAt: thread.createdAt },
			})
		})
		let nextId = -1
		const items = parts
			.flatMap((p) => p.items)
			.map((item) => ({ ...item, message: { ...item.message, id: nextId-- } }))
		return { items, liveSteps: parts[parts.length - 1]?.liveSteps ?? [] }
	}, [chainData, conversationId, thread, author, handedOffBy])

	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const working = live && !idle && !thread.awaiting
	const failed = pill === 'FAILED'
	// The thread is shown in this chat, so anyone who can see it may carry on with it. Writing
	// into a running session has the server's stricter rule: whoever started it, or the chat
	// it asks its questions in.
	const canWriteLive =
		!!session &&
		session.config?.interactive === true &&
		session.status === 'running' &&
		(session.createdBy === me?.id || session.config?.ask_conversation_id === conversationId)
	const mode: ComposerMode = canWriteLive
		? 'live'
		: ENDED.has(thread.status)
			? 'continue'
			: 'closed'

	const endRef = useRef<HTMLDivElement>(null)
	const size = chat.items.length + chat.liveSteps.length
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll down whenever the transcript grows
	useEffect(() => {
		endRef.current?.scrollIntoView({ block: 'end' })
	}, [size])

	return (
		<>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
				{isLoading ? (
					<Spinner />
				) : chat.items.length === 0 && !working ? (
					<EmptyState title="No messages yet" description="Nothing has been written here yet." />
				) : null}
				{chat.items.map(({ message, steps }) => (
					<MessageBubble
						key={message.id}
						workspaceId={workspaceId}
						message={message}
						activity={
							steps.length > 0 ? (
								<MessageActivity
									workspaceId={workspaceId}
									turn={{
										sessionId: thread.id,
										actorId: thread.actorId,
										steps,
										inProgress: false,
									}}
									layout="inline"
								/>
							) : undefined
						}
					/>
				))}
				{working ? (
					<MessageActivity
						workspaceId={workspaceId}
						turn={{
							sessionId: thread.id,
							actorId: thread.actorId,
							steps: chat.liveSteps,
							inProgress: true,
							starting: pill === 'QUEUED',
						}}
					/>
				) : null}
				{failed && !isLoading ? (
					<p className="rounded-lg border border-border bg-card px-3 py-2 text-[12.5px] text-muted-foreground">
						{failureText(thread.result)}
					</p>
				) : null}
				{thread.awaiting ? (
					<div className="rounded-lg border border-border bg-card px-3 py-2">
						<span className="eyebrow">Waiting on you</span>
						<QuestionOptions
							conversationId={conversationId}
							workspaceId={workspaceId}
							questionMessageId={thread.awaiting.message_id}
							question={{ ...thread.awaiting.question, reply_to_session: true }}
							answered={false}
						/>
					</div>
				) : null}
				<div ref={endRef} />
			</div>
			<SessionComposer
				workspaceId={workspaceId}
				conversationId={conversationId}
				thread={thread}
				mode={mode}
			/>
		</>
	)
}

const ENDED: ReadonlySet<string> = new Set(['completed', 'failed', 'timeout', 'user_stopped'])

/**
 * live: the session is open, so the message goes into it. continue: it has ended, so the
 * message starts a follow-up session for the same agent. closed: neither is possible
 * yet (still starting, or not the person's to write to).
 */
type ComposerMode = 'live' | 'continue' | 'closed'

/**
 * The main chat's composer, sending into the thread. Only the text is sent: a session
 * takes no attachments or references.
 */
function SessionComposer({
	workspaceId,
	conversationId,
	thread,
	mode,
}: {
	workspaceId: string
	conversationId: string
	thread: ConversationThread
	mode: ComposerMode
}) {
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const send = useSendSessionInput(workspaceId)
	const carryOn = useContinueSession(workspaceId, conversationId)

	return (
		<div className="shrink-0 px-3 pt-2.5 pb-3.5">
			<Composer
				workspaceId={workspaceId}
				onSend={async (content) => {
					setError(null)
					try {
						if (mode === 'live') {
							await send.mutateAsync({ id: thread.latestId, content })
						} else {
							await carryOn.mutateAsync({ id: thread.latestId, content })
						}
					} catch (err) {
						setError(err instanceof Error ? err.message : 'Failed to send message')
						throw err
					}
				}}
				disabled={mode === 'closed'}
				pending={send.isPending || carryOn.isPending}
				surface="sheet"
				placeholder={
					mode === 'closed'
						? `${thread.actorName} is getting started…`
						: `Message ${thread.actorName}…`
				}
				selection={selection}
				onDispatchSelection={dispatch}
				onRemoveAgent={(id) => dispatch({ type: 'remove_agent', id })}
				onRemoveObject={(id) => dispatch({ type: 'remove_object', id })}
				onRemoveNotification={(id) => dispatch({ type: 'remove_notification', id })}
				onRemoveFile={(fileId) => dispatch({ type: 'remove_file', fileId })}
				externalError={error}
				onDismissExternalError={() => setError(null)}
				textareaLabel={`Message ${thread.actorName}`}
				draftKey={`session:${thread.id}`}
			/>
		</div>
	)
}
