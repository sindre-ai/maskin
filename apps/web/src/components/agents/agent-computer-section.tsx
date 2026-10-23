import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { ExpandableDesktop } from '@/components/desktop/expandable-desktop'
import { Button } from '@/components/ui/button'
import { useDesktops } from '@/hooks/use-desktop'
import type { ActorResponse } from '@/lib/api'
import { queryKeys } from '@/lib/query-keys'
import { useWorkspace } from '@/lib/workspace-context'
import { useQueryClient } from '@tanstack/react-query'
import { Monitor } from 'lucide-react'
import { useState } from 'react'

/**
 * The agent's own computer, on its page. Every agent has one, created the first
 * time it is opened and put to sleep when idle (a sleeping one wakes in a few
 * seconds with everything exactly where it was).
 *
 * Opening this page must not by itself start or wake anything: a computer costs
 * memory while it runs. So it connects straight away only if it is already
 * running; otherwise it offers a button. The live view, and its expand-to-popup,
 * is the shared ExpandableDesktop.
 */
export function AgentComputerSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const queryClient = useQueryClient()
	const { data } = useDesktops(workspaceId)
	const [started, setStarted] = useState(false)

	const status = data?.desktops.find((d) => d.agent_id === agent.id)?.status
	const live = started || status === 'running'
	const note = live ? 'Running' : status === 'suspended' ? 'Asleep' : 'Not started yet'

	const start = () => {
		setStarted(true)
		void queryClient.invalidateQueries({ queryKey: queryKeys.desktops.all(workspaceId) })
	}

	return (
		<section aria-label="Computer" className="flex flex-col gap-3">
			<AgentSectionHeading title="Computer" note={note} />

			{live ? (
				<ExpandableDesktop workspaceId={workspaceId} agentId={agent.id} agentName={agent.name} />
			) : (
				<div className="flex flex-col items-center gap-3 rounded-lg border bg-card px-4 py-8 text-center">
					<Monitor size={20} className="text-muted-foreground" aria-hidden />
					<p className="max-w-sm text-sm text-muted-foreground">
						{status === 'suspended'
							? `${agent.name}'s computer is asleep. It wakes in a few seconds, exactly as it was left.`
							: `${agent.name} has its own computer. It is created the first time it is opened.`}
					</p>
					<Button variant="outline" size="sm" onClick={start}>
						{status === 'suspended' ? 'Wake up' : 'Start computer'}
					</Button>
				</div>
			)}
		</section>
	)
}
