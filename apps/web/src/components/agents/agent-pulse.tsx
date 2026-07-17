import { useWorkspaceSessions } from '@/hooks/use-sessions'
import { getActiveAgentSessions } from '@/lib/agent-status'
import { useMemo } from 'react'

export function AgentPulse({ workspaceId }: { workspaceId: string }) {
	const { data: sessions } = useWorkspaceSessions(workspaceId)

	const activeCount = useMemo(() => {
		if (!sessions) return 0
		return getActiveAgentSessions(sessions).length
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
