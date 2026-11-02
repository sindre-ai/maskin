import { StatusBadge } from '@/components/shared/status-badge'
import { useObjects } from '@/hooks/use-objects'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'

/**
 * The Items tab (v3's "Driving"): the items this agent is the driver of (the objects list's
 * `driver` filter), A to Z by title. An agent that drives nothing says so.
 */
export function AgentDrivingSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: objects, isLoading } = useObjects(workspaceId, { driver: agent.id, limit: '100' })

	const items = useMemo(
		() =>
			(objects ?? [])
				.map((o) => ({ id: o.id, title: o.title?.trim() || 'Untitled', status: o.status }))
				.sort((a, b) =>
					a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
				),
		[objects],
	)

	if (items.length === 0) {
		if (isLoading) return null
		return <p className="px-1 text-[15px] text-muted-foreground">Not driving any items yet.</p>
	}

	return (
		<section aria-label="Items" className="flex flex-col">
			<ul className="flex flex-col border-t border-border">
				{items.map((item) => (
					<li key={item.id}>
						<Link
							to="/$workspaceId/objects/$objectId"
							params={{ workspaceId, objectId: item.id }}
							className="flex items-center gap-3 border-b border-border px-1 py-3 text-[15px] leading-snug transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="min-w-0 flex-1 truncate text-foreground">{item.title}</span>
							<span className="text-[13px] font-semibold">
								<StatusBadge status={item.status} variant="word" />
							</span>
							<ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
						</Link>
					</li>
				))}
			</ul>
		</section>
	)
}
