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
import { sortByName } from '@/lib/sort'
import { useWorkspace } from '@/lib/workspace-context'
import { AGENT_ACCESS_LABELS } from '@maskin/shared'
import { Lock } from 'lucide-react'

type IntegrationRowData = AgentAccessView['integrations'][number]
type CredentialRowData = AgentAccessView['credentials'][number]

const LEVELS: AgentGrantAccess[] = ['read', 'read_write', 'none']

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

/**
 * A custom tool server: on or off for this agent. Turning it on for one agent is the same
 * grant as on the Integrations page, so this is a shortcut, not a second place to configure.
 */
function ToolServerRow({
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
	const on = row.access !== 'none'
	// Back to the default when the choice matches it, so the grant list stays free of redundant rows.
	const matchesDefault = (next: boolean) => next === (row.default_access !== 'none')

	return (
		<li className="flex items-center gap-2 py-2">
			<div className="min-w-0 flex-1">
				<p className="truncate text-sm font-medium text-foreground">{row.name}</p>
			</div>
			<Switch
				checked={on}
				disabled={!canChange || busy}
				aria-label={`${row.name} for this agent`}
				onCheckedChange={(next) =>
					matchesDefault(next)
						? removeGrant.mutate(agentId)
						: setGrant.mutate({ actorId: agentId, access: next ? 'read_write' : 'none' })
				}
			/>
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
			</div>
			<Switch
				checked={row.has_access}
				disabled={!canChange || busy}
				aria-label={`${row.name} for this agent`}
				onCheckedChange={(on) =>
					// Back to the key's default when the choice matches it; otherwise an entry of its own.
					on === (row.default_access === 'read')
						? removeGrant.mutate(agentId)
						: setGrant.mutate({ actorId: agentId, access: on ? 'read_write' : 'none' })
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
	if (!data) return null
	// A tool server Maskin cannot sit in front of (one that runs in the container) is on or off;
	// everything else, custom servers included, has Read / Read & write / No access.
	const isSwitchRow = (r: IntegrationRowData) => r.kind === 'tool_server' && !r.gated
	// One alphabetical list: the Maskin row stays first (fixed, built in), the rest sort by name
	// whichever control they use.
	const toolRows = sortByName(data.integrations, (r) => r.integration_id)
	const credentialRows = sortByName(data.credentials, (r) => r.integration_id)

	return (
		<section aria-labelledby="agent-access-heading" className="flex flex-col gap-2.5">
			<AgentSectionHeading id="agent-access-heading" title="Access" />
			<div className="rounded-xl border border-border bg-card px-4 py-2">
				<p className="settings-label pb-1 pt-1">Tools</p>
				<ul className="divide-y divide-border" aria-label="Tools">
					{/* On every agent and not changeable: without it an agent cannot do anything in Maskin. */}
					<li className="flex items-center gap-2 py-2">
						<p className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
							{data.maskin_mcp.name}
						</p>
						<span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
							<Lock className="h-3.5 w-3.5" aria-hidden="true" />
							{AGENT_ACCESS_LABELS[data.maskin_mcp.access]}
						</span>
					</li>
					{toolRows.map((row) =>
						isSwitchRow(row) ? (
							<ToolServerRow
								key={row.integration_id}
								row={row}
								agentId={agent.id}
								workspaceId={workspaceId}
							/>
						) : (
							<IntegrationRow
								key={row.integration_id}
								row={row}
								agentId={agent.id}
								workspaceId={workspaceId}
							/>
						),
					)}
				</ul>
				{data.credentials.length > 0 && (
					<>
						<p className="settings-label pb-1 pt-3">Keychain</p>
						<ul className="divide-y divide-border" aria-label="Keychain credentials">
							{credentialRows.map((row) => (
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
					Applies to new sessions. Add or edit custom tools under Settings → Integrations; the same
					access is shown there and under Keychain.
				</p>
			</div>
		</section>
	)
}
