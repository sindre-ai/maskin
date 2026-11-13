import { SessionDetailPanel } from '@/components/agents/session-detail-panel'
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
import { useMemo, useState } from 'react'
import { ActorAvatar } from './actor-avatar'

interface AgentWorkingBadgeProps {
	sessionId: string
	workspaceId: string
	/** `inline` is the one thin line the item page draws under its meta row: spinner, "<name> is
	 *  thinking", the time, and a Watch link that opens the session. */
	variant?: 'compact' | 'banner' | 'inline'
}

export function AgentWorkingBadge({
	sessionId,
	workspaceId,
	variant = 'compact',
}: AgentWorkingBadgeProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const { data: actor } = useActor(session?.actorId ?? '')
	const { data: logs } = useSessionLogs(sessionId, workspaceId, true, { live: true })
	const [watchOpen, setWatchOpen] = useState(false)
	const duration = useDuration(session?.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const label = idle ? (actor?.name ?? 'Agent') : (actor?.name ?? 'Agent working')

	const Icon = idle ? (
		<PauseCircle size={14} className="shrink-0 text-muted-foreground" />
	) : (
		<Spinner />
	)

	if (variant === 'inline') {
		return (
			<div className="flex min-w-0 items-center gap-2 text-[12.5px] text-muted-foreground">
				{Icon}
				<span className="min-w-0 truncate">
					<span className="font-semibold text-foreground">{actor?.name ?? 'An agent'}</span>
					{idle ? ' is waiting' : ' is thinking'}
				</span>
				{duration && <span className="shrink-0">· {duration}</span>}
				<button
					type="button"
					onClick={() => setWatchOpen(true)}
					className="ml-1 shrink-0 rounded-md px-1.5 py-0.5 font-semibold text-brand transition-colors hover:bg-brand-subtle focus:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
				>
					Watch
				</button>
				<SessionDetailPanel
					session={session ?? null}
					workspaceId={workspaceId}
					open={watchOpen}
					onOpenChange={setWatchOpen}
				/>
			</div>
		)
	}

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
						<span className="text-xs text-muted-foreground shrink-0 ml-auto">{duration}</span>
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
