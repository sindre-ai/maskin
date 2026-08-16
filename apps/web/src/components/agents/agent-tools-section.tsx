import { McpServers } from '@/components/agents/mcp-servers'
import { Button } from '@/components/ui/button'
import { useUpdateActor } from '@/hooks/use-actors'
import type { ActorResponse } from '@/lib/api'
import { useWorkspace } from '@/lib/workspace-context'
import { useCallback, useState } from 'react'

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
			updateActor.mutate({ id: agent.id, data: { tools } })
		},
		[agent.id, updateActor],
	)

	return (
		<section aria-label="Tools" className="overflow-hidden rounded-xl border border-border bg-card">
			<div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5">
				<span className="eyebrow">Tools</span>
				<span
					className="text-[11px] tabular-nums text-muted-foreground"
					aria-label={`${total} tool${total === 1 ? '' : 's'} attached`}
				>
					· {total}
				</span>
				<Button
					type="button"
					size="sm"
					variant="ghost"
					className="ml-auto h-7 px-2 text-xs font-medium"
					aria-pressed={managing}
					onClick={() => setManaging((v) => !v)}
				>
					{managing ? 'Done' : 'Manage'}
				</Button>
			</div>
			<div className="px-4 py-4">
				<McpServers tools={agent.tools} onUpdate={handleUpdate} readOnly={!managing} />
			</div>
		</section>
	)
}
