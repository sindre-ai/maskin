import { ActorAvatar } from '@/components/shared/actor-avatar'
import type { ConversationParticipantResponse } from '@/lib/api'
import { Plus } from 'lucide-react'
import { ParticipantsPopover } from './participants-popover'

/** Stacked participant avatars that open the manage-participants popover. */
export function ParticipantsButton({
	workspaceId,
	conversationId,
	participants,
	createdBy,
}: {
	workspaceId: string
	conversationId: string
	participants: ConversationParticipantResponse[]
	createdBy: string
}) {
	const visibleAvatars = participants.slice(0, 3)
	const overflowCount = participants.length - visibleAvatars.length
	return (
		<ParticipantsPopover
			workspaceId={workspaceId}
			conversationId={conversationId}
			participants={participants}
			createdBy={createdBy}
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
					<span className="text-[10.5px] font-bold text-muted-foreground">+{overflowCount}</span>
				) : null}
				<Plus size={11} className="text-muted-foreground" aria-hidden />
			</button>
		</ParticipantsPopover>
	)
}
