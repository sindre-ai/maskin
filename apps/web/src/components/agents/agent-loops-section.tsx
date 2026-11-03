import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { LoopRow } from '@/components/loops/loop-row'
import { EmptyState } from '@/components/shared/empty-state'
import { useActors } from '@/hooks/use-actors'
import { useLoops } from '@/hooks/use-loops'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useMemo } from 'react'

/**
 * "Loops it runs" (mockup 2469–2478) — the agent's only outbound link to its
 * work. A thin composition of `useLoops` + the app's single loop-row renderer;
 * the mockup's bespoke SVG progress ring is deliberately not rebuilt, so Loops
 * and Agents keep showing a loop the same way.
 */
export function AgentLoopsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data: loops } = useLoops(workspaceId)
	const { data: actors } = useActors(workspaceId)

	const agentLoops = useMemo(
		() => (loops ?? []).filter((loop) => loop.agentIds.includes(agent.id)),
		[loops, agent.id],
	)

	return (
		<section aria-labelledby="agent-loops-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-loops-heading"
				title="Loops it runs"
				note={agentLoops.length > 0 ? String(agentLoops.length) : undefined}
			/>
			{agentLoops.length === 0 ? (
				<EmptyState compact title="Not tied to a loop yet" className="py-6" />
			) : (
				<ul className="flex flex-col gap-2">
					{agentLoops.map((loop) => (
						<li key={loop.id}>
							<LoopRow loop={loop} actors={actors} />
						</li>
					))}
				</ul>
			)}
		</section>
	)
}
