import {
	getSessionResultDisplay,
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
} from '@/components/agents/session-log-transcript'
import { MessageActivity } from '@/components/chat/message-activity'
import { QuestionOptions } from '@/components/chat/question-options'
import { ProducedFilesGroup, ProducedObjectsGroup } from '@/components/objects/produced-pane'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type ConversationThread, useConversationThreads } from '@/hooks/use-conversation-threads'
import { useSessionAffectedObjects } from '@/hooks/use-events'
import { useSendSessionInput, useSession, useSessionLogs } from '@/hooks/use-sessions'
import type { SessionLogResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	type ThreadGroup,
	failureText,
	handoffTitle,
	statusToPill,
	statusToThreadGroup,
	threadPill,
} from '@/lib/handed-off-strip'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Send, X } from 'lucide-react'
import { useMemo, useState } from 'react'

const GROUP_LABEL: Record<ThreadGroup, string> = {
	waiting: 'Waiting on you',
	working: 'Working',
	failed: 'Needs attention',
	done: 'Done',
}
const GROUP_ORDER: ThreadGroup[] = ['waiting', 'failed', 'working', 'done']

const groupOf = (t: ConversationThread) => statusToThreadGroup(t.status, t.awaiting !== null)

interface ThreadsPaneProps {
	workspaceId: string
	conversationId: string
	/** Session open in the pane; null shows the list. */
	openSessionId: string | null
	onOpenSession: (sessionId: string | null) => void
	onClose?: () => void
	className?: string
}

/**
 * Right-rail pane listing every session a chat handed work to, and — one click
 * in — that session as a thread the human can read and (when the session allows
 * it) reply to. Sits beside the Produced pane and shares its chrome.
 */
export function ThreadsPane({
	workspaceId,
	conversationId,
	openSessionId,
	onOpenSession,
	onClose,
	className,
}: ThreadsPaneProps) {
	const threads = useConversationThreads(workspaceId, conversationId)
	const open = threads.find((t) => t.id === openSessionId) ?? null

	return (
		<div
			className={cn('flex h-full min-h-0 w-full flex-col bg-surface-sunken', className)}
			aria-label="Threads"
		>
			{open ? (
				<ThreadView
					workspaceId={workspaceId}
					conversationId={conversationId}
					thread={open}
					onBack={() => onOpenSession(null)}
					onClose={onClose}
				/>
			) : (
				<ThreadsList threads={threads} onOpen={(id) => onOpenSession(id)} />
			)}
		</div>
	)
}

function ThreadsList({
	threads,
	onOpen,
}: { threads: ConversationThread[]; onOpen: (id: string) => void }) {
	const waiting = threads.filter((t) => groupOf(t) === 'waiting').length
	const working = threads.filter((t) => groupOf(t) === 'working').length
	const failed = threads.filter((t) => groupOf(t) === 'failed').length
	const summary =
		threads.length === 0
			? 'Nothing has been handed off yet.'
			: waiting > 0
				? `${waiting} ${waiting === 1 ? 'thread is' : 'threads are'} waiting on you.`
				: failed > 0
					? `${failed} ${failed === 1 ? 'thread needs' : 'threads need'} your attention.`
					: working > 0
						? `${working} ${working === 1 ? 'thread is' : 'threads are'} working.`
						: 'All threads are done.'
	return (
		<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
			<div>
				<h3 className="text-[20px] font-semibold tracking-[-0.02em] text-foreground">Overview</h3>
				<p className="mt-0.5 text-[13px] text-muted-foreground">{summary}</p>
			</div>
			{threads.length === 0 ? (
				<EmptyState
					title="No threads yet"
					description="When an agent in this chat hands work to another agent, it shows up here."
				/>
			) : (
				GROUP_ORDER.map((group) => {
					const items = threads.filter((t) => groupOf(t) === group)
					if (items.length === 0) return null
					return (
						<section key={group} aria-label={`${GROUP_LABEL[group]} · ${items.length}`}>
							<h4 className="mb-1 flex items-center gap-2 rounded-md bg-muted px-2.5 py-1.5 text-[12.5px] font-medium text-foreground">
								{GROUP_LABEL[group]}
								<span className="font-normal text-muted-foreground">{items.length}</span>
							</h4>
							<ul className="flex flex-col">
								{items.map((t) => (
									<li key={t.id}>
										<button
											type="button"
											onClick={() => onOpen(t.id)}
											className="flex w-full items-start gap-3 rounded-md px-2.5 py-2 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
										>
											<span className="flex min-w-0 flex-1 flex-col gap-0.5">
												<span className="truncate text-[13.5px] font-medium text-foreground">
													{handoffTitle(t.actionPrompt, t.actorName)}
												</span>
												<span className="truncate text-[12px] text-muted-foreground">
													{t.actorName}
													{group === 'working' && t.currentActivity
														? ` · ${t.currentActivity}`
														: ''}
												</span>
											</span>
											{t.startedAt ? (
												<RelativeTime
													date={t.startedAt}
													compact
													className="shrink-0 pt-0.5 text-[11px] text-muted-foreground"
												/>
											) : null}
										</button>
									</li>
								))}
							</ul>
						</section>
					)
				})
			)}
		</div>
	)
}

/**
 * What the person came to read: the final output of a finished thread, what a
 * failed one is stuck on, or the live transcript while it is still running.
 * The prompt the agent was handed is deliberately not shown.
 */
