import { isSessionIdleAwaitingInput } from '@/components/agents/session-log-transcript'
import { Composer } from '@/components/chat/chat'
import { MessageActivity } from '@/components/chat/message-activity'
import { MessageBubble } from '@/components/chat/message-bubble'
import { QuestionOptions } from '@/components/chat/question-options'
import { EmptyState } from '@/components/shared/empty-state'
import { Spinner } from '@/components/ui/spinner'
import { flattenMessagesOldestFirst, useConversationMessages } from '@/hooks/use-conversation'
import type { ConversationThread } from '@/hooks/use-conversation-threads'
import { useSendSessionInput, useSession, useSessionLogs } from '@/hooks/use-sessions'
import { getStoredActor } from '@/lib/auth'
import { EMPTY_CHAT_SELECTION, chatSelectionReducer } from '@/lib/chat-selection'
import { failureText, statusToPill } from '@/lib/handed-off-strip'
import { buildThreadChat } from '@/lib/session-thread'
import { useEffect, useMemo, useReducer, useRef, useState } from 'react'

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
	const { data: session } = useSession(thread.id, workspaceId)
	const { data: logs, isLoading } = useSessionLogs(thread.id, workspaceId, true, { live })
	const { data: pages } = useConversationMessages(conversationId, workspaceId)
	const me = getStoredActor()

	// Whoever handed the work off wrote the message the thread hangs from: that is who
	// the first bubble belongs to.
	const handedOffBy = useMemo(() => {
		const from = flattenMessagesOldestFirst(pages).find((m) => m.id === thread.messageId)
		return from
			? { id: from.actorId, name: from.actorName, type: from.actorType }
			: { id: '', name: 'Handed off', type: 'agent' as const }
	}, [pages, thread.messageId])

	const chat = useMemo(
		() =>
			buildThreadChat(logs ?? [], {
				conversationId,
				sessionId: thread.id,
				agent: { id: thread.actorId, name: thread.actorName, type: 'agent' },
				me: { id: me?.id ?? '', name: me?.name ?? 'You', type: 'human' },
				prompt: {
					author: handedOffBy,
					content: thread.actionPrompt,
					createdAt: thread.createdAt,
				},
			}),
		[logs, conversationId, thread, me?.id, me?.name, handedOffBy],
	)

	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const working = live && !idle && !thread.awaiting
	const failed = pill === 'FAILED'
	const canReply =
		!!session &&
		session.status === 'running' &&
		session.config?.interactive === true &&
		session.createdBy === me?.id

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
			<SessionComposer workspaceId={workspaceId} thread={thread} canReply={canReply} />
		</>
	)
}

/**
 * The main chat's composer, sending into the session. It mirrors the
 * `POST /sessions/:id/input` gates (interactive, running, started by the caller) so a
 * message the server would refuse is explained instead of failing after it was typed.
 * Only the text is sent: the session input takes no attachments or references.
 */
function SessionComposer({
	workspaceId,
	thread,
	canReply,
}: { workspaceId: string; thread: ConversationThread; canReply: boolean }) {
	const [selection, dispatch] = useReducer(chatSelectionReducer, EMPTY_CHAT_SELECTION)
	const [error, setError] = useState<string | null>(null)
	const send = useSendSessionInput(workspaceId)

	if (!canReply) {
		return (
			<p className="shrink-0 border-t border-border px-4 py-3 text-[12px] text-muted-foreground">
				{thread.actorName} isn't taking messages in this thread. Ask the agent that handed this off
				to pass your feedback on.
			</p>
		)
	}

	return (
		<div className="shrink-0 px-3 pt-2.5 pb-3.5">
			<Composer
				workspaceId={workspaceId}
				onSend={async (content) => {
					setError(null)
					try {
						await send.mutateAsync({ id: thread.id, content })
					} catch (err) {
						setError(err instanceof Error ? err.message : 'Failed to send message')
						throw err
					}
				}}
				disabled={false}
				pending={send.isPending}
				surface="sheet"
				placeholder={`Message ${thread.actorName}…`}
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
