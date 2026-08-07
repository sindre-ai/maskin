import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useConversation } from '@/hooks/use-conversation'
import { useUpdateConversationMe } from '@/hooks/use-conversations'
import { useIsMobile } from '@/hooks/use-mobile'
import { useNavigate } from '@tanstack/react-router'
import { Archive, ArchiveRestore, ArrowLeft, Copy, Pin, PinOff } from 'lucide-react'
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
			<h1 className="min-w-0 flex-1 truncate text-sm font-semibold">{conversation.title}</h1>
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
