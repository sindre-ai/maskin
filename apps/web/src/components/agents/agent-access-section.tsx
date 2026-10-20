import { AgentSectionHeading } from '@/components/agents/agent-section-heading'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { Switch } from '@/components/ui/switch'
import { useAgentAccess, useRemoveAgentGrant, useSetAgentGrant } from '@/hooks/use-integrations'
import type { ActorResponse, AgentAccessView, AgentGrantAccess } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { AGENT_ACCESS_LABELS } from '@maskin/shared'

type IntegrationRowData = AgentAccessView['integrations'][number]
type CredentialRowData = AgentAccessView['credentials'][number]

const LEVELS: AgentGrantAccess[] = ['read', 'read_write', 'write']

/** Same rule as the Integrations and Keychain pages: whoever connected it, or an admin or owner. */
function useCanChange(createdBy: string): boolean {
	const { workspace } = useWorkspace()
	const me = getStoredActor()
	return (
		me?.type === 'human' &&
		(createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	)
}

function IntegrationRow({
	row,
	agentId,
	workspaceId,
}: {
	row: IntegrationRowData
	agentId: string
	workspaceId: string
}) {
	const setGrant = useSetAgentGrant(workspaceId, row.integration_id)
	const removeGrant = useRemoveAgentGrant(workspaceId, row.integration_id)
	const canChange = useCanChange(row.created_by)
	const busy = setGrant.isPending || removeGrant.isPending
	const value = row.source === 'default' ? 'default' : row.access

	return (
		<li className="flex flex-wrap items-center gap-2 py-2">
			<div className="min-w-0 flex-1 basis-40">
				<p className="truncate text-sm font-medium text-foreground">{row.name}</p>
				<p className="text-xs text-muted-foreground">
					{row.server_attached ? 'Tools attached' : 'No tools attached'}
				</p>
			</div>
			<Select
				value={value}
				onValueChange={(v) =>
					v === 'default'
						? removeGrant.mutate(agentId)
						: setGrant.mutate({ actorId: agentId, access: v as AgentGrantAccess })
				}
				disabled={!canChange || busy}
			>
				<SelectTrigger aria-label={`Access to ${row.name}`} className="w-full sm:w-44">
					<SelectValue />
				</SelectTrigger>
				<SelectContent>
					<SelectItem value="default">
						Default ({AGENT_ACCESS_LABELS[row.default_access]})
					</SelectItem>
					{LEVELS.map((level) => (
						<SelectItem key={level} value={level}>
							{AGENT_ACCESS_LABELS[level]}
						</SelectItem>
					))}
				</SelectContent>
			</Select>
		</li>
	)
}

function CredentialRow({
	row,
	agentId,
	workspaceId,
}: {
	row: CredentialRowData
	agentId: string
	workspaceId: string
}) {
	const setGrant = useSetAgentGrant(workspaceId, row.integration_id)
	const removeGrant = useRemoveAgentGrant(workspaceId, row.integration_id)
	const canChange = useCanChange(row.created_by)
	const busy = setGrant.isPending || removeGrant.isPending

	return (
		<li className="flex items-center gap-2 py-2">
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-foreground">{row.name}</p>
				<p className="text-xs text-muted-foreground">
					{row.kind === 'login' ? 'Login' : 'API key'} ·{' '}
					{row.has_access ? 'Has access' : 'No access'}
				</p>
			</div>
			<Switch
				checked={row.has_access}
				disabled={!canChange || busy}
				aria-label={`${row.name} for this agent`}
				onCheckedChange={(on) =>
					on
						? setGrant.mutate({ actorId: agentId, access: 'read_write' })
						: removeGrant.mutate(agentId)
				}
			/>
		</li>
	)
}

/**
 * What this agent can use, from the same description the launch prompt is built from, with
 * the same controls as the Integrations and Keychain pages. A change here is a change to the
 * integration's grants, so the other pages and the agent's next session see it too.
 */
export function AgentAccessSection({ agent }: { agent: ActorResponse }) {
	const { workspaceId } = useWorkspace()
	const { data } = useAgentAccess(workspaceId, agent.id)
	if (!data || (data.integrations.length === 0 && data.credentials.length === 0)) return null

	return (
		<section aria-labelledby="agent-access-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading id="agent-access-heading" title="Access" />
			<div className="rounded-xl border border-border bg-card px-4 py-2">
				{data.integrations.length > 0 && (
					<ul className="divide-y divide-border" aria-label="Integrations">
						{data.integrations.map((row) => (
							<IntegrationRow
								key={row.integration_id}
								row={row}
								agentId={agent.id}
								workspaceId={workspaceId}
							/>
						))}
					</ul>
				)}
				{data.credentials.length > 0 && (
					<>
						<p className="settings-label pb-1 pt-3">Keychain</p>
						<ul className="divide-y divide-border" aria-label="Keychain credentials">
							{data.credentials.map((row) => (
								<CredentialRow
									key={row.integration_id}
									row={row}
									agentId={agent.id}
									workspaceId={workspaceId}
								/>
							))}
						</ul>
					</>
				)}
				<p className="pb-2 pt-2 text-xs text-muted-foreground">
					Applies to new sessions. The same access is shown under Settings → Integrations and
					Keychain.
				</p>
			</div>
		</section>
	)
}
