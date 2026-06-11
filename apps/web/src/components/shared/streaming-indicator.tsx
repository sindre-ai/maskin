import {
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { Button } from '@/components/ui/button'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLogs, useStopSession } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import { PauseCircle } from 'lucide-react'
import { useEffect, useMemo, useState } from 'react'
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

type PillMode = 'idle' | 'confirm' | 'stopping'

// How long the pill stays in `Stopping…` before collapsing. Mirrors the 5s
// propagation grace described in the UX direction (3s container kill + buffer
// for the status-gate to settle).
const STOPPING_GRACE_MS = 5000

export function StreamingIndicator({ sessionId, workspaceId }: StreamingIndicatorProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const { data: actor } = useActor(session?.actorId ?? '')
	const { data: logs } = useSessionLogs(sessionId, workspaceId, true, { live: true })
	const duration = useDuration(session?.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])
	const stopSession = useStopSession(workspaceId)
	const [mode, setMode] = useState<PillMode>('idle')

	// Esc cancels the confirm. Single tap on the pill body opens it.
	useEffect(() => {
		if (mode !== 'confirm') return
		const onKey = (e: KeyboardEvent) => {
			if (e.key === 'Escape') setMode('idle')
		}
		window.addEventListener('keydown', onKey)
		return () => window.removeEventListener('keydown', onKey)
	}, [mode])

	const isStopping = mode === 'stopping' || session?.status === 'stopping' || stopSession.isPending
	const agentName = actor?.name ?? 'Agent'
	const label = idle ? `${agentName} is idle` : `${agentName} is working`

	const handleConfirmStop = () => {
		setMode('stopping')
		stopSession.mutate(sessionId, {
			onError: () => setMode('idle'),
		})
		// Defence-in-depth: if SSE invalidation is slow, force the pill out of
		// `Stopping…` after the grace window so the UI doesn't appear hung.
		window.setTimeout(() => setMode('idle'), STOPPING_GRACE_MS)
	}

	return (
		<div
			className={cn(
				'inline-flex items-center gap-2 rounded-full border border-border bg-bg-surface px-3 py-1.5',
				'animate-in fade-in slide-in-from-bottom-1 duration-200',
				isStopping && 'opacity-80',
			)}
			data-state={isStopping ? 'stopping' : idle ? 'idle' : 'running'}
		>
			{idle ? (
				<PauseCircle size={14} className="shrink-0 text-muted-foreground" />
			) : (
				<span className={cn(isStopping ? 'text-muted-foreground' : 'text-primary')}>
					<PulsingDots />
				</span>
			)}
			{actor && <ActorAvatar name={actor.name} type={actor.type} size="sm" />}

			{mode === 'confirm' ? (
				<>
					<span className="text-sm font-medium">Stop {agentName}?</span>
					<Button
						type="button"
						size="sm"
						variant="destructive"
						className="h-7 px-2 text-xs"
						onClick={handleConfirmStop}
						disabled={stopSession.isPending}
						autoFocus
					>
						Stop
					</Button>
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 px-2 text-xs"
						onClick={() => setMode('idle')}
					>
						Cancel
					</Button>
				</>
			) : (
				<>
					<span className="text-sm font-medium">
						{isStopping ? `Stopping ${agentName}…` : label}
					</span>
					{!isStopping && preview && (
						<>
							<span className="text-muted-foreground">&middot;</span>
							<span className="text-sm text-muted-foreground truncate max-w-[200px]">
								{preview}
							</span>
						</>
					)}
					{duration && !isStopping && (
						<span className="ml-1 text-xs text-muted-foreground shrink-0">{duration}</span>
					)}
					{!isStopping && (
						<button
							type="button"
							onClick={() => setMode('confirm')}
							className="ml-1 text-xs text-muted-foreground hover:text-foreground transition-colors min-h-[44px] sm:min-h-0 sm:py-0 px-1"
							aria-label={`Stop ${agentName}`}
						>
							Stop
						</button>
					)}
				</>
			)}
		</div>
	)
}
