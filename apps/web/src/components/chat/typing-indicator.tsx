import {
	getLatestActivityPreview,
	isSessionIdleAwaitingInput,
} from '@/components/agents/session-log-transcript'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { useActor } from '@/hooks/use-actors'
import { useDuration } from '@/hooks/use-duration'
import { useSession, useSessionLogs } from '@/hooks/use-sessions'
import { cn } from '@/lib/cn'
import { useMemo } from 'react'

interface TypingIndicatorProps {
	sessionId: string
	workspaceId: string
	className?: string
}

/**
 * Live "agent is working" affordance for the chat surface. Shows the agent's
 * avatar + name, the current verb (from the latest tool_use / thinking / text
 * log line), and the elapsed time since the container started. Renders nothing
 * when the session doesn't exist yet or has already returned to idle awaiting
 * the next user turn — so the surface stays quiet outside a live turn.
 */
export function TypingIndicator({ sessionId, workspaceId, className }: TypingIndicatorProps) {
	const { data: session } = useSession(sessionId, workspaceId)
	const { data: actor } = useActor(session?.actorId ?? '')
	const { data: logs } = useSessionLogs(sessionId, workspaceId, true, { live: true })
	const duration = useDuration(session?.startedAt)
	const idle = useMemo(() => isSessionIdleAwaitingInput(logs ?? []), [logs])
	const preview = useMemo(() => getLatestActivityPreview(logs ?? []), [logs])

	if (!session) return null
	if (session.status !== 'running' && session.status !== 'pending') return null
	if (idle) return null

	const agentName = actor?.name?.trim() || 'Agent'
	const verb = preview ?? 'thinking…'

	return (
		<output
			aria-live="polite"
			className={cn(
				'flex items-center gap-2 rounded-md border border-border bg-bg-surface px-2 py-1.5 text-xs text-text-secondary',
				className,
			)}
			data-typing-indicator={sessionId}
		>
			<PulsingDots />
			{actor ? <ActorAvatar name={actor.name} type={actor.type} size="sm" id={actor.id} /> : null}
			<span className="min-w-0 flex-1 truncate">
				<span className="font-medium text-text">{agentName}</span>
				<span className="text-text-muted"> · {verb}</span>
			</span>
			{duration ? (
				<span className="shrink-0 font-mono text-[11px] tabular-nums text-text-muted">
					{duration}
				</span>
			) : null}
		</output>
	)
}

function PulsingDots() {
	return (
		<span
			aria-hidden
			className="inline-flex shrink-0 items-center gap-0.5 text-accent-foreground/70"
		>
			<span className="size-1.5 animate-pulse rounded-full bg-current" />
			<span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:150ms]" />
			<span className="size-1.5 animate-pulse rounded-full bg-current [animation-delay:300ms]" />
		</span>
	)
}
