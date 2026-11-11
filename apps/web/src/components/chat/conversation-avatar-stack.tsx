import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ConversationListItemResponse } from '@/lib/api'
import { cn } from '@/lib/cn'

type Participant = ConversationListItemResponse['participants'][number]

/** Plates drawn before the rest fold into the "+N" chip (the iPhone list draws two). */
export const AVATAR_STACK_CAP = 2

interface ConversationAvatarStackProps {
	/** Who the row is about, the viewer already left out. */
	participants: Participant[]
	className?: string
}

/**
 * The chat list's picture for a chat with several actors: two overlapping plates, each ringed in
 * the row's background so the overlap reads, and a "+N" chip for anyone beyond them. The iPhone
 * app draws the same cluster (`ConversationAvatar`). One actor is not a stack; the row draws that
 * actor's single plate.
 */
export function ConversationAvatarStack({ participants, className }: ConversationAvatarStackProps) {
	const shown = participants.slice(0, AVATAR_STACK_CAP)
	const extra = participants.length - shown.length
	return (
		<span
			aria-hidden
			data-avatar-stack
			className={cn('flex shrink-0 items-center -space-x-2', className)}
		>
			{shown.map((p) => (
				<ActorAvatar
					key={p.actorId}
					name={p.actorName}
					type={p.actorType}
					id={p.actorId}
					size="sm"
					className="size-[22px] rounded-[7px] text-[9px] font-bold ring-2 ring-background"
				/>
			))}
			{extra > 0 ? (
				<span
					data-avatar-stack-more
					className="relative grid h-[22px] min-w-[22px] place-items-center rounded-[7px] bg-secondary px-1 text-[9px] font-bold text-foreground ring-2 ring-background"
				>
					+{extra}
				</span>
			) : null}
		</span>
	)
}
