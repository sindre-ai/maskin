import {
	getSessionResultDisplay,
	isSessionIdleAwaitingInput,
	segmentActivityByMessage,
} from '@/components/agents/session-log-transcript'
import { SessionThread } from '@/components/chat/session-thread'
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

			<SessionThread workspaceId={workspaceId} conversationId={conversationId} thread={thread} />
		</>
	)
}
