import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLatestLog } from '@/hooks/use-sessions'
import { ActorAvatar } from './actor-avatar'

interface AgentWorkingBadgeProps {
	sessionId: string
	workspaceId: string
	variant?: 'compact' | 'banner'
}

export function AgentWorkingBadge({
	sessionId,
	workspaceId,
	variant = 'compact',
}: AgentWorkingBadgeProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const { data: actor } = useActor(session?.actorId ?? '')
	const { data: latestLog } = useSessionLatestLog(sessionId, workspaceId)
	const duration = useDuration(session?.startedAt)

	if (variant === 'banner') {
		return (
			<div className="flex items-center gap-2.5 rounded-md border border-border bg-secondary/50 px-3 py-2 mb-4 min-w-0">
				<Spinner />
				{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
				<span className="text-sm font-medium truncate">{actor?.name ?? 'Agent working'}</span>
				{latestLog && (
					<>
						<span className="text-muted-foreground hidden sm:inline">·</span>
						<span className="text-sm text-muted-foreground truncate hidden sm:inline">
							{latestLog.content}
						</span>
					</>
				)}
				{duration && (
					<span className="ml-auto text-xs text-muted-foreground shrink-0">{duration}</span>
				)}
			</div>
		)
	}

	return (
		<Badge variant="secondary" className="gap-1.5 max-w-[200px] sm:max-w-[280px]">
			<Spinner />
			<span className="truncate">
				{actor?.name ?? 'Agent working'}
				{latestLog && <span className="text-muted-foreground"> · {latestLog.content}</span>}
			</span>
			{duration && <span className="text-muted-foreground shrink-0"> · {duration}</span>}
		</Badge>
	)
}
