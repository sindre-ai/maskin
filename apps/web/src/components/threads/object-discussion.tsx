import { ActorAvatar } from '@/components/shared/actor-avatar'
import { EmptyState } from '@/components/shared/empty-state'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { useCreateThread, useThreads } from '@/hooks/use-threads'
import type { ThreadResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { useNavigate } from '@tanstack/react-router'
import { Check, MessageSquare, Plus } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'

interface ObjectDiscussionProps {
	objectId: string
}

export function ObjectDiscussion({ objectId }: ObjectDiscussionProps) {
	const { workspaceId } = useWorkspace()
	const navigate = useNavigate()
	const [newDialogOpen, setNewDialogOpen] = useState(false)

	const { data: threads, isLoading } = useThreads(workspaceId, {
		focus_object_id: objectId,
	})

	const openThreads = threads?.filter((t) => t.state === 'open' || t.state === 'waiting') ?? []
	const resolvedThreads =
		threads?.filter((t) => t.state === 'resolved' || t.state === 'archived') ?? []

	const openThread = (threadId: string) => {
		navigate({
			to: '/$workspaceId/threads',
			params: { workspaceId },
			search: { threadId, filter: 'all' },
		})
	}

	const threadCount = threads?.length ?? 0

	return (
		<div className="border-t border-border pt-6 mb-8">
			<div className="flex items-center justify-between mb-4">
				<h3 className="text-sm font-medium text-foreground">
					Discussion
					{threadCount > 0 && (
						<span className="ml-2 text-xs text-muted-foreground">({threadCount})</span>
					)}
				</h3>
				<Button
					variant="outline"
					size="sm"
					className="h-7 text-xs"
					onClick={() => setNewDialogOpen(true)}
				>
					<Plus size={13} className="mr-1" />
					Start a thread
				</Button>
			</div>

			{isLoading ? (
				<div className="space-y-2">
					{[1, 2].map((i) => (
						<div key={i} className="h-14 bg-muted/50 rounded animate-pulse" />
					))}
				</div>
			) : threadCount === 0 ? (
				<EmptyState
					title="No threads yet"
					description="Start a thread to discuss this object with your team or agents."
					action={
						<Button variant="outline" size="sm" onClick={() => setNewDialogOpen(true)}>
							<Plus size={13} className="mr-1" />
							Start a thread
						</Button>
					}
				/>
			) : (
				<div className="space-y-1">
					{openThreads.length > 0 && (
						<div className="space-y-1">
							{openThreads.map((thread) => (
								<ThreadSummaryRow
									key={thread.id}
									thread={thread}
									onClick={() => openThread(thread.id)}
								/>
							))}
						</div>
					)}

					{resolvedThreads.length > 0 && (
						<div className="space-y-1 mt-2">
							{openThreads.length > 0 && (
								<p className="text-[11px] text-muted-foreground mb-1 mt-3">Resolved</p>
							)}
							{resolvedThreads.map((thread) => (
								<ThreadSummaryRow
									key={thread.id}
									thread={thread}
									onClick={() => openThread(thread.id)}
								/>
							))}
						</div>
					)}
				</div>
			)}

			<NewObjectThreadDialog
				open={newDialogOpen}
				onClose={() => setNewDialogOpen(false)}
				workspaceId={workspaceId}
				objectId={objectId}
				onCreated={(threadId) => {
					setNewDialogOpen(false)
					openThread(threadId)
				}}
			/>
		</div>
	)
}

function ThreadSummaryRow({
	thread,
	onClick,
}: {
	thread: ThreadResponse
	onClick: () => void
}) {
	const isResolved = thread.state === 'resolved' || thread.state === 'archived'
	const participants = thread.participants ?? []

	return (
		<button
			type="button"
			onClick={onClick}
			className={cn(
				'w-full text-left flex items-center gap-3 rounded-md px-3 py-2 hover:bg-bg-hover transition-colors',
				isResolved && 'opacity-60',
			)}
		>
			<MessageSquare size={14} className={isResolved ? 'text-muted-foreground' : 'text-accent'} />

			<div className="flex-1 min-w-0">
				<span
					className={cn(
						'text-sm truncate block',
						isResolved
							? 'text-muted-foreground line-through decoration-muted-foreground'
							: 'text-foreground',
					)}
				>
					{thread.title}
				</span>
			</div>

			<div className="flex items-center gap-2 shrink-0">
				{/* Participant avatars */}
				{participants.length > 0 && (
					<div className="flex -space-x-1">
						{participants.slice(0, 3).map((p) => (
							<ActorAvatar
								key={p.actorId}
								name={p.actorId.slice(0, 1).toUpperCase()}
								type={p.kind}
								size="sm"
								className="ring-1 ring-background"
							/>
						))}
					</div>
				)}

				{isResolved ? (
					<Badge variant="secondary" className="text-[10px] h-4 px-1.5 gap-0.5">
						<Check size={10} />
						Resolved
					</Badge>
				) : (
					<Badge variant="outline" className="text-[10px] h-4 px-1.5 capitalize">
						{thread.state}
					</Badge>
				)}

				<RelativeTime date={thread.updatedAt} className="text-[11px] text-muted-foreground" />
			</div>
		</button>
	)
}

function NewObjectThreadDialog({
	open,
	onClose,
	workspaceId,
	objectId,
	onCreated,
}: {
	open: boolean
	onClose: () => void
	workspaceId: string
	objectId: string
	onCreated: (threadId: string) => void
}) {
	const createThread = useCreateThread(workspaceId)
	const [title, setTitle] = useState('')
	const [body, setBody] = useState('')

	const handleSubmit = () => {
		if (!title.trim()) return
		createThread.mutate(
			{
				title: title.trim(),
				body: body.trim() || undefined,
				visibility: 'channel',
				focusObjectId: objectId,
				kind: 'discussion',
			},
			{
				onSuccess: (thread) => {
					setTitle('')
					setBody('')
					onCreated(thread.id)
				},
				onError: () => toast.error('Failed to create thread'),
			},
		)
	}

	return (
		<Dialog open={open} onOpenChange={(o) => !o && onClose()}>
			<DialogContent className="sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>Start a thread</DialogTitle>
				</DialogHeader>

				<div className="space-y-4 mt-2">
					<div className="space-y-1.5">
						<Label htmlFor="obj-thread-title">Title</Label>
						<Input
							id="obj-thread-title"
							placeholder="What's this about?"
							value={title}
							onChange={(e) => setTitle(e.target.value)}
						/>
					</div>

					<div className="space-y-1.5">
						<Label htmlFor="obj-thread-body">First message (optional)</Label>
						<Textarea
							id="obj-thread-body"
							placeholder="Add context or details…"
							value={body}
							onChange={(e) => setBody(e.target.value)}
							rows={3}
							className="resize-none"
						/>
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
