import { PageHeader } from '@/components/layout/page-header'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import {
	useCreateThread,
	usePostThreadEvent,
	useRemoveThreadParticipant,
	useResolveThread,
	useThread,
	useThreadEventStream,
	useThreads,
	useUpdateThread,
} from '@/hooks/use-threads'
import type { ActorListItem, ThreadEventResponse, ThreadResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Archive, Check, Plus, Send, X } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'

export const Route = createFileRoute('/_authed/$workspaceId/threads/')({
	component: ThreadsPage,
	errorComponent: ({ error }) => <RouteError error={error} />,
	validateSearch: (search: Record<string, unknown>) => ({
		threadId: typeof search.threadId === 'string' ? search.threadId : undefined,
		filter: typeof search.filter === 'string' ? search.filter : 'all',
	}),
})

type FilterTab = 'all' | 'channel' | 'direct' | 'open' | 'resolved'

const FILTER_TABS: { label: string; value: FilterTab }[] = [
	{ label: 'All', value: 'all' },
	{ label: 'Channel', value: 'channel' },
	{ label: 'Direct', value: 'direct' },
	{ label: 'Open', value: 'open' },
	{ label: 'Resolved', value: 'resolved' },
]

const KIND_COLORS: Record<string, string> = {
	needs_input: 'bg-warning',
	alert: 'bg-error',
	recommendation: 'bg-accent',
	good_news: 'bg-success',
	fyi: 'bg-muted-foreground',
	discussion: 'bg-primary',
	conversation: 'bg-secondary-foreground',
}

const KIND_LABELS: Record<string, string> = {
	needs_input: 'Needs input',
	alert: 'Alert',
	recommendation: 'Recommendation',
	good_news: 'Good news',
	fyi: 'FYI',
	discussion: 'Discussion',
	conversation: 'Conversation',
}

function ThreadsPage() {
	const { workspaceId } = useWorkspace()
	const { threadId: selectedThreadId, filter } = useSearch({
		from: '/_authed/$workspaceId/threads/',
	})
	const navigate = useNavigate()
	const [newDialogOpen, setNewDialogOpen] = useState(false)

	const activeFilter = (filter ?? 'all') as FilterTab

	const queryParams: Record<string, string> = {}
	if (activeFilter === 'channel') queryParams.visibility = 'channel'
	if (activeFilter === 'direct') queryParams.visibility = 'private'
	if (activeFilter === 'open') queryParams.state = 'open'
	if (activeFilter === 'resolved') queryParams.state = 'resolved'

	const { data: threads, isLoading } = useThreads(workspaceId, queryParams)
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	const setFilter = (value: FilterTab) => {
		navigate({
			to: '/$workspaceId/threads',
			params: { workspaceId },
			search: { filter: value, threadId: selectedThreadId },
		})
	}

	const selectThread = (id: string | undefined) => {
		navigate({
			to: '/$workspaceId/threads',
			params: { workspaceId },
			search: { filter: activeFilter, threadId: id },
		})
	}

	return (
		<div className="flex flex-col h-full min-h-0">
			<PageHeader
				actions={
					<Button size="sm" onClick={() => setNewDialogOpen(true)}>
						<Plus size={15} className="mr-1" />
						New conversation
					</Button>
				}
			/>

			{/* Filter tabs */}
			<div className="flex gap-1 mb-4 shrink-0">
				{FILTER_TABS.map((tab) => (
					<button
						key={tab.value}
						type="button"
						className={cn(
							'rounded px-3 py-1 text-sm',
							activeFilter === tab.value
								? 'bg-muted text-foreground font-medium'
								: 'text-muted-foreground hover:text-foreground',
						)}
						onClick={() => setFilter(tab.value)}
					>
						{tab.label}
					</button>
				))}
			</div>

			{/* Thread list */}
			<div className="flex-1 min-h-0 overflow-y-auto">
				{isLoading ? (
					<ListSkeleton rows={5} />
				) : !threads || threads.length === 0 ? (
					<EmptyState
						title="No threads yet"
						description="Start a conversation with your team or agents."
						action={
							<Button size="sm" onClick={() => setNewDialogOpen(true)}>
								<Plus size={15} className="mr-1" />
								New conversation
							</Button>
						}
					/>
				) : (
					<div className="divide-y divide-border">
						{threads.map((thread) => (
							<ThreadRow
								key={thread.id}
								thread={thread}
								isSelected={thread.id === selectedThreadId}
								onClick={() => selectThread(thread.id === selectedThreadId ? undefined : thread.id)}
								actorsById={actorsById}
							/>
						))}
					</div>
				)}
			</div>

			{/* Side panel */}
			<Sheet open={!!selectedThreadId} onOpenChange={(open) => !open && selectThread(undefined)}>
				<SheetContent className="w-full sm:max-w-xl p-0 flex flex-col">
					{selectedThreadId && (
						<ThreadPanel
							threadId={selectedThreadId}
							workspaceId={workspaceId}
							onClose={() => selectThread(undefined)}
						/>
					)}
				</SheetContent>
			</Sheet>

			{/* New conversation dialog */}
			<NewThreadDialog
				open={newDialogOpen}
				onClose={() => setNewDialogOpen(false)}
				workspaceId={workspaceId}
				onCreated={(id) => {
					setNewDialogOpen(false)
					selectThread(id)
				}}
			/>
		</div>
	)
}

