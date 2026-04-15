import { Badge } from '@/components/ui/badge'
import { useDuration } from '@/hooks/use-duration'
import type { ActorResponse, SessionResponse } from '@/lib/api'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { Globe, Terminal } from 'lucide-react'
import { ActorAvatar } from '../shared/actor-avatar'
import { RelativeTime } from '../shared/relative-time'
import { Spinner } from '../ui/spinner'

export type AgentStatus = 'working' | 'idle' | 'failed'

function getMcpServerCount(tools: Record<string, unknown> | null): number {
	if (!tools) return 0
	const servers = tools.mcpServers as Record<string, unknown> | undefined
	return servers ? Object.keys(servers).length : 0
}

function getModelLabel(llmProvider: string | null, llmConfig: unknown): string | null {
	const config = llmConfig as Record<string, unknown> | null
	const model = config?.model as string | undefined
	if (model) {
		// Shorten common model names
		if (model.includes('claude')) return model.split('-').slice(0, 3).join('-')
		if (model.includes('gpt')) return model.split('-').slice(0, 2).join('-')
		return model.length > 20 ? `${model.slice(0, 20)}…` : model
	}
	return llmProvider
}

export function AgentCard({
	agent,
	status,
	latestSession,
	sessionCount,
}: {
	agent: ActorResponse
	status: AgentStatus
	latestSession?: SessionResponse
	sessionCount?: number
}) {
	const { workspaceId } = useWorkspace()

	const roleDescription = agent.systemPrompt?.split('\n')[0]?.trim()
	const mcpCount = getMcpServerCount(agent.tools)
	const modelLabel = getModelLabel(agent.llmProvider, agent.llmConfig)

	return (
		<Link
			to="/$workspaceId/agents/$agentId"
			params={{ workspaceId, agentId: agent.id }}
			className={cn(
				'block rounded-lg border bg-card p-4 shadow-md transition-colors hover:border-border-hover',
				status === 'working' && 'border-accent bg-accent/5',
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
				<p className="text-xs text-muted-foreground mb-2 ml-9 line-clamp-1">{roleDescription}</p>
			)}

			{/* Capability badges */}
			{(mcpCount > 0 || modelLabel || (sessionCount !== undefined && sessionCount > 0)) && (
				<div className="flex flex-wrap gap-1 ml-9 mb-2">
					{mcpCount > 0 && (
						<Badge variant="outline" className="text-[10px] px-1.5 py-0 gap-0.5">
							{mcpCount > 1 ? (
								<Globe className="h-2.5 w-2.5" />
							) : (
								<Terminal className="h-2.5 w-2.5" />
							)}
							{mcpCount} server{mcpCount > 1 ? 's' : ''}
						</Badge>
					)}
					{modelLabel && (
						<Badge variant="outline" className="text-[10px] px-1.5 py-0 font-mono">
							{modelLabel}
						</Badge>
					)}
					{sessionCount !== undefined && sessionCount > 0 && (
						<Badge variant="outline" className="text-[10px] px-1.5 py-0">
							{sessionCount} session{sessionCount > 1 ? 's' : ''}
						</Badge>
					)}
				</div>
			)}

			<div className="ml-9">
				<ActivityLine status={status} session={latestSession} />
			</div>
		</Link>
	)
}

function StatusIndicator({ status }: { status: AgentStatus }) {
	if (status === 'working') {
		return <Spinner className="size-3 text-accent" />
	}
	return (
		<span
			className={cn('h-1.5 w-1.5 rounded-full', status === 'failed' ? 'bg-error' : 'bg-text-muted')}
		/>
	)
}

function StatusLabel({ status }: { status: AgentStatus }) {
	return (
		<span
			className={cn(
				'text-xs font-medium',
				status === 'working' && 'text-accent',
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
		<p className="text-xs text-accent truncate">
			{session.actionPrompt}
			{duration && ` · ${duration}`}
		</p>
	)
}
