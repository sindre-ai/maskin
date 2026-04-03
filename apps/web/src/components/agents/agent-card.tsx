import { useDuration } from '@/hooks/use-duration'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'
import { Spinner } from '../ui/spinner'

export type AgentStatus = 'working' | 'idle' | 'failed'

export function AgentCard({
	agent,
	status,
	latestSession,
}: {
	agent: ActorResponse
	status: AgentStatus
	latestSession?: SessionResponse
}) {
	const { workspaceId } = useWorkspace()

	const roleDescription = agent.systemPrompt?.split('\n')[0]?.trim()

	return (
		<Link
			to="/$workspaceId/agents/$agentId"
			params={{ workspaceId, agentId: agent.id }}
			className={cn(
				'block rounded-lg border bg-card p-4 shadow-md transition-colors hover:border-border-hover',
				status === 'working' && 'border-success bg-success/5',
				status === 'failed' && 'border-error',
				status === 'idle' && 'border-border',
			)}
		>
			<div className="flex items-center justify-between mb-1">
				<div className="flex items-center gap-2">
					<ActorAvatar name={agent.name} type="agent" size="md" />
					<span className="text-sm font-medium text-foreground">{agent.name}</span>
					<StatusIndicator status={status} />
				</div>
				<StatusLabel status={status} />
			</div>

			{roleDescription && (
				<p className="text-xs text-muted-foreground mb-3 ml-9 line-clamp-1">{roleDescription}</p>
			)}

			<div className="ml-9">
				<ActivityLine status={status} session={latestSession} />
			</div>
		</Link>
	)
}

function StatusIndicator({ status }: { status: AgentStatus }) {
	if (status === 'working') {
		return <Spinner className="size-3 text-success" />
	}
	return (
		<span
			className={cn(
				'h-1.5 w-1.5 rounded-full',
				status === 'failed' ? 'bg-error' : 'bg-muted-foreground',
			)}
		/>
	)
}

function StatusLabel({ status }: { status: AgentStatus }) {
	return (
		<span
			className={cn(
				'text-xs font-medium',
				status === 'working' && 'text-success',
				status === 'failed' && 'text-error',
				status === 'idle' && 'text-muted-foreground',
			)}
		>
			{status}
		</span>
	)
}

function ActivityLine({ status, session }: { status: AgentStatus; session?: SessionResponse }) {
	if (!session) {
		return <p className="text-xs text-muted-foreground">No activity yet</p>
	}

	if (status === 'working') {
		return <WorkingActivity session={session} />
	}

	if (status === 'failed') {
		return (
			<p className="text-xs text-error truncate">
				✕ {session.actionPrompt}
				{session.completedAt && (
					<>
						{' · '}
						<RelativeTime date={session.completedAt} className="text-error" />
					</>
				)}
			</p>
		)
	}

	// idle — show last completed session
	return (
		<p className="text-xs text-muted-foreground truncate">
			{session.actionPrompt}
			{session.completedAt && (
				<>
					{' · '}
					<RelativeTime date={session.completedAt} className="text-muted-foreground" />
				</>
			)}
		</p>
	)
}

function WorkingActivity({ session }: { session: SessionResponse }) {
	const duration = useDuration(session.startedAt)

	return (
		<p className="text-xs text-success truncate">
			{session.actionPrompt}
			{duration && ` · ${duration}`}
		</p>
	)
}