function ThreadRow({
	thread,
	isSelected,
	onClick,
	actorsById,
}: {
	thread: ThreadResponse
	isSelected: boolean
	onClick: () => void
	actorsById: Map<string, ActorListItem>
}) {
	const isResolved = thread.state === 'resolved' || thread.state === 'archived'
	const kindColor = KIND_COLORS[thread.kind] ?? 'bg-muted-foreground'
	const participants = thread.participants ?? []

	return (
		<button
			type="button"
			className={cn(
				'w-full text-left px-4 py-3 hover:bg-bg-hover transition-colors flex items-start gap-3',
				isSelected && 'bg-bg-hover',
				isResolved && 'opacity-60',
			)}
			onClick={onClick}
		>
			{/* Kind indicator dot */}
			<span className={cn('mt-1.5 h-2 w-2 rounded-full shrink-0', kindColor)} />

			<div className="flex-1 min-w-0">
				<div className="flex items-center justify-between gap-2 mb-0.5">
					<span
						className={cn(
							'text-sm truncate',
							isResolved ? 'text-muted-foreground line-through' : 'font-medium text-foreground',
						)}
					>
						{thread.title}
					</span>
					<div className="flex items-center gap-2 shrink-0">
						{isResolved && (
							<Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-0.5">
								<Check size={10} />
								Resolved
							</Badge>
						)}
						<RelativeTime date={thread.updatedAt} className="text-[11px] text-muted-foreground" />
					</div>
				</div>

				<div className="flex items-center gap-2">
					{/* Participant avatars */}
					{participants.length > 0 && (
						<div className="flex -space-x-1">
							{participants.slice(0, 4).map((p) => {
								const actor = actorsById.get(p.actorId)
								return (
									<ActorAvatar
										key={p.actorId}
										name={actor?.name ?? p.actorId.slice(0, 1).toUpperCase()}
										type={actor?.type ?? p.kind}
										size="sm"
										className="ring-1 ring-background"
									/>
								)
							})}
							{participants.length > 4 && (
								<span className="text-[10px] text-muted-foreground ml-1">
									+{participants.length - 4}
								</span>
							)}
						</div>
					)}
					<span className="text-xs text-muted-foreground truncate">
						{KIND_LABELS[thread.kind] ?? thread.kind}
						{thread.visibility === 'private' && ' · Private'}
					</span>
				</div>
			</div>
		</button>
	)
}

