import { useEvents } from '@/hooks/use-events'

export function AgentPulse({ workspaceId }: { workspaceId: string }) {
	const { data: events } = useEvents(workspaceId, { limit: '50' })

	// Count unique agents active in last 5 minutes
	const fiveMinAgo = Date.now() - 5 * 60 * 1000
	const recentAgentIds = new Set(
		(events ?? [])
			.filter((e) => e.createdAt && new Date(e.createdAt).getTime() > fiveMinAgo)
			.map((e) => e.actorId),
	)
	const activeCount = recentAgentIds.size

	if (activeCount === 0) {
		return <span className="text-xs text-muted-foreground">No recent agent activity</span>
	}

	return (
		<span className="flex items-center gap-1.5 text-xs text-muted-foreground">
			<span className="h-1.5 w-1.5 rounded-full bg-success animate-pulse" />
			{activeCount} agent{activeCount !== 1 ? 's' : ''} active
		</span>
	)
}
