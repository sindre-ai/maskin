import { AgentCallButton } from '@/components/agents/agent-call-button'
import { LiveCapsule } from '@/components/agents/live-call-surface'
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
import { useActiveSessionsForConversation } from '@/hooks/use-sessions'
import { ACTIVE_STATUSES } from '@/lib/agent-status'
import { trackNavItemClicked } from '@/lib/analytics'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useVoiceCallView } from '@/lib/voice-call-view'
import { Link, useNavigate, useSearch } from '@tanstack/react-router'
import {
	Archive,
	ArchiveRestore,
	ArrowLeft,
	Copy,
	EyeOff,
	Maximize2,
	Minimize2,
	MoreHorizontal,
	PanelRight,
	Pencil,
	Pin,
	X,
} from 'lucide-react'
import { useMemo, useState } from 'react'
import { toast } from 'sonner'
import { ParticipantsPopover } from './participants-popover'

interface ThreadHeaderProps {
	workspaceId: string
	conversationId: string
	/** Right-rail Overview (Threads + Produced tabs). The toggle mounts iff the
	 *  route passes a handler, which it does when either tab's flag is on. */
	overviewOpen?: boolean
	/** Something changed since the Overview was last open: pulses a dot. */
	overviewHasNew?: boolean
	onToggleOverview?: () => void
}

const LOOP_CHIP_MAX = 24

/**
 * Two stacked rows (mockup 559–612): the title row carries navigation and
 * window controls, the meta row carries the participants pill and the
 * pin/archive state toggles. A single row collapsed the title to a few pixels
 * at 768px once the fixed-width controls were laid out beside it.
 */
