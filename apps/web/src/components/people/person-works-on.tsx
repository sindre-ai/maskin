import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { StatusBadge } from '@/components/shared/status-badge'
import { Button } from '@/components/ui/button'
import { useObjectFacets, useObjects } from '@/hooks/use-objects'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useMemo, useState } from 'react'

/** Rows shown before the list collapses behind "Show all": a person can drive many items. */
const COLLAPSED_ROWS = 4

/**
 * The items this person drives (the objects list's `driver` filter takes any actor id), A to Z by
 * title. Same rows as the agent page's Items tab, capped at four with a Show all.
 */
export function PersonWorksOn({ person }: { person: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: objects, isLoading } = useObjects(workspaceId, { driver: person.id, limit: '100' })
	const { data: facets } = useObjectFacets(workspaceId, { driver: person.id })
	const [expanded, setExpanded] = useState(false)

	const items = useMemo(
		() =>
			(objects ?? [])
				.map((o) => ({ id: o.id, title: o.title?.trim() || 'Untitled', status: o.status }))
				.sort((a, b) =>
					a.title.localeCompare(b.title, undefined, { sensitivity: 'base', numeric: true }),
				),
		[objects],
	)
	const total = Math.max(facets?.total ?? 0, items.length)
	const shown = expanded ? items : items.slice(0, COLLAPSED_ROWS)

	return (
		<section aria-labelledby="person-works-on-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="person-works-on-heading"
				title="Works on"
				note={total > 0 ? total : undefined}
			/>
			{items.length === 0 ? (
				isLoading ? null : (
					<p className="px-1 text-[15px] text-muted-foreground">Not driving any items yet.</p>
				)
			) : (
				<>
					<ul className="flex flex-col border-t border-border">
						{shown.map((item) => (
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
					{items.length > COLLAPSED_ROWS && (
						<Button
							variant="ghost"
							size="sm"
							className="h-7 w-fit px-2 text-[13px] font-semibold text-muted-foreground hover:text-foreground"
							aria-expanded={expanded}
							onClick={() => setExpanded((v) => !v)}
						>
							{expanded ? 'Show less' : `Show all ${total}`}
						</Button>
					)}
				</>
			)}
		</section>
	)
}
