import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLatestLog } from '@/hooks/use-sessions'
import { ActorAvatar } from './actor-avatar'

function PulsingDots() {
	return (
		<span className="inline-flex items-center gap-0.5">
			<span className="size-1.5 rounded-full bg-current animate-pulse" />
			<span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:150ms]" />
			<span className="size-1.5 rounded-full bg-current animate-pulse [animation-delay:300ms]" />
		</span>
	)
}

interface StreamingIndicatorProps {
	sessionId: string
	workspaceId: string
}

export function StreamingIndicator({ sessionId, workspaceId }: StreamingIndicatorProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const { data: actor } = useActor(session?.actorId ?? '')
	const { data: latestLog } = useSessionLatestLog(sessionId, workspaceId)
	const duration = useDuration(session?.startedAt)

	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
			<span className="text-primary">
				<PulsingDots />
			</span>
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<span className="text-sm font-medium">{actor?.name ?? 'Agent'} is working</span>
			{latestLog && (
				<>
					<span className="text-muted-foreground">&middot;</span>
					<span className="text-sm text-muted-foreground truncate">{latestLog.content}</span>
				</>
			)}
			{duration && <span className="ml-auto text-xs text-muted-foreground shrink-0">{duration}</span>}
		</div>
	)
}
