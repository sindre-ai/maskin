import { AgentAccess } from '@/components/integrations/agent-access'
import { ActorAvatar } from '@/components/shared/actor-avatar'
import { ViewerTooltip } from '@/components/shared/viewer-tooltip'
import { Switch } from '@/components/ui/switch'
import { useActors } from '@/hooks/use-actors'
import { useCanWrite } from '@/hooks/use-can-write'
import {
	useRemoveAgentGrant,
	useSetAgentGrant,
	useSetDefaultAgentAccess,
} from '@/hooks/use-integrations'
import type { AgentGrant, DefaultAgentAccess, IntegrationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

/** Whether an agent gets the server: its own entry, else what every other agent gets. */
export function toolServerEnabled(
	defaultAccess: DefaultAgentAccess,
	grant: Pick<AgentGrant, 'access'> | undefined,
): boolean {
	return (grant?.access ?? defaultAccess) !== 'none'
}

/** One line for the collapsed header: who has this server, in words. */
export function summarizeToolServerAccess(
	defaultAccess: DefaultAgentAccess,
	grants: Pick<AgentGrant, 'actorId' | 'access'>[],
	agentIds: string[],
): string {
	const grantFor = new Map(grants.map((g) => [g.actorId, g]))
	const on = agentIds.filter((id) => toolServerEnabled(defaultAccess, grantFor.get(id))).length
	if (agentIds.length === 0) return 'No agents yet'
	if (on === 0) return 'No agents use it yet'
	if (on === agentIds.length) return agentIds.length === 1 ? '1 agent' : 'All agents'
	return `${on} of ${agentIds.length} agents`
}

/**
 * Which agents get a custom tool server. One Maskin can sit in front of (an HTTP server at a
 * public address) has the same Read / Read & write / No access as a built-in integration. One that
 * runs inside the agent's container is on or off, because Maskin cannot see its tool calls.
 * "All agents" is the default for agents without their own entry, so a new agent gets it too.
 */
export function ToolServerAccess({
	integration,
	workspaceId,
}: {
	integration: IntegrationResponse
	workspaceId: string
}) {
	// Maskin sits in front of it: the same Read / Read & write / No access as a built-in integration.
	const gated = (integration.config as { custom_mcp?: { gated?: boolean } }).custom_mcp?.gated
	if (gated) return <AgentAccess integration={integration} workspaceId={workspaceId} />
	return <ToolServerSwitches integration={integration} workspaceId={workspaceId} />
}

function ToolServerSwitches({
	integration,
	workspaceId,
}: {
	integration: IntegrationResponse
	workspaceId: string
}) {
	const [open, setOpen] = useState(false)
	const { workspace } = useWorkspace()
	const canWrite = useCanWrite()
	const { data: actors } = useActors(workspaceId)
	const setGrant = useSetAgentGrant(workspaceId, integration.id)
	const removeGrant = useRemoveAgentGrant(workspaceId, integration.id)
	const setDefault = useSetDefaultAgentAccess(workspaceId, integration.id)

	const defaultAccess = integration.defaultAgentAccess ?? 'none'
	const grants = integration.agentGrants ?? []
	const agents = (actors ?? []).filter((a) => a.type === 'agent')
	const me = getStoredActor()
	const canEdit =
		canWrite &&
		me?.type === 'human' &&
		(integration.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	const busy = setGrant.isPending || removeGrant.isPending || setDefault.isPending

	const toggle = (agentId: string, on: boolean) => {
		// Back to the default when the choice matches it, so the list stays free of redundant rows.
		const matchesDefault = on === (defaultAccess !== 'none')
		if (matchesDefault) removeGrant.mutate(agentId)
		else setGrant.mutate({ actorId: agentId, access: on ? 'read_write' : 'none' })
	}

	return (
		<div className="mt-1 border-t border-border pt-2">
			<button
				type="button"
				onClick={() => setOpen((v) => !v)}
				aria-expanded={open}
				className="flex w-full min-w-0 flex-wrap items-center gap-x-1.5 rounded-md py-1 text-left text-xs transition-colors hover:text-foreground"
			>
				<ChevronRight
					className={cn('h-3.5 w-3.5 shrink-0 transition-transform', open && 'rotate-90')}
				/>
				<span className="settings-label shrink-0">Agents</span>
				<span className="min-w-0 text-muted-foreground">
					{summarizeToolServerAccess(
						defaultAccess,
						grants,
						agents.map((a) => a.id),
					)}
				</span>
			</button>

			{open && (
				<div className="mt-2 space-y-2">
					<div className="flex items-center gap-2 rounded-md border border-border bg-bg-surface p-2.5">
						<div className="min-w-0 flex-1">
							<p className="text-sm font-medium text-foreground">All agents</p>
							<p className="text-xs text-muted-foreground">
								Also every agent added later, unless switched off below
							</p>
						</div>
						<ViewerTooltip>
							<Switch
								checked={defaultAccess !== 'none'}
								onCheckedChange={(on) => setDefault.mutate(on ? 'read' : 'none')}
								disabled={!canEdit || busy}
								aria-label={`${integration.displayName ?? 'Tool server'} for all agents`}
							/>
						</ViewerTooltip>
					</div>

					{agents.map((agent) => (
						<div
							key={agent.id}
							className="flex items-center gap-2 rounded-md border border-border bg-bg-surface p-2.5"
						>
							<div className="flex min-w-0 flex-1 items-center gap-2">
								<ActorAvatar name={agent.name} type={agent.type} size="sm" />
								<p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
							</div>
							<ViewerTooltip>
								<Switch
									checked={toolServerEnabled(
										defaultAccess,
										grants.find((g) => g.actorId === agent.id),
									)}
									onCheckedChange={(on) => toggle(agent.id, on)}
									disabled={!canEdit || busy}
									aria-label={`${integration.displayName ?? 'Tool server'} for ${agent.name}`}
								/>
							</ViewerTooltip>
						</div>
					))}

					<p className="text-xs text-muted-foreground">
						{canEdit
							? 'Applies to new sessions. A session already running keeps the tools it started with.'
							: 'Only the person who added this or a workspace admin can change which agents use it.'}
					</p>
				</div>
			)}
		</div>
	)
}
