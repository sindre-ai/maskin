import { IntegrationConnectCard } from '@/components/chat/integration-connect-card'
import { useActor } from '@/hooks/use-actors'
import { useIntegrations, useProviders } from '@/hooks/use-integrations'
import { integrationToolState } from '@/lib/integration-tool-state'
import type { NeededTool } from '@maskin/shared'
import { Link } from '@tanstack/react-router'
import { Check } from 'lucide-react'

const MAX_ROWS = 3

interface NeededToolsProps {
	workspaceId: string
	conversationId: string
	agentId: string
	agentName: string
	/** The providers the intro says the job needs, in the writer's order. */
	tools: NeededTool[]
}

/**
 * The tools an agent's intro says the job needs, one row each, 3 at most and in
 * the writer's order (rows never re-sort when a state changes). Status is read
 * live, never stored on the message, so a scrolled-back intro never shows a
 * stale button. A missing tool is the existing Connect card; a row says the
 * agent can use the tool only when it can.
 */
export function NeededTools({
	workspaceId,
	conversationId,
	agentId,
	agentName,
	tools,
}: NeededToolsProps) {
	const { data: providers } = useProviders()
	const { data: integrations } = useIntegrations(workspaceId)
	const { data: agent } = useActor(agentId)

	// Until both lists have loaded there is nothing honest to draw, and a failed
	// load draws nothing either. The card itself also draws nothing for an unknown
	// provider.
	if (!providers || !integrations) return null

	const agentMcpServers = (agent?.tools as { mcpServers?: Record<string, unknown> } | undefined)
		?.mcpServers

	const rows = tools.slice(0, MAX_ROWS).flatMap(({ provider }) => {
		const info = providers.find((p) => p.name === provider)
		if (!info) return []
		return [
			{
				info,
				state: integrationToolState({ provider: info, integrations, agentMcpServers }),
			},
		]
	})
	if (rows.length === 0) return null

	if (rows.every((row) => row.state === 'ready')) {
		return (
			<p className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
				<Check size={13} aria-hidden className="shrink-0 text-success" />
				<span>Connected: {rows.map((row) => row.info.displayName).join(', ')}</span>
			</p>
		)
	}

	const needsSetup = rows.some((row) => row.state === 'connected_not_on_agent')
	const sharingOff = rows.some((row) => row.state === 'sharing_off')

	return (
		<section className="flex flex-col gap-1" data-testid="needed-tools">
			<h3 className="eyebrow">Tools for this job</h3>
			{rows.map(({ info, state }) => (
				<IntegrationConnectCard
					key={info.name}
					introState={state}
					workspaceId={workspaceId}
					conversationId={conversationId}
					provider={info.name}
				/>
			))}
			{needsSetup ? (
				<Link
					to="/$workspaceId/agents/$agentId"
					params={{ workspaceId, agentId }}
					className="mt-1 text-[12.5px] text-brand hover:underline"
				>
					Set up {agentName}'s tools →
				</Link>
			) : null}
			{sharingOff ? (
				<p className="mt-1 text-[12.5px] text-muted-foreground">
					Connected, but sharing with agents is off. An admin can switch it on in Settings,
					Integrations.
				</p>
			) : null}
		</section>
	)
}
