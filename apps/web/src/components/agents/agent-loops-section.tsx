import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { LOOP_PILL_STYLES } from '@/components/loops/loop-pill'
import { useLoops } from '@/hooks/use-loops'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { useMemo } from 'react'

/**
 * "Works in" (v11): the flows this agent runs, A to Z, one plain row each with the flow's
 * state at the right. Nothing is drawn while there are none.
 */
export function AgentLoopsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: loops } = useLoops(workspaceId)

	const agentLoops = useMemo(
		() =>
			(loops ?? [])
				.filter((loop) => loop.agentIds.includes(agent.id))
				.map((loop) => ({ loop, name: loop.name?.trim() || 'Untitled loop' }))
				.sort((a, b) =>
					a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }),
				),
		[loops, agent.id],
	)

	if (agentLoops.length === 0) return null

	return (
		<section aria-labelledby="agent-loops-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading id="agent-loops-heading" title="Works in" quiet />
			<ul className="flex flex-col border-t border-border">
				{agentLoops.map(({ loop, name }) => (
					<li key={loop.id}>
						<Link
							to="/$workspaceId/loops/$loopId"
							params={{ workspaceId, loopId: loop.id }}
							className="flex items-center gap-3 border-b border-border px-1 py-3 text-[15px] transition-colors hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
							<span className="text-[13px] text-muted-foreground">
								{LOOP_PILL_STYLES[loop.pill].label}
							</span>
							<ChevronRight size={16} aria-hidden className="shrink-0 text-muted-foreground" />
						</Link>
					</li>
				))}
			</ul>
		</section>
	)
}
