import {
	SessionLogTranscript,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { ProducedFilesGroup, ProducedObjectsGroup } from '@/components/objects/produced-pane'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { type ConversationThread, useConversationThreads } from '@/hooks/use-conversation-threads'
import { useSessionAffectedObjects } from '@/hooks/use-events'
import { useSendSessionInput, useSession, useSessionLogs } from '@/hooks/use-sessions'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import {
	STRIP_PILL_CLASSES,
	type ThreadGroup,
	handoffTitle,
	statusToPill,
	statusToThreadGroup,
} from '@/lib/handed-off-strip'
import { Link } from '@tanstack/react-router'
import { ArrowLeft, ExternalLink, Send, X } from 'lucide-react'
import { useMemo, useState } from 'react'

const GROUP_LABEL: Record<ThreadGroup, string> = {
	working: 'Working',
	failed: 'Needs attention',
	done: 'Done',
}
const GROUP_ORDER: ThreadGroup[] = ['failed', 'working', 'done']

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
					thread={open}
					onBack={() => onOpenSession(null)}
					onClose={onClose}
				/>
			) : (
				<ThreadsList threads={threads} onOpen={(id) => onOpenSession(id)} onClose={onClose} />
			)}
		</div>
	)
}

function PaneClose({ onClose }: { onClose?: () => void }) {
	if (!onClose) return null
	return (
		<Button
			type="button"
			variant="ghost"
			size="icon"
			className="h-6 w-6"
			onClick={onClose}
			aria-label="Close Threads pane"
		>
			<X size={14} />
		</Button>
	)
}

function ThreadsList({
	threads,
	onOpen,
	onClose,
}: { threads: ConversationThread[]; onOpen: (id: string) => void; onClose?: () => void }) {
	return (
		<>
			<div className="flex shrink-0 items-center justify-between border-b border-border px-4 py-2.5">
				<h3 className="text-[13px] font-semibold text-foreground">
					Threads <span className="ml-1 font-mono text-muted-foreground">{threads.length}</span>
				</h3>
				<PaneClose onClose={onClose} />
			</div>
			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
				{threads.length === 0 ? (
					<EmptyState
						title="No threads yet"
						description="When an agent in this chat hands work to another agent, it shows up here."
					/>
				) : (
					GROUP_ORDER.map((group) => {
						const items = threads.filter((t) => statusToThreadGroup(t.status) === group)
						if (items.length === 0) return null
						return (
							<section key={group} aria-label={`${GROUP_LABEL[group]} · ${items.length}`}>
								<h4 className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground">
									{GROUP_LABEL[group]} · {items.length}
								</h4>
								<ul className="flex flex-col gap-0.5">
									{items.map((t) => (
										<li key={t.id}>
											<button
												type="button"
												onClick={() => onOpen(t.id)}
												className="flex w-full flex-col items-start gap-0.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted focus-visible:bg-muted focus-visible:outline-none"
											>
												<span className="w-full truncate text-[13px] font-medium text-foreground">
													{handoffTitle(t.actionPrompt, t.actorName)}
												</span>
												<span className="w-full truncate text-[11px] text-muted-foreground">
													{t.actorName}
													{group === 'working' && t.currentActivity
														? ` · ${t.currentActivity}`
														: ''}
												</span>
											</button>
										</li>
									))}
								</ul>
							</section>
						)
					})
				)}
			</div>
		</>
	)
}

function ThreadView({
	workspaceId,
	thread,
	onBack,
	onClose,
}: {
	workspaceId: string
	thread: ConversationThread
	onBack: () => void
	onClose?: () => void
}) {
	const pill = statusToPill(thread.status)
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
				{pill ? (
					<span
						className={cn(
							'shrink-0 rounded px-1.5 py-1 font-mono text-[10px] font-bold uppercase leading-none tracking-wider',
							STRIP_PILL_CLASSES[pill],
						)}
					>
						{idle && pill === 'WORKING' ? 'IDLE' : pill}
					</span>
				) : null}
				<PaneClose onClose={onClose} />
			</div>

			<div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
				<div className="rounded-lg border border-border bg-card px-3 py-2">
					<span className="eyebrow">Handed off</span>
					<p className="mt-1 whitespace-pre-wrap text-[12.5px] text-foreground">
						{thread.actionPrompt}
					</p>
				</div>
				{isLoading ? <Spinner /> : <SessionLogTranscript logs={logs ?? []} />}
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
