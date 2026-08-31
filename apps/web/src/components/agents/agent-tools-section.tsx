import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import { McpServers } from '@/components/agents/mcp-servers'
import { Button } from '@/components/ui/button'
import { useUpdateActor } from '@/hooks/use-actors'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useCallback, useState } from 'react'
import { toast } from 'sonner'

function countServers(tools: Record<string, unknown> | null): number {
	if (!tools) return 0
	const servers = tools.mcpServers as Record<string, unknown> | undefined
	return servers ? Object.keys(servers).length : 0
}

export function AgentToolsSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const updateActor = useUpdateActor(workspaceId)
	const [managing, setManaging] = useState(false)

	const total = countServers(agent.tools)

	const handleUpdate = useCallback(
		(tools: Record<string, unknown>) => {
			updateActor.mutate(
				{ id: agent.id, data: { tools } },
				{
					onSuccess: () => toast.success('Tools updated'),
					onError: () => toast.error(`Couldn't save tools for ${agent.name}`),
				},
			)
		},
		[agent.id, agent.name, updateActor],
	)

	return (
		<section aria-labelledby="agent-tools-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading
				id="agent-tools-heading"
				title="Tools"
				note={
					<span
						className="shrink-0 text-[11px] tabular-nums text-muted-foreground"
						aria-label={`${total} tool${total === 1 ? '' : 's'} attached`}
					>
						· {total}
					</span>
				}
				action={
					<Button
						type="button"
						size="sm"
						variant="ghost"
						className="h-7 shrink-0 px-2 text-xs font-medium"
						aria-pressed={managing}
						onClick={() => setManaging((v) => !v)}
					>
						{managing ? 'Done' : 'Manage'}
					</Button>
				}
			/>
			<div className="rounded-xl border border-border bg-card px-4 py-4">
				<McpServers tools={agent.tools} onUpdate={handleUpdate} readOnly={!managing} />
			</div>
		</section>
	)
}
