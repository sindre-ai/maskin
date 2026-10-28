import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import type { ReplyThreadSummary } from '@/lib/api'
import { cn } from '@/lib/cn'
import { replyPillLabel } from '@/lib/message-threads'

interface MessageThreadPillProps {
	summary: ReplyThreadSummary
	onOpen: () => void
	/** Right-aligned under the person's own message. */
	own?: boolean
	className?: string
}

/**
 * The "N replies" chip under a message that has a reply thread: who has replied,
 * how many, and whether any are new. Opens the thread pane.
 */
export function MessageThreadPill({
	summary,
	onOpen,
	own = false,
	className,
}: MessageThreadPillProps) {
	const unread = summary.unreadCount > 0
	const label = replyPillLabel(summary)
	return (
		<Button
			type="button"
			variant="ghost"
			size="sm"
			onClick={onOpen}
			aria-label={`${label}. Open thread`}
			className={cn(
				'gap-2 text-xs',
				own ? 'self-end' : 'ml-[39px] self-start',
				unread ? 'font-semibold text-brand' : 'text-muted-foreground',
				className,
			)}
		>
			<span className="flex items-center">
				{summary.participants.map((p, index) => (
					<ActorAvatar
						key={p.actorId}
						id={p.actorId}
						name={p.actorName}
						type={p.actorType}
						className={cn(
							'h-5 w-5 rounded-md text-[8px] ring-2 ring-background',
							index > 0 && '-ml-1.5',
						)}
					/>
				))}
			</span>
			{unread ? <span className="h-1.5 w-1.5 rounded-full bg-brand" aria-hidden /> : null}
			<span>{label}</span>
		</Button>
	)
}