export function ThreadHeader({
	workspaceId,
	conversationId,
	overviewOpen = false,
	overviewHasNew = false,
	onToggleOverview,
}: ThreadHeaderProps) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const messagesQuery = useConversationMessages(conversationId, workspaceId)
	const isMobile = useIsMobile()
	const navigate = useNavigate()
	const { wide } = useSearch({ from: '/_authed/$workspaceId/chats' })
	const updateMe = useUpdateConversationMe(workspaceId)
	const updateConversation = useUpdateConversation(workspaceId)
	const loopId = conversation?.loop_id ?? null
	// Call mounts only for a thread with exactly one agent participant: a
	// multi-agent call is v2, and with two agents there is no single agent for
	// the button to mean.
	const voiceAgent = useMemo(() => {
		const agents = (conversation?.participants ?? []).filter((p) => p.actorType === 'agent')
		const only = agents.length === 1 ? agents[0] : null
		return only ? { id: only.actorId, name: only.actorName, type: only.actorType } : null
	}, [conversation?.participants])
	// The one agent of a one-agent chat, whose page the title opens.
	const singleAgent = useMemo(() => {
		const agents = (conversation?.participants ?? []).filter((p) => p.actorType === 'agent')
		return agents.length === 1 ? (agents[0] ?? null) : null
	}, [conversation?.participants])
	const liveCall = useVoiceCallView()
	const { data: loop } = useLoop(loopId ?? '', workspaceId)
	const { data: sessions } = useActiveSessionsForConversation(workspaceId, conversationId)
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
			{ id: conversationId, data: { mark_unread: true } },
			{
				onSuccess: () => toast.success('Marked as unread'),
				onError: () => toast.error('Failed to mark as unread'),
			},
		)
	}

	if (!conversation) {
		return <div className="flex h-12 shrink-0 items-center px-[var(--chat-gut)]" />
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

	// "Strategist, Developer and you": everyone but the viewer by name, then "you".
	// The tile counts the agents in the room, or shows the one agent's initials.
	const self = getStoredActor()
	const others = participants.filter((p) => p.actorId !== self?.id)
	const includesSelf = participants.some((p) => p.actorId === self?.id)
	const names = others.map((p) => p.actorName)
	const roster = includesSelf
		? names.length > 0
			? `${names.join(', ')} and you`
			: 'You'
		: names.join(', ')
	const agentCount = participants.filter((p) => p.actorType === 'agent').length
	const tileLabel = String(agentCount || participants.length)
	const working = new Set(
		(sessions ?? []).filter((x) => ACTIVE_STATUSES.has(x.status)).map((x) => x.actorId),
	).size
	const iconButton =
		'size-8 shrink-0 rounded-full bg-secondary text-foreground hover:bg-secondary/70'

	return (
		<div className="flex min-h-[69px] shrink-0 flex-wrap items-center gap-x-3 gap-y-1 lg:flex-nowrap py-2 pr-4 pl-[var(--chat-gut)] md:pr-6">
			{/* Below lg the thread replaces the list, so the way back is always there. */}
			<Button
				type="button"
				variant="ghost"
				size="icon"
				className="-ml-2 size-8 shrink-0 lg:hidden"
				onClick={handleClose}
				aria-label="Back to conversations"
			>
				<ArrowLeft size={16} />
			</Button>
			<span className="hidden shrink-0 lg:block">
				{singleAgent ? (
					<ActorAvatar
						name={singleAgent.actorName}
						type="agent"
						id={singleAgent.actorId}
						size="md"
						className="size-[34px]"
					/>
				) : (
					<span
						aria-hidden
						className="grid size-[34px] place-items-center rounded-[10px] bg-secondary text-xs font-bold text-foreground"
					>
						{tileLabel}
					</span>
				)}
			</span>
			<div className="min-w-[10rem] flex-1">
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
						className="h-7 min-w-0 text-base font-semibold"
					/>
				) : (
					<h2 className="truncate text-base font-semibold leading-tight">
						{singleAgent ? (
							// A chat with one agent is that agent's chat: the title opens its page.
							<Link
								to="/$workspaceId/agents/$agentId"
								params={{ workspaceId, agentId: singleAgent.actorId }}
								aria-label={`Open ${singleAgent.actorName} — ${conversation.title}`}
								className="hover:underline"
							>
								{conversation.title}
							</Link>
						) : (
							conversation.title
						)}
					</h2>
				)}
				<div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
					<ParticipantsPopover
						workspaceId={workspaceId}
						conversationId={conversationId}
						participants={participants}
						createdBy={conversation.createdBy}
					>
						<button
							type="button"
							className="min-w-0 truncate text-left hover:text-foreground"
							aria-label={`${participants.length} participants — manage`}
						>
							{roster}
						</button>
					</ParticipantsPopover>
					{working > 0 ? (
						<span className="shrink-0 font-semibold text-success">{working} working</span>
					) : null}
					{loopId && loopLabel ? (
						<Tooltip>
							<TooltipTrigger asChild>
								<button
									type="button"
									onClick={handleLoopChipClick}
									aria-label={`Flow: ${loopName ?? loopLabel}`}
									className="hidden h-[22px] shrink-0 items-center rounded-full border border-border bg-card px-2 text-[11px] font-semibold text-foreground hover:border-[color:var(--border-strong)] hover:text-brand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:inline-flex"
								>
									{loopLabel}
								</button>
							</TooltipTrigger>
							<TooltipContent>{loopName ?? loopLabel}</TooltipContent>
						</Tooltip>
					) : null}
				</div>
			</div>
			{liveCall ? (
				<LiveCapsule />
			) : voiceAgent ? (
				isMobile ? (
					<AgentCallButton agent={voiceAgent} variant="icon" />
				) : (
					<AgentCallButton agent={voiceAgent} variant="thread" tooltip="Talk live with this chat" />
				)
			) : null}
			<DropdownMenu>
				<DropdownMenuTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className={iconButton}
						aria-label="More actions"
					>
						<MoreHorizontal size={16} />
					</Button>
				</DropdownMenuTrigger>
				<DropdownMenuContent align="end">
					<DropdownMenuItem onSelect={startEditingTitle}>
						<Pencil size={14} />
						<span>Rename conversation</span>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={handleCopyConversation}>
						<Copy size={14} />
						<span>Copy whole conversation</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							updateMe.mutate({ id: conversationId, data: { pinned: !conversation.pinned } })
						}
					>
						<Pin size={14} fill={conversation.pinned ? 'currentColor' : 'none'} />
						<span>{conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}</span>
					</DropdownMenuItem>
					<DropdownMenuItem onSelect={handleMarkUnread}>
						<EyeOff size={14} />
						<span>Mark as unread</span>
					</DropdownMenuItem>
					<DropdownMenuItem
						onSelect={() =>
							updateMe.mutate({ id: conversationId, data: { archived: !conversation.archived } })
						}
					>
						{conversation.archived ? <ArchiveRestore size={14} /> : <Archive size={14} />}
						<span>{conversation.archived ? 'Unarchive conversation' : 'Archive conversation'}</span>
					</DropdownMenuItem>
					{isMobile ? null : (
						<DropdownMenuItem onSelect={toggleWide} className="max-lg:hidden">
							{wide ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
							<span>{wide ? 'Show conversation list' : 'Hide conversation list'}</span>
						</DropdownMenuItem>
					)}
					<DropdownMenuItem onSelect={handleClose}>
						<X size={14} />
						<span>Close conversation</span>
					</DropdownMenuItem>
				</DropdownMenuContent>
			</DropdownMenu>
			{/* Overview toggle: one entry point for the right rail's Threads and
			    Produced tabs. The dot pulses while something has changed since the
			    pane was last open — a handoff started or finished, a new output. */}
			{onToggleOverview ? (
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={onToggleOverview}
							aria-pressed={overviewOpen}
							aria-label={overviewOpen ? 'Close Overview' : 'Open Overview'}
							className={cn(
								'relative inline-flex items-center justify-center transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
								iconButton,
								overviewOpen &&
									'bg-brand-subtle text-brand-subtle-foreground hover:bg-brand-subtle',
							)}
						>
							<PanelRight size={16} aria-hidden />
							{overviewHasNew ? (
								<output className="absolute top-1 right-1 flex h-2 w-2" aria-label="New activity">
									<span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-brand opacity-75 motion-reduce:animate-none" />
									<span className="relative inline-flex h-2 w-2 rounded-full bg-brand" />
								</output>
							) : null}
						</button>
					</TooltipTrigger>
					<TooltipContent>
						{overviewOpen ? 'Hide Overview' : 'Show Overview · press P'}
					</TooltipContent>
				</Tooltip>
			) : null}
		</div>
	)
}
