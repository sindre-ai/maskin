import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversation } from '@/hooks/use-conversation'
import { useUpdateConversation, useUpdateConversationMe } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArchiveRestore, ArrowLeft, Copy, Pencil, Pin, PinOff } from 'lucide-react'
import { useState } from 'react'
import { toast } from 'sonner'
import { ParticipantsPopover } from './participants-popover'

interface ThreadHeaderProps {
	workspaceId: string
	conversationId: string
}

export function ThreadHeader({ workspaceId, conversationId }: ThreadHeaderProps) {
	const { data: conversation } = useConversation(conversationId, workspaceId)
	const isMobile = useIsMobile()
	const navigate = useNavigate()
	const updateMe = useUpdateConversationMe(workspaceId)
	const updateConversation = useUpdateConversation(workspaceId)
	const [isEditingTitle, setIsEditingTitle] = useState(false)
	const [titleDraft, setTitleDraft] = useState('')

	const handleBack = () => {
		navigate({ to: '/$workspaceId/chats', params: { workspaceId } })
	}

	const handleCopyLink = async () => {
		try {
			await navigator.clipboard.writeText(window.location.href)
			toast.success('Link copied')
		} catch {
			toast.error('Could not copy link')
		}
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
		return <div className="flex h-12 shrink-0 items-center border-b border-border px-3" />
	}

	const participants = conversation.participants
	const visibleAvatars = participants.slice(0, 3)
	const overflowCount = participants.length - visibleAvatars.length

	return (
		<div className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-3">
			{isMobile ? (
				<Button
					type="button"
					variant="ghost"
					size="icon"
					className="-ml-1 h-7 w-7"
					onClick={handleBack}
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
					className="h-7 min-w-0 flex-1 text-sm font-semibold"
				/>
			) : (
				<>
					<h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{conversation.title}</h1>
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon"
								className="h-7 w-7"
								onClick={startEditingTitle}
								aria-label="Rename conversation"
							>
								<Pencil size={14} />
							</Button>
						</TooltipTrigger>
						<TooltipContent>Rename</TooltipContent>
					</Tooltip>
				</>
			)}
			<ParticipantsPopover
				workspaceId={workspaceId}
				conversationId={conversationId}
				participants={participants}
			>
				<button
					type="button"
					className="flex items-center -space-x-1.5 rounded-full hover:opacity-80"
					aria-label={`${participants.length} participants — manage`}
				>
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
					{overflowCount > 0 ? (
						<span className="flex h-5 w-5 items-center justify-center rounded-full bg-bg-surface text-[10px] font-medium text-muted-foreground ring-2 ring-background">
							+{overflowCount}
						</span>
					) : null}
				</button>
			</ParticipantsPopover>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						onClick={() =>
							updateMe.mutate({ id: conversationId, data: { pinned: !conversation.pinned } })
						}
						aria-label={conversation.pinned ? 'Unpin conversation' : 'Pin conversation'}
						aria-pressed={conversation.pinned}
					>
						{conversation.pinned ? <PinOff size={15} /> : <Pin size={15} />}
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
						className="h-7 w-7"
						onClick={() =>
							updateMe.mutate({ id: conversationId, data: { archived: !conversation.archived } })
						}
						aria-label={conversation.archived ? 'Unarchive conversation' : 'Archive conversation'}
						aria-pressed={conversation.archived}
					>
						{conversation.archived ? <ArchiveRestore size={15} /> : <Archive size={15} />}
					</Button>
				</TooltipTrigger>
				<TooltipContent>{conversation.archived ? 'Unarchive' : 'Archive'}</TooltipContent>
			</Tooltip>
			<Tooltip>
				<TooltipTrigger asChild>
					<Button
						type="button"
						variant="ghost"
						size="icon"
						className="h-7 w-7"
						onClick={() => void handleCopyLink()}
						aria-label="Copy link"
					>
						<Copy size={15} />
					</Button>
				</TooltipTrigger>
				<TooltipContent>Copy link</TooltipContent>
			</Tooltip>
		</div>
	)
}
