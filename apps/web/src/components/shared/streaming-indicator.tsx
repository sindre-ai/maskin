import {
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLogs } from '@/hooks/use-sessions'
import { PauseCircle } from 'lucide-react'
import { useMemo } from 'react'
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
	const { data: logs } = useSessionLogs(sessionId, workspaceId, true, { live: true })
	const duration = useDuration(session?.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const label = idle ? `${actor?.name ?? 'Agent'} is idle` : `${actor?.name ?? 'Agent'} is working`

	return (
		<div className="flex items-center gap-2 rounded-md border border-border bg-secondary/30 px-3 py-2 animate-in fade-in slide-in-from-bottom-1 duration-200">
			{idle ? (
				<PauseCircle size={14} className="shrink-0 text-muted-foreground" />
			) : (
				<span className="text-primary">
					<PulsingDots />
				</span>
			)}
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}
			<span className="text-sm font-medium">{label}</span>
			{preview && (
				<>
					<span className="text-muted-foreground">&middot;</span>
					<span className="text-sm text-muted-foreground truncate">{preview}</span>
				</>
			)}
			{duration && (
				<span className="ml-auto text-xs text-muted-foreground shrink-0">{duration}</span>
			)}
		</div>
	)
}