function ThreadPanel({
	threadId,
	workspaceId,
	onClose,
}: {
	threadId: string
	workspaceId: string
	onClose: () => void
}) {
	const { data: thread, isLoading } = useThread(workspaceId, threadId)
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])
	const resolveThread = useResolveThread(workspaceId, threadId)
	const archiveThread = useUpdateThread(workspaceId, threadId)
	const postEvent = usePostThreadEvent(workspaceId, threadId)
	const removeParticipant = useRemoveThreadParticipant(workspaceId, threadId)
	const [reply, setReply] = useState('')
	const [resolution, setResolution] = useState('')
	const [showResolveDialog, setShowResolveDialog] = useState(false)
	const scrollRef = useRef<HTMLDivElement>(null)
	const currentActorId = getStoredActor()?.id

	// Detect @mentions in reply text — match participant names
	const mentionIds = useMemo(() => {
		if (!thread?.participants || !reply.includes('@')) return []
		const ids: string[] = []
		for (const p of thread.participants) {
			const actor = actorsById.get(p.actorId)
			if (!actor) continue
			if (reply.toLowerCase().includes(`@${actor.name.toLowerCase()}`)) {
				ids.push(p.actorId)
			}
		}
		return ids
	}, [reply, thread?.participants, actorsById])

	// SSE stream for live event updates
	useThreadEventStream(threadId, workspaceId, () => {
		// Events arrive; query invalidation handled via hook
	})

	const eventsCount = thread?.events?.length ?? 0

	// Auto-scroll to bottom when events change
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on event count change only
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight
		}
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [eventsCount])

	const handleSend = () => {
		if (!reply.trim()) return
		postEvent.mutate(
			{
				kind: 'message',
				body: reply.trim(),
				...(mentionIds.length > 0 ? { mentions: mentionIds } : {}),
			},
			{
				onSuccess: () => setReply(''),
				onError: () => toast.error('Failed to send message'),
			},
		)
	}

	const handleResolve = () => {
		resolveThread.mutate(
			{ state: 'resolved', ...(resolution.trim() ? { resolution: resolution.trim() } : {}) },
			{
				onSuccess: () => {
					setShowResolveDialog(false)
					setResolution('')
				},
				onError: () => toast.error('Failed to resolve thread'),
			},
		)
	}

	const handleArchive = () => {
		archiveThread.mutate(
			{ state: 'archived' },
			{ onError: () => toast.error('Failed to archive thread') },
		)
	}

	const isOpen = thread?.state === 'open' || thread?.state === 'waiting'

	return (
		<>
			{/* Header */}
			<SheetHeader className="px-4 pt-4 pb-3 border-b border-border shrink-0">
				<div className="flex items-start justify-between gap-2">
					<div className="flex-1 min-w-0">
						<SheetTitle className="text-base leading-snug truncate">
							{thread?.title ?? 'Thread'}
						</SheetTitle>
						<div className="flex items-center gap-2 mt-1 flex-wrap">
							{thread && (
								<Badge variant="outline" className="text-[10px] h-4">
									{KIND_LABELS[thread.kind] ?? thread.kind}
								</Badge>
							)}
							{thread?.focusObjectId && (
								<Badge variant="secondary" className="text-[10px] h-4">
									Linked object
								</Badge>
							)}
							{thread && thread.state !== 'open' && (
								<Badge variant="secondary" className="text-[10px] h-4 capitalize">
									{thread.state}
								</Badge>
							)}
						</div>
					</div>
					<button
						type="button"
						onClick={onClose}
						className="shrink-0 text-muted-foreground hover:text-foreground transition-colors"
					>
						<X size={16} />
					</button>
				</div>
			</SheetHeader>

			{/* Event log */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
				{isLoading ? (
					<ListSkeleton rows={4} />
				) : !thread?.events || thread.events.length === 0 ? (
					<div className="py-8 text-center text-sm text-muted-foreground">
						No messages yet. Start the conversation below.
					</div>
				) : (
					thread.events.map((event) => (
						<ThreadEventItem key={event.id} event={event} actorsById={actorsById} />
					))
				)}
			</div>

			{/* Participants */}
			{thread?.participants && thread.participants.length > 0 && (
				<div className="px-4 py-2 border-t border-border shrink-0">
					<p className="text-[10px] text-muted-foreground uppercase tracking-wide mb-1.5">
						Participants
					</p>
					<div className="flex flex-wrap gap-1.5">
						{thread.participants.map((p) => {
							const actor = actorsById.get(p.actorId)
							const name = actor?.name ?? p.actorId.slice(0, 8)
							const isSelf = p.actorId === currentActorId
							return (
								<div
									key={p.actorId}
									className="flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-foreground"
								>
									<ActorAvatar name={name} type={actor?.type ?? p.kind} size="sm" />
									<span>{name}</span>
									{!isSelf && (
										<button
											type="button"
											className="ml-0.5 text-muted-foreground hover:text-foreground transition-colors"
											onClick={() =>
												removeParticipant.mutate(p.actorId, {
													onError: () => toast.error('Failed to remove participant'),
												})
											}
											aria-label={`Remove ${name}`}
										>
											<X size={11} />
										</button>
									)}
								</div>
							)
						})}
					</div>
				</div>
			)}

			{/* Actions bar */}
			<div className="px-4 py-2 border-t border-border flex items-center gap-2 shrink-0">
				{isOpen && thread?.state !== 'resolved' && (
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowResolveDialog(true)}
						disabled={resolveThread.isPending}
					>
						<Check size={13} className="mr-1" />
						Resolve
					</Button>
				)}
				{thread?.state !== 'archived' && (
					<Button
						variant="ghost"
						size="sm"
						onClick={handleArchive}
						disabled={archiveThread.isPending}
						className="text-muted-foreground"
					>
						<Archive size={13} className="mr-1" />
						Archive
					</Button>
				)}
			</div>

			{/* Resolve dialog */}
			<Dialog open={showResolveDialog} onOpenChange={setShowResolveDialog}>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Resolve thread</DialogTitle>
					</DialogHeader>
					<div className="space-y-3 pt-1">
						<Label htmlFor="resolution-summary">Resolution summary (optional)</Label>
						<Textarea
							id="resolution-summary"
							value={resolution}
							onChange={(e) => setResolution(e.target.value)}
							placeholder="What was decided or accomplished?"
							rows={3}
							className="resize-none text-sm"
						/>
						<div className="flex justify-end gap-2">
							<Button variant="outline" size="sm" onClick={() => setShowResolveDialog(false)}>
								Cancel
							</Button>
							<Button size="sm" onClick={handleResolve} disabled={resolveThread.isPending}>
								<Check size={13} className="mr-1" />
								Resolve
							</Button>
						</div>
					</div>
				</DialogContent>
			</Dialog>

			{/* Resolution note */}
			{thread?.resolution && (
				<div className="px-4 py-2 bg-bg-surface border-t border-border shrink-0">
					<p className="text-xs text-muted-foreground">
						<Check size={11} className="inline mr-1" />
						{thread.resolution}
					</p>
				</div>
			)}

			{/* Reply box */}
			{isOpen && (
				<div className="px-4 pb-4 pt-2 border-t border-border shrink-0">
					<div className="flex gap-2 items-end">
						<Textarea
							aria-label="Reply to thread"
							value={reply}
							onChange={(e) => setReply(e.target.value)}
							placeholder="Reply… (Cmd/Ctrl+↵ to send)"
							rows={2}
							className="resize-none text-sm"
							onKeyDown={(e) => {
								if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
									e.preventDefault()
									handleSend()
								}
							}}
						/>
						<Button
							size="icon"
							onClick={handleSend}
							disabled={!reply.trim() || postEvent.isPending}
							className="shrink-0 h-9 w-9"
						>
							<Send size={14} />
						</Button>
					</div>
				</div>
			)}
		</>
	)
}

