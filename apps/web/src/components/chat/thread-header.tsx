import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversation } from '@/hooks/use-conversation'
import { useUpdateConversation, useUpdateConversationMe } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { cn } from '@/lib/cn'
import { useNavigate, useSearch } from '@tanstack/react-router'
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	Maximize2,
	Minimize2,
	Pin,
	Plus,
	X,
} from 'lucide-react'
import { useState } from 'react'
import { ParticipantsPopover } from './participants-popover'

interface ThreadHeaderProps {
	workspaceId: string
	conversationId: string
}

/**
 * Two stacked rows (mockup 559–612): the title row carries navigation and
 * window controls, the meta row carries the participants pill and the
 * pin/archive state toggles. A single row collapsed the title to a few pixels
 * at 768px once the fixed-width controls were laid out beside it.
 */
export function ThreadHeader({ workspaceId, conversationId }: ThreadHeaderProps) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const isMobile = useIsMobile()
	const navigate = useNavigate()
	const { wide } = useSearch({ from: '/_authed/$workspaceId/chats' })
	const updateMe = useUpdateConversationMe(workspaceId)
	const updateConversation = useUpdateConversation(workspaceId)
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

	if (!conversation) {
		return (
			<div className="flex h-12 shrink-0 items-center border-b border-border px-[var(--chat-gut)]" />
		)
	}

	const participants = conversation.participants
	const visibleAvatars = participants.slice(0, 3)
	const overflowCount = participants.length - visibleAvatars.length

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
				<span className="ml-auto" />
				<Tooltip>
					<TooltipTrigger asChild>
						<Button
							type="button"
							variant="ghost"
							size="icon"
							className={cn(
								'h-6 w-6 shrink-0',
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
							className="h-6 w-6 shrink-0"
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
