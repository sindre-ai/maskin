import type { ActorResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'

type AgentStatus = 'working' | 'idle' | 'failed'

export function AgentCard({
	agent,
	lastEvent,
	computedStatus,
}: {
	agent: ActorResponse
	lastEvent?: { action: string; entityType: string; createdAt: string | null }
	computedStatus?: AgentStatus
}) {
	const { workspaceId } = useWorkspace()
	const memorySize = agent.memory
		? `${(JSON.stringify(agent.memory).length / 1024).toFixed(1)}kb`
		: '0kb'

	// Fall back to 5-minute heuristic if no session-based status is available
	const isRecentlyActive = lastEvent?.createdAt
		? Date.now() - new Date(lastEvent.createdAt).getTime() < 5 * 60 * 1000
		: false
	const status: AgentStatus = computedStatus ?? (isRecentlyActive ? 'working' : 'idle')

	const statusDot = {
		working: 'bg-success animate-pulse',
		idle: 'bg-text-muted',
		failed: 'bg-error',
	}[status]

	const statusLabel = {
		working: 'working',
		idle: 'idle',
		failed: 'failed',
	}[status]

	return (
		<Link
			to="/$workspaceId/agents/$agentId"
			params={{ workspaceId, agentId: agent.id }}
			className={cn(
				'block rounded-lg border border-border bg-card p-4 shadow-md transition-colors hover:border-border-hover',
				status === 'failed' && 'border-error/30',
			)}
		>
			<div className="flex items-center justify-between mb-3">
				<div className="flex items-center gap-2">
					<ActorAvatar name={agent.name} type="agent" size="md" />
					<span className="text-sm font-medium text-foreground">{agent.name}</span>
				</div>
				<span className="flex items-center gap-1.5 text-xs">
					<span className={`h-1.5 w-1.5 rounded-full ${statusDot}`} />
					<span className={cn('text-muted-foreground', status === 'failed' && 'text-error')}>
						{statusLabel}
					</span>
				</span>
			</div>
			{lastEvent && (
				<p className="text-xs text-muted-foreground mb-2">
					Last action: {lastEvent.action.replace(/_/g, ' ')} {lastEvent.entityType}
					{lastEvent.createdAt && (
						<>
							{' '}
							<RelativeTime date={lastEvent.createdAt} className="text-muted-foreground" />
						</>
					)}
				</p>
			)}
			<p className="text-xs text-muted-foreground">Memory: {memorySize}</p>
		</Link>
	)
}
