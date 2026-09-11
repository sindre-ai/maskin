import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import {
	flattenMessagesOldestFirst,
	useConversation,
	useConversationMessages,
} from '@/hooks/use-conversation'
import { useUpdateConversation, useUpdateConversationMe } from '@/hooks/use-conversations'
import { useLoop } from '@/hooks/use-loops'
import { useIsMobile } from '@/hooks/use-mobile'
import { trackNavItemClicked } from '@/lib/analytics'
import { cn } from '@/lib/cn'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	Copy,
	EyeOff,
	Maximize2,
	Minimize2,
	MoreHorizontal,
	Pin,
	Plus,
	X,
} from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ParticipantsPopover } from './participants-popover'

interface ThreadHeaderProps {
	workspaceId: string
	conversationId: string
}

const LOOP_CHIP_MAX = 24

/**
 * Two stacked rows (mockup 559–612): the title row carries navigation and
 * window controls, the meta row carries the participants pill and the
 * pin/archive state toggles. A single row collapsed the title to a few pixels
 * at 768px once the fixed-width controls were laid out beside it.
 */
export function ThreadHeader({ workspaceId, conversationId }: ThreadHeaderProps) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const messagesQuery = useConversationMessages(conversationId, workspaceId)
	const isMobile = useIsMobile()
	const navigate = useNavigate()
	const { wide } = useSearch({ from: '/_authed/$workspaceId/chats' })
	const updateMe = useUpdateConversationMe(workspaceId)
	const updateConversation = useUpdateConversation(workspaceId)
	const loopId = conversation?.loop_id ?? null
	const { data: loop } = useLoop(loopId ?? '', workspaceId)
	const [isEditingTitle, setIsEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState('')

	const handleClose = () => {
		navigate({ to: '/$workspaceId/chats', params: { workspaceId }, search: (prev) => prev })
	}

	const toggleWide = () => {
		navigate({
			to: '/$workspaceId/chats/$conversationId',
			params: { workspaceId, conversationId },
			search: (prev: { wide?: boolean }) => ({ ...prev, wide: prev.wide ? undefined : true }),
		})
	}

	const startEditingTitle = () => {
		if (!conversation) return
		setTitleDraft(conversation.title)
		setIsEditingTitle(true)
	}

	const commitTitle = () => {
		const next = titleDraft.trim()
		setIsEditingTitle(false)
		if (!conversation || next.length === 0 || next === conversation.title) return
		updateConversation.mutate({ id: conversationId, data: { title: next } })
	}

	const handleLoopChipClick = () => {
		if (!loopId) return
		trackNavItemClicked({ item_key: 'loop_chip', source: 'top-nav' })
		navigate({
			to: '/$workspaceId/loops/$loopId',
			params: { workspaceId, loopId },
		})
	}

	const handleCopyConversation = async () => {
		trackNavItemClicked({ item_key: 'copy_conversation', source: 'top-nav' })
		const messages = flattenMessagesOldestFirst(messagesQuery.data).filter(
			// User + agent turns only — system rows (resume banners, activity, etc.)
			// aren't part of the copied transcript. `kind === 'message'` is the
			// server-side guard on chat turns.
			(m) => m.kind === 'message' && (m.actorType === 'human' || m.actorType === 'agent'),
		)
		const text = messages.map((m) => `${m.actorName}: ${m.content}`).join('\n\n')
		try {
			await navigator.clipboard.writeText(text)
			toast.success(`Copied ${messages.length} messages`)
		} catch {
			toast.error('Failed to copy conversation')
		}
	}

	const handleMarkUnread = () => {
		trackNavItemClicked({ item_key: 'mark_unread', source: 'top-nav' })
		updateMe.mutate(
			{ id: conversationId, data: { last_read_message_id: 0 } },
			{
				onSuccess: () => toast.success('Marked as unread'),
				onError: () => toast.error('Failed to mark as unread'),
			},
		)
	}

	if (!conversation) {
		return (
			<div className="flex h-12 shrink-0 items-center border-b border-border px-[var(--chat-gut)]" />
		)
	}

	const participants = conversation.participants
	const visibleAvatars = participants.slice(0, 3)
	const overflowCount = participants.length - visibleAvatars.length
	const loopName = loop?.name ?? null
	const loopLabel = loopName
		? loopName.length > LOOP_CHIP_MAX
			? `${loopName.slice(0, LOOP_CHIP_MAX - 1)}…`
			: loopName
		: null

	return (
		<div className="flex shrink-0 flex-col gap-1 border-b border-border px-[var(--chat-gut)] pt-2 pb-1.5">
			<div className="flex items-start gap-2.5">
				{isMobile ? (
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="-ml-1 h-7 w-7 shrink-0"
						onClick={handleClose}
						aria-label="Back to conversations"
					>
						<ArrowLeft size={16} />
					</Button>
				) : null}
				{isEditingTitle ? (
					<Input
						autoFocus
						value={titleDraft}
						onChange={(e) => setTitleDraft(e.target.value)}
						onBlur={commitTitle}
						onKeyDown={(e) => {
							if (e.key === 'Enter') {
								e.preventDefault()
								commitTitle()
							} else if (e.key === 'Escape') {
								e.preventDefault()
								setIsEditingTitle(false)
							}
						}}
						maxLength={200}
						aria-label="Conversation title"
						className="h-7 min-w-0 flex-1 text-[13px] font-bold"
					/>
				) : (
					// The title *is* the rename affordance (mockup 311 draws no
					// pencil beside it) — a dedicated icon button pushed the title
					// into a third of the row at 768px and duplicated a target the
					// heading can carry itself.
					<h2 className="min-w-0 flex-1">
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={startEditingTitle}
									aria-label={`Rename conversation — ${conversation.title}`}
									className="w-full rounded-md px-1 py-0.5 text-left line-clamp-2 text-[13px] font-bold leading-[1.35] tracking-[-0.01em] text-balance hover:bg-accent"
								>
									{conversation.title}
								</button>
							</TooltipTrigger>
							<TooltipContent>Rename</TooltipContent>
						</Tooltip>
					</h2>
				)}
				{isMobile ? null : (
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-6 w-6 shrink-0"
								onClick={toggleWide}
								aria-label={wide ? 'Show conversation list' : 'Hide conversation list'}
								aria-pressed={!!wide}
							>
								{wide ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
							</Button>
						</TooltipTrigger>
						<TooltipContent>{wide ? 'Exit focus mode' : 'Focus mode'}</TooltipContent>
					</Tooltip>
				)}
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-6 w-6 shrink-0"
							onClick={handleClose}
							aria-label="Close conversation"
						>
							<X size={14} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>Close conversation</TooltipContent>
				</Tooltip>
			</div>
			<div className="flex flex-wrap items-center gap-2">
				<ParticipantsPopover
					workspaceId={workspaceId}
					conversationId={conversationId}
					participants={participants}
					createdBy={conversation.createdBy}
				>
					<button
						type="button"
						className="inline-flex h-[22px] shrink-0 items-center gap-1.5 rounded-full px-1.5 hover:bg-accent"
						aria-label={`${participants.length} participants — manage`}
					>
						<span className="flex items-center -space-x-1.5">
							{visibleAvatars.map((p) => (
								<ActorAvatar
									key={p.actorId}
									id={p.actorId}
									name={p.actorName}
									type={p.actorType}
									size="sm"
									className="ring-2 ring-background"
								/>
							))}
						</span>
						{overflowCount > 0 ? (
							<span className="text-[10.5px] font-bold text-muted-foreground">
								+{overflowCount}
							</span>
						) : null}
						<Plus size={11} className="text-muted-foreground" aria-hidden />
					</button>
				</ParticipantsPopover>
				{loopId && loopLabel ? (
					<Tooltip>
						<TooltipTrigger asChild>
							<button
								type="button"
								onClick={handleLoopChipClick}
								aria-label={`Loop: ${loopName ?? loopLabel}`}
								className="inline-flex h-[22px] shrink-0 items-center rounded-full border border-border bg-card px-2 text-[11px] font-semibold text-foreground hover:border-[color:var(--border-strong)] hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
							>
								{loopLabel}
							</button>
						</TooltipTrigger>
						<TooltipContent>{loopName ?? loopLabel}</TooltipContent>
					</Tooltip>
				) : null}
				<span className="ml-auto" />
				{/* At ≤640px, Copy · Pin · Mark-unread · Archive collapse into a
				    ⋯ menu; Focus + Close stay inline (v4 spec). */}
				<DropdownMenu>
					<DropdownMenuTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="h-6 w-6 shrink-0 min-[641px]:hidden"
							aria-label="More actions"
						>
							<MoreHorizontal size={14} />
						</Button>
					</DropdownMenuTrigger>
					<DropdownMenuContent align="end">
						<DropdownMenuItem onSelect={handleCopyConversation}>
							<Copy size={14} />
							<span>Copy whole conversation</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() =>
								updateMe.mutate({
									id: conversationId,
									data: { pinned: !conversation.pinned },
								})
							}
						>
							<Pin size={14} fill={conversation.pinned ? 'currentColor' : 'none'} />
							<span>{conversation.pinned ? 'Unpin' : 'Pin'}</span>
						</DropdownMenuItem>
						<DropdownMenuItem onSelect={handleMarkUnread}>
							<EyeOff size={14} />
							<span>Mark as unread</span>
						</DropdownMenuItem>
						<DropdownMenuItem
							onSelect={() =>
								updateMe.mutate({
									id: conversationId,
									data: { archived: !conversation.archived },
								})
							}
						>
							{conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
							<span>{conversation.archived ? 'Unarchive' : 'Archive'}</span>
						</DropdownMenuItem>
					</DropdownMenuContent>
				</DropdownMenu>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="hidden h-6 w-6 shrink-0 min-[641px]:inline-flex"
							onClick={handleCopyConversation}
							aria-label="Copy whole conversation"
						>
							<Copy size={14} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>Copy whole conversation</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={cn(
								'hidden h-6 w-6 shrink-0 min-[641px]:inline-flex',
								// Pinned is a *state*, so it holds an indigo plate rather
								// than swapping to a different glyph (mockup 7804–7806).
								// PinOff read as "this button unpins" — i.e. as the action,
								// not the current state — which is the wrong tense for a toggle.
								conversation.pinned &&
									'bg-brand-subtle text-brand-subtle-foreground hover:bg-brand-subtle',
							)}
							onClick={() =>
								updateMe.mutate({ id: conversationId, data: { pinned: !conversation.pinned } })
							}
							aria-label={conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
							aria-pressed={conversation.pinned}
						>
							<Pin size={14} fill={conversation.pinned ? 'currentColor' : 'none'} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>{conversation.pinned ? 'Unpin' : 'Pin'}</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="hidden h-6 w-6 shrink-0 min-[641px]:inline-flex"
							onClick={handleMarkUnread}
							aria-label="Mark as unread"
						>
							<EyeOff size={14} />
						</Button>
					</TooltipTrigger>
					<TooltipContent>Mark as unread</TooltipContent>
				</Tooltip>
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className="hidden h-6 w-6 shrink-0 min-[641px]:inline-flex"
							onClick={() =>
								updateMe.mutate({ id: conversationId, data: { archived: !conversation.archived } })
							}
							aria-label={conversation.archived ? 'Unarchive conversation' : 'Archive conversation'}
							aria-pressed={conversation.archived}
						>
							{conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
						</Button>
					</TooltipTrigger>
					<TooltipContent>{conversation.archived ? 'Unarchive' : 'Archive'}</TooltipContent>
				</Tooltip>
			</div>
		</div>
	)
}
