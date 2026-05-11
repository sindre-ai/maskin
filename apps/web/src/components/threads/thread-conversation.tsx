import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ListSkeleton } from '@/components/shared/loading-skeleton'
import { MarkdownContent } from '@/components/shared/markdown-content'
import { RelativeTime } from '@/components/shared/relative-time'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import { SheetHeader, SheetTitle } from '@/components/ui/sheet'
import { Spinner } from '@/components/ui/spinner'
import { Textarea } from '@/components/ui/textarea'
import { useActors } from '@/hooks/use-actors'
import {
	useCreateThread,
	usePostThreadEvent,
	useRemoveThreadParticipant,
	useResolveThread,
	useThread,
	useThreadEventStream,
	useUpdateThread,
} from '@/hooks/use-threads'
import type { ActorListItem, ThreadEventResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { queryKeys } from '@/lib/query-keys'
import { useQueryClient } from '@tanstack/react-query'
import { Archive, Check, Send, X } from 'lucide-react'
import { type KeyboardEvent, useEffect, useMemo, useRef, useState } from 'react'
import { toast } from 'sonner'
import { ParticipantPicker } from './participant-picker'

const KIND_LABELS: Record<string, string> = {
	needs_input: 'Needs input',
	alert: 'Alert',
	recommendation: 'Recommendation',
	good_news: 'Good news',
	fyi: 'FYI',
	discussion: 'Discussion',
	conversation: 'Conversation',
}

interface ThreadConversationProps {
	threadId: string
	workspaceId: string
	onClose: () => void
	onThreadCreated: (id: string) => void
}

export function ThreadConversation({
	threadId,
	workspaceId,
	onClose,
	onThreadCreated,
}: ThreadConversationProps) {
	const isComposing = threadId === 'new'

	// Composing mode state
	const [participants, setParticipants] = useState<ActorListItem[]>([])
	const [visibility, setVisibility] = useState<'channel' | 'private'>('private')

	// Active mode state
	const { data: thread, isLoading } = useThread(workspaceId, isComposing ? null : threadId)
	const { data: actors } = useActors(workspaceId)
	const actorsById = useMemo(() => {
		const map = new Map<string, ActorListItem>()
		for (const actor of actors ?? []) map.set(actor.id, actor)
		return map
	}, [actors])

	const createThread = useCreateThread(workspaceId)
	const postEvent = usePostThreadEvent(workspaceId, isComposing ? '' : threadId)
	const resolveThread = useResolveThread(workspaceId, isComposing ? '' : threadId)
	const archiveThread = useUpdateThread(workspaceId, isComposing ? '' : threadId)
	const removeParticipant = useRemoveThreadParticipant(workspaceId, isComposing ? '' : threadId)
	const queryClient = useQueryClient()

	const [showResolveDialog, setShowResolveDialog] = useState(false)
	const [resolution, setResolution] = useState('')
	const scrollRef = useRef<HTMLDivElement>(null)
	const currentActorId = getStoredActor()?.id

	// SSE stream for live event updates (active mode only)
	useThreadEventStream(isComposing ? null : threadId, workspaceId, () => {})

	const eventsCount = thread?.events?.length ?? 0

	// Auto-scroll to bottom when events change
	// biome-ignore lint/correctness/useExhaustiveDependencies: scroll on event count change only
	useEffect(() => {
		if (scrollRef.current) {
			scrollRef.current.scrollTop = scrollRef.current.scrollHeight
		}
	}, [eventsCount])

	const handleFirstSend = (body: string) => {
		const autoTitle = body.trim().split('\n')[0].slice(0, 60)
		createThread.mutate(
			{
				title: autoTitle,
				body: body.trim(),
				visibility,
				kind: 'conversation',
				participantIds: participants.map((a) => a.id),
			},
			{
				onSuccess: (created) => {
					// Seed cache to avoid loading flash during composing → active transition
					queryClient.setQueryData(queryKeys.threads.detail(created.id), {
						...created,
						events: [],
					})
					onThreadCreated(created.id)
				},
				onError: () => toast.error('Failed to start conversation'),
			},
		)
	}

	const handleReply = (body: string) => {
		const mentionIds = extractMentionIds(body, thread?.participants ?? [], actorsById)
		postEvent.mutate(
			{
				kind: 'message',
				body,
				...(mentionIds.length > 0 ? { mentions: mentionIds } : {}),
			},
			{ onError: () => toast.error('Failed to send message') },
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

	const isOpen = !isComposing && (thread?.state === 'open' || thread?.state === 'waiting')

	return (
		<>
			{/* Header */}
			<SheetHeader className="px-4 pt-4 pb-3 border-b border-border shrink-0">
				<div className="flex items-start justify-between gap-2">
					<div className="flex-1 min-w-0">
						{isComposing ? (
							<>
								<SheetTitle className="text-base leading-snug mb-3">New conversation</SheetTitle>

								{/* To: field */}
								<div className="flex items-start gap-2">
									<span className="text-sm text-muted-foreground shrink-0 mt-1.5">To:</span>
									<div className="flex-1 min-w-0">
										<ParticipantPicker
											workspaceId={workspaceId}
											selected={participants}
											onAdd={(actor) => setParticipants((prev) => [...prev, actor])}
											onRemove={(id) => setParticipants((prev) => prev.filter((a) => a.id !== id))}
										/>
									</div>
								</div>

								{/* Visibility toggle */}
								<div className="flex items-center gap-2 mt-2">
									{(['private', 'channel'] as const).map((v) => (
										<button
											key={v}
											type="button"
											className={cn(
												'px-2.5 py-0.5 text-xs rounded border transition-colors',
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
							</>
						) : (
							<>
								<SheetTitle className="text-base leading-snug truncate">
									{thread?.title ?? 'Thread'}
								</SheetTitle>
								<div className="flex items-center gap-2 mt-1 flex-wrap">
									{thread && (
										<Badge variant="outline" className="text-[10px] h-4">
											{KIND_LABELS[thread.kind] ?? thread.kind}
										</Badge>
									)}
									{thread && thread.state !== 'open' && (
										<Badge variant="secondary" className="text-[10px] h-4 capitalize">
											{thread.state}
										</Badge>
									)}
									{/* Participant avatars */}
									{thread?.participants && thread.participants.length > 0 && (
										<div className="flex -space-x-1">
											{thread.participants.slice(0, 5).map((p) => {
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
											{thread.participants.length > 5 && (
												<span className="text-[10px] text-muted-foreground ml-1 self-center">
													+{thread.participants.length - 5}
												</span>
											)}
										</div>
									)}
								</div>
							</>
						)}
					</div>
					<button
						type="button"
						onClick={onClose}
						className="shrink-0 text-muted-foreground hover:text-foreground transition-colors mt-1"
					>
						<X size={16} />
					</button>
				</div>
			</SheetHeader>

			{/* Message area */}
			<div ref={scrollRef} className="flex-1 overflow-y-auto px-4 py-3 space-y-3 min-h-0">
				{isComposing ? (
					<div className="flex h-full items-center justify-center text-sm text-muted-foreground">
						{participants.length === 0
							? 'Add people above to start a conversation.'
							: 'Type a message below to begin.'}
					</div>
				) : isLoading ? (
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

			{/* Participants management (active mode only) */}
			{!isComposing && thread?.participants && thread.participants.length > 0 && (
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

			{/* Resolution note (active mode) */}
			{!isComposing && thread?.resolution && (
				<div className="px-4 py-2 bg-bg-surface border-t border-border shrink-0">
					<p className="text-xs text-muted-foreground">
						<Check size={11} className="inline mr-1" />
						{thread.resolution}
					</p>
				</div>
			)}

			{/* Actions bar (active mode, open threads only) */}
			{isOpen && (
				<div className="px-4 py-2 border-t border-border flex items-center gap-2 shrink-0">
					<Button
						variant="outline"
						size="sm"
						onClick={() => setShowResolveDialog(true)}
						disabled={resolveThread.isPending}
					>
						<Check size={13} className="mr-1" />
						Resolve
					</Button>
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
				</div>
			)}

			{/* Composer */}
			{(isComposing || isOpen) && (
				<div className="px-4 pb-4 pt-2 border-t border-border shrink-0">
					<ThreadComposer
						onSend={isComposing ? handleFirstSend : handleReply}
						pending={createThread.isPending || postEvent.isPending}
						disabled={isComposing && participants.length === 0}
						placeholder={
							isComposing
								? participants.length === 0
									? 'Add recipients above first…'
									: 'Start a conversation… (Enter to send)'
								: 'Reply… (Enter to send)'
						}
					/>
				</div>
			)}

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
		</>
	)
}

interface ThreadComposerProps {
	onSend: (body: string) => void
	pending: boolean
	disabled?: boolean
	placeholder?: string
}

function ThreadComposer({ onSend, pending, disabled, placeholder }: ThreadComposerProps) {
	const [value, setValue] = useState('')
	const canSend = value.trim().length > 0 && !disabled && !pending

	const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
		if (e.key !== 'Enter') return
		if (e.shiftKey) return
		if (e.nativeEvent.isComposing) return
		e.preventDefault()
		if (!canSend) return
		onSend(value.trim())
		setValue('')
	}

	const handleSend = () => {
		if (!canSend) return
		onSend(value.trim())
		setValue('')
	}

	return (
		<div className="relative flex flex-col gap-1 rounded-md border border-border bg-bg-surface p-2 shadow-sm">
			<Textarea
				autoResize
				value={value}
				onChange={(e) => setValue(e.target.value)}
				onKeyDown={handleKeyDown}
				placeholder={placeholder ?? 'Message… (Enter to send)'}
				className="max-h-40 min-h-[36px] w-full resize-none overflow-y-auto border-0 bg-transparent p-1 text-sm focus-visible:ring-0 focus-visible:ring-offset-0"
				disabled={disabled}
				rows={1}
			/>
			<div className="flex justify-end">
				<Button
					type="button"
					size="icon"
					variant="ghost"
					onClick={handleSend}
					disabled={!canSend}
					aria-label="Send message"
				>
					{pending ? <Spinner /> : <Send size={16} />}
				</Button>
			</div>
		</div>
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
					<MarkdownContent
						content={event.body}
						size="sm"
						className="[&_p]:!text-foreground [&_li]:!text-foreground"
					/>
				)}
			</div>
		</div>
	)
}

function extractMentionIds(
	text: string,
	participants: { actorId: string }[],
	actorsById: Map<string, ActorListItem>,
): string[] {
	if (!text.includes('@')) return []
	const ids: string[] = []
	for (const p of participants) {
		const actor = actorsById.get(p.actorId)
		if (!actor) continue
		if (text.toLowerCase().includes(`@${actor.name.toLowerCase()}`)) {
			ids.push(p.actorId)
		}
	}
	return ids
}
