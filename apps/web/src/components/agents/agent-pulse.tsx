import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { ACTIVE_STATUSES } from '@/lib/agent-status'
import { useMemo } from 'react'

export function AgentPulse({ workspaceId }: { workspaceId: string }) {
	const { data: sessions } = useWorkspaceSessions(workspaceId)

	const activeCount = useMemo(() => {
		if (!sessions) return 0
		const activeActors = new Set(
			sessions.filter((s) => ACTIVE_STATUSES.has(s.status)).map((s) => s.actorId),
		)
		return activeActors.size
	}, [sessions])

	if (activeCount === 0) {
		return <span className="text-xs text-muted-foreground">No agents working</span>
	}

	return (
		<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
			<span aria-hidden="true" className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
			{activeCount} agent{activeCount !== 1 ? 's' : ''} working
		</span>
	)
}
