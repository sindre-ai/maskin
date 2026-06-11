import {
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { Badge } from '@/components/ui/badge'
import { Spinner } from '@/components/ui/spinner'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLogs } from '@/hooks/use-sessions'
import { PauseCircle } from 'lucide-react'
import { useMemo } from 'react'
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
	const { data: logs } = useSessionLogs(sessionId, workspaceId, true, { live: true })
	const duration = useDuration(session?.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const label = idle ? (actor?.name ?? 'Agent') : (actor?.name ?? 'Agent working')

	const Icon = idle ? (
		<PauseCircle size={14} className="shrink-0 text-muted-foreground" />
	) : (
		<Spinner />
	)

	if (variant === 'banner') {
		return (
			<div className="rounded-md border border-border bg-secondary/50 px-3 py-2 mb-4 min-w-0">
				<div className="flex items-center gap-2.5">
					{Icon}
					{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
					<span className="text-sm font-medium truncate">{label}</span>
					{preview && (
						<>
							<span className="text-muted-foreground">·</span>
							<span className="text-sm text-muted-foreground truncate min-w-0">{preview}</span>
						</>
					)}
					{duration && (
						<span className="ml-auto text-xs text-muted-foreground shrink-0">{duration}</span>
					)}
				</div>
				{session?.currentActivity && (
					<div className="flex items-center gap-1.5 mt-1 pl-6">
						<span className="size-1.5 rounded-full bg-primary animate-pulse shrink-0" />
						<span className="text-xs text-muted-foreground truncate">
							{session.currentActivity}
						</span>
					</div>
				)}
			</div>
		)
	}

	return (
		<Badge variant="secondary" className="gap-1.5 max-w-[200px] sm:max-w-[280px]">
			{Icon}
			<span className="truncate">
				{label}
				{preview && <span className="text-muted-foreground"> · {preview}</span>}
			</span>
			{duration && <span className="text-muted-foreground shrink-0"> · {duration}</span>}
		</Badge>
	)
}