export function ThreadEventItem({
	event,
	actorsById,
}: { event: ThreadEventResponse; actorsById: Map<string, ActorListItem> }) {
	const isSystem =
		event.kind === 'join' ||
		event.kind === 'leave' ||
		event.kind === 'resolve' ||
		event.kind === 'archive' ||
		event.kind === 'system'

	if (isSystem) {
		return (
			<div className="flex justify-center">
				<span className="text-[11px] text-muted-foreground px-3 py-0.5 rounded-full bg-muted">
					{event.body ?? event.kind}
				</span>
			</div>
		)
	}

	const isAgent =
		event.kind === 'plan' ||
		event.kind === 'tool_call' ||
		event.kind === 'tool_result' ||
		event.kind === 'yield'

	const actor = actorsById.get(event.actorId)
	const actorName = actor?.name ?? event.actorId.slice(0, 8)
	const actorType = actor?.type ?? (isAgent ? 'agent' : 'human')

	return (
		<div className="flex gap-2 items-start">
			<ActorAvatar name={actorName} type={actorType} size="sm" className="shrink-0 mt-0.5" />
			<div className="flex-1 min-w-0">
				<div className="flex items-baseline gap-2 mb-0.5">
					<span className="text-xs font-medium text-foreground">{actorName}</span>
					<RelativeTime date={event.createdAt} className="text-[10px] text-muted-foreground" />
					{event.kind !== 'message' && (
						<span className="text-[10px] text-muted-foreground capitalize">{event.kind}</span>
					)}
				</div>
				{event.body && (
					<p className="text-sm text-foreground leading-relaxed whitespace-pre-wrap break-words">
						{event.body}
					</p>
				)}
			</div>
		</div>
	)
}