function ThreadOutcome({
	workspaceId,
	conversationId,
	thread,
	logs,
	isLoading,
}: {
	workspaceId: string
	conversationId: string
	thread: ConversationThread
	logs: SessionLogResponse[]
	isLoading: boolean
}) {
	const group = groupOf(thread)
	const result = useMemo(() => getSessionResultDisplay(logs), [logs])
	// A helper has no `maskin_message_id` turns, so its whole trace is one run of steps.
	const steps = useMemo(() => {
		const { segments, unassigned } = segmentActivityByMessage(logs)
		return [...unassigned, ...segments.flatMap((s) => s.steps)]
	}, [logs])
	if (isLoading) return <Spinner />
	if (group === 'waiting' && thread.awaiting) {
		return (
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
		)
	}
	// Live work reads like it does in the chat — who is working, how long, and the
	// steps taken — rather than the raw log.
	if (group === 'working') {
		return (
			<MessageActivity
				workspaceId={workspaceId}
				turn={{
					sessionId: thread.id,
					actorId: thread.actorId,
					steps,
					inProgress: true,
					starting: statusToPill(thread.status) === 'QUEUED',
				}}
			/>
		)
	}
	const text = result?.text ?? (group === 'failed' ? failureText(thread.result) : null)
	return (
		<div className="rounded-lg border border-border bg-card px-3 py-2">
			<span className="eyebrow">{group === 'failed' ? 'Needs attention' : 'Final output'}</span>
			<div className="mt-1.5">
				{text ? (
					<MarkdownContent content={text} size="sm" />
				) : (
					<p className="text-[12.5px] text-muted-foreground">No final output was recorded.</p>
				)}
			</div>
		</div>
	)
}

function ThreadView({
	workspaceId,
	conversationId,
	thread,
	onBack,
	onClose,
}: {
	workspaceId: string
	conversationId: string
	thread: ConversationThread
	onBack: () => void
	onClose?: () => void
}) {
	const pill = statusToPill(thread.status)
	const display = threadPill(thread.status, thread.awaiting !== null)
	const live = pill === 'WORKING' || pill === 'QUEUED'
	const { data: session } = useSession(thread.id, workspaceId)
	const { data: logs, isLoading } = useSessionLogs(thread.id, workspaceId, true, { live })
	const { producedObjects, producedFiles } = useSessionAffectedObjects(
		thread.startedAt,
		thread.completedAt,
		workspaceId,
	)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])

	return (
		<>
			<div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="h-6 w-6"
					onClick={onBack}
					aria-label="Back to threads"
				>
					<ArrowLeft size={14} />
				</Button>
				<ActorAvatar
					id={thread.actorId}
					name={thread.actorName}
					type="agent"
					size="sm"
					className="shrink-0"
				/>
				<div className="flex min-w-0 flex-1 flex-col">
					<span className="truncate text-[13px] font-semibold text-foreground">
						{thread.actorName}
					</span>
					<span className="truncate text-[11px] text-muted-foreground">
						{handoffTitle(thread.actionPrompt, thread.actorName)}
					</span>
				</div>
				{display ? (
					<span
						className={cn(
							'shrink-0 rounded px-1.5 py-1 font-mono text-[10px] font-bold uppercase leading-none tracking-wider',
							display.className,
						)}
					>
						{idle && display.label === 'WORKING' ? 'IDLE' : display.label}
					</span>
				) : null}
				{onClose ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-6 w-6"
						onClick={onClose}
						aria-label="Close Overview"
					>
						<X size={14} />
					</Button>
				) : null}
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
				<ThreadOutcome
					workspaceId={workspaceId}
					conversationId={conversationId}
					thread={thread}
					logs={logs ?? []}
					isLoading={isLoading}
				/>
				<ProducedObjectsGroup workspaceId={workspaceId} items={producedObjects} />
				<ProducedFilesGroup workspaceId={workspaceId} items={producedFiles} />
				<Link
					to="/$workspaceId/agents/$agentId"
					params={{ workspaceId, agentId: thread.actorId }}
					search={{ session: thread.id } as never}
					className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground"
				>
					Open full session <ExternalLink size={12} />
				</Link>
			</div>

			<ThreadReply
				workspaceId={workspaceId}
				thread={thread}
				canReply={
					!!session &&
					session.status === 'running' &&
					session.config?.interactive === true &&
					session.createdBy === getStoredActor()?.id
				}
			/>
		</>
	)
}

/**
 * The reply box mirrors the `POST /sessions/:id/input` gates (interactive,
 * running, started by the caller) so a reply the server would refuse is
 * explained here instead of failing after the user typed it.
 */
function ThreadReply({
	workspaceId,
	thread,
	canReply,
}: { workspaceId: string; thread: ConversationThread; canReply: boolean }) {
	const [draft, setDraft] = useState('')
	const send = useSendSessionInput(workspaceId)

	if (!canReply) {
		return (
			<p className="shrink-0 border-t border-border px-4 py-3 text-[12px] text-muted-foreground">
				{thread.actorName} isn't taking replies in this thread. Ask the agent that handed this off
				to pass your feedback on, or open the full session.
			</p>
		)
	}

	const submit = () => {
		const content = draft.trim()
		if (!content || send.isPending) return
		send.mutate({ id: thread.id, content }, { onSuccess: () => setDraft('') })
	}

	return (
		<div className="flex shrink-0 items-end gap-2 border-t border-border px-3 py-2.5">
			<Textarea
				value={draft}
				onChange={(e) => setDraft(e.target.value)}
				onKeyDown={(e) => {
					if (e.key === 'Enter' && !e.shiftKey) {
						e.preventDefault()
						submit()
					}
				}}
				placeholder={`Reply to ${thread.actorName}…`}
				rows={1}
				className="min-h-0 flex-1 resize-none"
			/>
			<Button
				type="button"
				size="icon"
				onClick={submit}
				disabled={!draft.trim() || send.isPending}
				aria-label="Send reply"
			>
				<Send size={14} />
			</Button>
		</div>
	)
}
