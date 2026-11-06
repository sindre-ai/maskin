import { Button } from '@/components/ui/button'
import { Spinner } from '@/components/ui/spinner'
import { useSetAgentGrant } from '@/hooks/use-integrations'
import type { IntegrationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { useWorkspace } from '@/lib/workspace-context'
import { Plus } from 'lucide-react'

/**
 * Same rule as the access editor on the agent page: whoever connected the integration, or a
 * workspace admin or owner, may give an agent access to it.
 */
export function useCanGiveAgentAccess(): (integration: IntegrationResponse | undefined) => boolean {
	const { workspace } = useWorkspace()
	const me = getStoredActor()
	return (integration) =>
		me?.type === 'human' &&
		integration !== undefined &&
		(integration.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
}

/**
 * The button on an intro's tool row when the tool is connected but the agent has no access to
 * it. One click is the same grant as the switch on the agent page (Read & write for this agent
 * only), so the agent's next session has the tool. The row turns to "Connected, ready to use"
 * by itself once the integration list refreshes.
 */
export function AddToAgentButton({
	workspaceId,
	integration,
	toolName,
	agentId,
	agentName,
}: {
	workspaceId: string
	integration: IntegrationResponse
	/** What the person sees the tool called, e.g. Gmail. */
	toolName: string
	agentId: string
	agentName: string
}) {
	const setGrant = useSetAgentGrant(workspaceId, integration.id)
	return (
		<Button
			variant="outline"
			size="sm"
			disabled={setGrant.isPending}
			onClick={() => setGrant.mutate({ actorId: agentId, access: 'read_write' })}
			aria-label={`Add ${toolName} to ${agentName}`}
		>
			{setGrant.isPending ? <Spinner className="mr-1" /> : <Plus className="mr-1 h-3.5 w-3.5" />}
			Add to {agentName}
		</Button>
	)
}