function NewThreadDialog({
	open,
	onClose,
	workspaceId,
	focusObjectId,
	onCreated,
}: {
	open: boolean
	onClose: () => void
	workspaceId: string
	focusObjectId?: string
	onCreated?: (id: string) => void
}) {
	const createThread = useCreateThread(workspaceId)
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('')
	const [visibility, setVisibility] = useState<'channel' | 'private'>('channel')

	const handleSubmit = () => {
		if (!title.trim()) return
		createThread.mutate(
			{
				title: title.trim(),
				body: body.trim() || undefined,
				visibility,
				focusObjectId: focusObjectId || undefined,
				kind: 'discussion',
			},
			{
				onSuccess: (thread) => {
					setTitle('')
					setBody('')
					onCreated?.(thread.id)
				},
				onError: () => toast.error('Failed to create thread'),
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>New conversation</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 mt-2">
					<div className="space-y-1.5">
						<Label htmlFor="thread-title">Title</Label>
						<Input
							id="thread-title"
							placeholder="What's this about?"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="thread-body">First message (optional)</Label>
						<Textarea
							id="thread-body"
							placeholder="Add context or details…"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							rows={3}
							className="resize-none"
						/>
					</div>

					<div className="space-y-1.5">
						<Label>Visibility</Label>
						<div className="flex gap-2">
							{(['channel', 'private'] as const).map((v) => (
								<button
									key={v}
									type="button"
									className={cn(
										'px-3 py-1.5 text-sm rounded border transition-colors',
										visibility === v
											? 'border-accent bg-accent/10 text-accent'
											: 'border-border text-muted-foreground hover:text-foreground',
									)}
									onClick={() => setVisibility(v)}
								>
									{v.charAt(0).toUpperCase() + v.slice(1)}
								</button>
							))}
						</div>
					</div>

					<div className="flex justify-end gap-2 pt-2">
						<Button variant="outline" size="sm" onClick={onClose}>
							Cancel
						</Button>
						<Button
							size="sm"
							onClick={handleSubmit}
							disabled={!title.trim() || createThread.isPending}
						>
							{createThread.isPending ? 'Creating…' : 'Start thread'}
						</Button>
					</div>
				</div>
			</DialogContent>
		</Dialog>
	)
}

export { NewThreadDialog }
