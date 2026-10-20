import { Button } from '@/components/ui/button'
import { useActors } from '@/hooks/use-actors'
import { useApproveIntegrationAttach, useMcpPresets } from '@/hooks/use-integrations'
import { useWorkspaceMembers } from '@/hooks/use-workspaces'
import { getStoredActor } from '@/lib/auth'
import { Check, KeyRound } from 'lucide-react'

interface IntegrationAttachCardProps {
	workspaceId: string
	/** The agent that would receive the integration. */
	actorId: string
	/** Which preset, from the API's preset list. */
	presetId: string
}

/**
 * The Approve card an agent puts in chat via `propose_integration_attach`.
 *
 * The agent only asked: nothing is written until a human workspace admin or
 * owner clicks here, and the server then re-derives the entry from the
 * workspace's active integrations, so the click carries ids and nothing else.
 *
 * State is read live rather than stored on the message, like the Connect card:
 * once the agent holds the entry the card says so by itself, and a preset whose
 * integration was disconnected since shows as unavailable instead of offering a
 * stale button. A member who cannot approve sees who can, not a dead button.
 */
export function IntegrationAttachCard({
	workspaceId,
	actorId,
	presetId,
}: IntegrationAttachCardProps) {
	const { data, isLoading } = useMcpPresets(workspaceId, { actorId, includeAffected: true })
	const { data: actors } = useActors(workspaceId)
	const { data: members } = useWorkspaceMembers(workspaceId)
	const approve = useApproveIntegrationAttach(workspaceId)

	if (isLoading || !data) return null

	const agentName = actors?.find((a) => a.id === actorId)?.name ?? 'this agent'
	const me = members?.find((m) => m.actorId === getStoredActor()?.id)
	const canApprove = me?.type === 'human' && (me.role === 'admin' || me.role === 'owner')
	const preset = data.presets.find((p) => p.preset_id === presetId)

	let body: React.ReactNode
	if (!preset) {
		body = (
			<p className="text-[13px] text-muted-foreground">
				This integration is no longer connected, so there is nothing to attach.
			</p>
		)
	} else if (preset.attached) {
		body = (
			<p className="flex items-center gap-1.5 text-[13px] text-foreground">
				<Check size={14} className="shrink-0" aria-hidden />
				{agentName} can use {preset.label}.
			</p>
		)
	} else if (!canApprove) {
		body = (
			<p className="text-[13px] text-muted-foreground">
				Waiting for a workspace admin to approve {agentName} using {preset.label}.
			</p>
		)
	} else {
		// Everyone a disconnect stripped this from, plus the agent asked about.
		const affectedIds = new Set((preset.affected_agents ?? []).map((a) => a.id))
		affectedIds.add(actorId)
		body = (
			<div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
				<Button
					size="sm"
					disabled={approve.isPending}
					onClick={() => approve.mutate({ actorId, presetId })}
				>
					Allow {agentName} to use {preset.label}
				</Button>
				{affectedIds.size > 1 ? (
					<Button
						size="sm"
						variant="outline"
						disabled={approve.isPending}
						onClick={() => approve.mutate({ actorId, presetId, allAffected: true })}
					>
						Attach to all {affectedIds.size} affected agents
					</Button>
				) : null}
			</div>
		)
	}

	return (
		<div className="mt-2 flex max-w-[660px] flex-col gap-2 rounded-xl border border-border bg-card px-4 py-3">
			<div className="flex items-center gap-2 text-[14px] font-semibold text-foreground">
				<KeyRound size={16} className="shrink-0 text-muted-foreground" aria-hidden />
				Approve tool access
			</div>
			{body}
		</div>
	)
}
