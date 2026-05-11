import { PageHeader } from '@/components/layout/page-header'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { RelativeTime } from '@/components/shared/relative-time'
import { RouteError } from '@/components/shared/route-error'
import { ThreadConversation } from '@/components/threads/thread-conversation'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Sheet, SheetContent } from '@/components/ui/sheet'
import { useActors } from '@/hooks/use-actors'
import { useThreads } from '@/hooks/use-threads'
import type { ActorListItem, ThreadResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { createFileRoute, useNavigate, useSearch } from '@tanstack/react-router'
import { Check, Plus } from 'lucide-react'
import { useMemo } from 'react'

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
					<Button size="sm" onClick={() => selectThread('new')}>
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
							<Button size="sm" onClick={() => selectThread('new')}>
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

			{/* Unified conversation panel (new thread + existing thread detail) */}
			<Sheet open={!!selectedThreadId} onOpenChange={(open) => !open && selectThread(undefined)}>
				<SheetContent className="w-full sm:max-w-xl p-0 flex flex-col">
					{selectedThreadId && (
						<ThreadConversation
							threadId={selectedThreadId}
							workspaceId={workspaceId}
							onClose={() => selectThread(undefined)}
							onThreadCreated={(id) => selectThread(id)}
						/>
					)}
				</SheetContent>
			</Sheet>
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

// Re-export ThreadEventItem for backward compatibility with tests
export { ThreadEventItem } from '@/components/threads/thread-conversation'
