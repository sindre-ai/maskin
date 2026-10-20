import { ActorAvatar } from '@/components/shared/actor-avatar'
import { Button } from '@/components/ui/button'
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from '@/components/ui/select'
import { useActors } from '@/hooks/use-actors'
import {
	useRemoveAgentGrant,
	useSetAgentGrant,
	useSetDefaultAgentAccess,
} from '@/hooks/use-integrations'
import type { AgentGrant, AgentGrantAccess, IntegrationResponse } from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { useWorkspace } from '@/lib/workspace-context'
import { AGENT_ACCESS_LABELS } from '@maskin/shared'
import { ChevronRight, X } from 'lucide-react'
import { useState } from 'react'

const ACCESS_ORDER: AgentGrantAccess[] = ['read', 'read_write', 'write']

/**
 * The one-line reading of who can do what, shown while the section is collapsed. The
 * default row covers every agent without an entry of its own, so the common case ("all
 * agents can read, two can also write") never needs a list.
 */
export function summarizeAgentAccess(
	defaultAccess: 'read' | 'none',
	grants: Pick<AgentGrant, 'access'>[],
): string {
	const writers = grants.filter((g) => g.access !== 'read').length
	if (defaultAccess === 'read') {
		const base = 'All agents can read'
		if (writers === 0) return base
		return `${base} · ${writers} can also write`
	}
	if (grants.length === 0) return 'No agents have access'
	return `${grants.length} ${grants.length === 1 ? 'agent has' : 'agents have'} access`
}

/** What a newly added agent starts with: the step up from the default. */
export function startingAccess(defaultAccess: 'read' | 'none'): AgentGrantAccess {
	return defaultAccess === 'read' ? 'read_write' : 'read'
}

/**
 * Agent access for one integration: a default for every agent without an entry, and
 * per-agent overrides. Collapsed by default so a workspace with many agents does not
 * turn the page into a wall of rows; only agents that differ from the default are listed.
 */
export function AgentAccess({
	integration,
	workspaceId,
}: {
	integration: IntegrationResponse
	workspaceId: string
}) {
	const [open, setOpen] = useState(false)
	const { workspace } = useWorkspace()
	const { data: actors } = useActors(workspaceId)
	const setGrant = useSetAgentGrant(workspaceId, integration.id)
	const removeGrant = useRemoveAgentGrant(workspaceId, integration.id)
	const setDefault = useSetDefaultAgentAccess(workspaceId, integration.id)

	const defaultAccess = integration.defaultAgentAccess ?? 'read'
	const grants = integration.agentGrants ?? []
	const agents = (actors ?? []).filter((a) => a.type === 'agent')
	const listed = grants.flatMap((g) => {
		const agent = agents.find((a) => a.id === g.actorId)
		return agent ? [{ agent, access: g.access }] : []
	})
	const addable = agents.filter((a) => !grants.some((g) => g.actorId === a.id))

	const me = getStoredActor()
	const canEdit =
		me?.type === 'human' &&
		(integration.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	const busy = setGrant.isPending || removeGrant.isPending || setDefault.isPending

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
				<span className="settings-label shrink-0">Agent access</span>
				<span className="min-w-0 text-muted-foreground">
					{summarizeAgentAccess(defaultAccess, grants)}
				</span>
			</button>

			{open && (
				<div className="mt-2 space-y-2">
					<div className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-surface p-2.5">
						<div className="min-w-0 flex-1 basis-40">
							<p className="text-sm font-medium text-foreground">All other agents</p>
							<p className="text-xs text-muted-foreground">Agents without their own entry below</p>
						</div>
						<Select
							value={defaultAccess}
							onValueChange={(v) => setDefault.mutate(v as 'read' | 'none')}
							disabled={!canEdit || busy}
						>
							<SelectTrigger aria-label="Access for all other agents" className="w-full sm:w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								<SelectItem value="read">{AGENT_ACCESS_LABELS.read}</SelectItem>
								<SelectItem value="none">{AGENT_ACCESS_LABELS.none}</SelectItem>
							</SelectContent>
						</Select>
					</div>

					{listed.map(({ agent, access }) => (
						<div
							key={agent.id}
							className="flex flex-wrap items-center gap-2 rounded-md border border-border bg-bg-surface p-2.5"
						>
							<div className="flex min-w-0 flex-1 basis-40 items-center gap-2">
								<ActorAvatar name={agent.name} type={agent.type} size="sm" />
								<p className="truncate text-sm font-medium text-foreground">{agent.name}</p>
							</div>
							<div className="flex items-center gap-1">
								<Select
									value={access}
									onValueChange={(v) =>
										setGrant.mutate({ actorId: agent.id, access: v as AgentGrantAccess })
									}
									disabled={!canEdit || busy}
								>
									<SelectTrigger aria-label={`Access for ${agent.name}`} className="w-full sm:w-36">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{ACCESS_ORDER.map((a) => (
											<SelectItem key={a} value={a}>
												{AGENT_ACCESS_LABELS[a]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
								{canEdit && (
									<Button
										variant="ghost"
										size="icon"
										className="h-8 w-8 shrink-0 text-muted-foreground hover:text-error"
										aria-label={`Remove ${agent.name}`}
										onClick={() => removeGrant.mutate(agent.id)}
										disabled={busy}
									>
										<X className="h-4 w-4" />
									</Button>
								)}
							</div>
						</div>
					))}

					{canEdit && addable.length > 0 && (
						<Select
							value=""
							onValueChange={(actorId) =>
								setGrant.mutate({ actorId, access: startingAccess(defaultAccess) })
							}
							disabled={busy}
						>
							<SelectTrigger aria-label="Add an agent" className="w-full sm:w-56">
								<SelectValue placeholder="Add an agent…" />
							</SelectTrigger>
							<SelectContent>
								{addable.map((a) => (
									<SelectItem key={a.id} value={a.id}>
										{a.name}
									</SelectItem>
								))}
							</SelectContent>
						</Select>
					)}

					<p className="text-xs text-muted-foreground">
						{canEdit
							? 'Applies to new sessions. A session already running keeps the access it started with.'
							: 'Only the person who connected this or a workspace admin can change agent access.'}
					</p>
				</div>
			)}
		</div>
	)
}
