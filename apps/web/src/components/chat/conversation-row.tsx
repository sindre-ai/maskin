import { ActorAvatar } from '@/components/shared/actor-avatar'
import { RelativeTime } from '@/components/shared/relative-time'
import { cn } from '@/lib/cn'

export interface ConversationParticipant {
	name: string
	type: string
}

export interface ConversationRowProps {
	type: 'dm' | 'room'
	title: string | null
	preview: string | null
	timestamp: string | null
	unread: boolean
	/** DM: the other participant. Room: up to 3 participants for the facepile. */
	participants?: ConversationParticipant[]
	onClick?: () => void
	className?: string
}

export function ConversationRow({
	type,
	title,
	preview,
	timestamp,
	unread,
	participants = [],
	onClick,
	className,
}: ConversationRowProps) {
	return (
		<div
			role="button"
			tabIndex={0}
			onClick={onClick}
			onKeyDown={(e) => {
				if (e.key === 'Enter' || e.key === ' ') {
					e.preventDefault()
					onClick?.()
				}
			}}
			className={cn(
				'flex min-h-[44px] cursor-pointer items-start gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-muted/50 focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-1',
				className,
			)}
		>
			<div className="mt-0.5 flex-shrink-0">
				{type === 'dm' ? (
					<ActorAvatar
						name={participants[0]?.name ?? '?'}
						type={participants[0]?.type ?? 'agent'}
						size="md"
					/>
				) : (
					<Facepile participants={participants} />
				)}
			</div>

			<div className="min-w-0 flex-1">
				<div className="mb-0.5 flex items-center justify-between gap-1.5">
					<span className="truncate text-sm font-medium leading-none">
						{title ?? 'Untitled'}
					</span>
					{timestamp && (
						<RelativeTime
							date={timestamp}
							className="flex-shrink-0 text-[11px] text-muted-foreground"
						/>
					)}
				</div>
				{preview && (
					<p className="truncate text-xs text-muted-foreground leading-none mt-0.5">{preview}</p>
				)}
			</div>

			{unread && (
				<span
					aria-label="Unread"
					className="mt-1.5 h-1.5 w-1.5 flex-shrink-0 rounded-full bg-success"
				/>
			)}
		</div>
	)
}

function Facepile({ participants }: { participants: ConversationParticipant[] }) {
	const visible = participants.slice(0, 3)

	if (visible.length === 0) {
		return <ActorAvatar name="?" type="agent" size="md" />
	}

	if (visible.length === 1) {
		return <ActorAvatar name={visible[0]!.name} type={visible[0]!.type} size="md" />
	}

	return (
		<div className="relative flex h-7 w-7 items-center justify-center">
			{visible.map((p, i) => (
				<span
					key={i}
					className="absolute"
					style={{
						zIndex: visible.length - i,
						transform: `translate(${(i - (visible.length - 1) / 2) * 6}px, ${(i - (visible.length - 1) / 2) * 3}px)`,
					}}
				>
					<ActorAvatar name={p.name} type={p.type} size="sm" />
				</span>
			))}
		</div>
	)
}
