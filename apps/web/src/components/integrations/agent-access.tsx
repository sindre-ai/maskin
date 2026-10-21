import { ActorAvatar } from '@/components/shared/actor-avatar'
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
import { AGENT_ACCESS_LABELS, supportsAskFirst } from '@maskin/shared'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

const ACCESS_ORDER: AgentGrantAccess[] = ['read', 'read_write', 'none']
/** Gmail adds the middle step: the agent may draft, but each email waits for a person. */
const ACCESS_ORDER_ASK_FIRST: AgentGrantAccess[] = ['read', 'ask_first', 'read_write', 'none']

export const accessOrderFor = (provider: string): AgentGrantAccess[] =>
	supportsAskFirst(provider) ? ACCESS_ORDER_ASK_FIRST : ACCESS_ORDER

/**
 * The one-line reading of who can do what, shown while the section is collapsed. The
 * default row covers every agent without an entry of its own, so the common case ("all
 * agents can read, two can also write") never needs a list.
 */
export function summarizeAgentAccess(
	defaultAccess: 'read' | 'none',
	grants: Pick<AgentGrant, 'access'>[],
): string {
	const writers = grants.filter((g) => g.access === 'read_write').length
	const asking = grants.filter((g) => g.access === 'ask_first').length
	const blocked = grants.filter((g) => g.access === 'none').length
	if (defaultAccess === 'read') {
		const parts = ['All agents can read']
		if (writers > 0) parts.push(`${writers} can also write`)
		if (asking > 0) parts.push(`${asking} can write after you approve`)
		if (blocked > 0) parts.push(`${blocked} ${blocked === 1 ? 'has' : 'have'} no access`)
		return parts.join(' · ')
	}
	const withAccess = grants.length - blocked
	if (withAccess === 0) return 'No agents have access'
	return `${withAccess} ${withAccess === 1 ? 'agent has' : 'agents have'} access`
}

/** What a newly added agent starts with: the step up from the default. */
export function startingAccess(
	defaultAccess: 'read' | 'none',
	provider?: string,
): AgentGrantAccess {
	// An agent added to Gmail starts by asking first, never by sending on its own.
	if (provider && supportsAskFirst(provider)) return 'ask_first'
	return defaultAccess === 'read' ? 'read_write' : 'read'
}

/**
 * Whether an agent's access is what every agent without an entry already gets. For a key,
 * the default's 'read' means Full access, which is `read_write` on an entry.
 */
export function matchesDefault(
	defaultAccess: 'read' | 'none',
	access: AgentGrantAccess,
	isKey = false,
): boolean {
	if (isKey) return (defaultAccess === 'read') === (access !== 'none')
	return access === defaultAccess
}

/** A saved key is on or off per agent, so these two are its only levels. */
const KEY_ACCESS_LABELS = { read_write: 'Full access', none: 'No access' } as const
const KEY_ACCESS_ORDER: AgentGrantAccess[] = ['read_write', 'none']

/** The collapsed line for a saved key: who has it, in words. */
export function summarizeKeyAccess(
	defaultAccess: 'read' | 'none',
	grants: Pick<AgentGrant, 'access'>[],
): string {
	const blocked = grants.filter((g) => g.access === 'none').length
	if (defaultAccess === 'read') {
		const base = 'All agents have access'
		return blocked > 0 ? `${base} · ${blocked} ${blocked === 1 ? 'has' : 'have'} no access` : base
	}
	const withAccess = grants.length - blocked
	if (withAccess === 0) return 'No agents have access'
	return `${withAccess} ${withAccess === 1 ? 'agent has' : 'agents have'} access`
}

/**
 * Agent access for one integration: a default for every agent without an entry, and
 * per-agent overrides. Collapsed by default so a workspace with many agents does not
 * turn the page into a wall of rows; only agents that differ from the default are listed.
 *
 * `kind="key"` is the same panel for a saved Keychain credential, whose only levels are
 * Full access and No access. It starts at No access for every agent.
 */
export function AgentAccess({
	integration,
	workspaceId,
	kind = 'integration',
}: {
	integration: IntegrationResponse
	workspaceId: string
	kind?: 'integration' | 'key'
}) {
	const isKey = kind === 'key'
	const [open, setOpen] = useState(false)
	const { workspace } = useWorkspace()
	const { data: actors } = useActors(workspaceId)
	const setGrant = useSetAgentGrant(workspaceId, integration.id)
	const removeGrant = useRemoveAgentGrant(workspaceId, integration.id)
	const setDefault = useSetDefaultAgentAccess(workspaceId, integration.id)

	const defaultAccess = integration.defaultAgentAccess ?? (isKey ? 'none' : 'read')
	const grants = integration.agentGrants ?? []
	const agents = (actors ?? []).filter((a) => a.type === 'agent')
	const listed = grants
		.flatMap((g) => {
			const agent = agents.find((a) => a.id === g.actorId)
			return agent ? [{ agent, access: g.access }] : []
		})
		.sort((a, b) => a.agent.name.localeCompare(b.agent.name))
	const addable = agents
		.filter((a) => !grants.some((g) => g.actorId === a.id))
		.sort((a, b) => a.name.localeCompare(b.name))

	const me = getStoredActor()
	const canEdit =
		me?.type === 'human' &&
		(integration.createdBy === me.id || workspace.role === 'owner' || workspace.role === 'admin')
	const busy = setGrant.isPending || removeGrant.isPending || setDefault.isPending

	// An agent set to what "All other agents" already get has nothing of its own to keep: its entry
	// goes and it falls back into that group. For a key, Full access is the default's 'read'.
	const changeAgent = (actorId: string, access: AgentGrantAccess) => {
		if (matchesDefault(defaultAccess, access, isKey)) removeGrant.mutate(actorId)
		else setGrant.mutate({ actorId, access })
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
				<span className="settings-label shrink-0">Agent access</span>
				<span className="min-w-0 text-muted-foreground">
					{isKey
						? summarizeKeyAccess(defaultAccess, grants)
						: summarizeAgentAccess(defaultAccess, grants)}
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
								<SelectItem value="read">
									{isKey ? 'Full access' : AGENT_ACCESS_LABELS.read}
								</SelectItem>
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
									value={isKey ? (access === 'none' ? 'none' : 'read_write') : access}
									onValueChange={(v) => changeAgent(agent.id, v as AgentGrantAccess)}
									disabled={!canEdit || busy}
								>
									<SelectTrigger aria-label={`Access for ${agent.name}`} className="w-full sm:w-36">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{(isKey ? KEY_ACCESS_ORDER : accessOrderFor(integration.provider)).map((a) => (
											<SelectItem key={a} value={a}>
												{isKey && (a === 'read_write' || a === 'none')
													? KEY_ACCESS_LABELS[a]
													: AGENT_ACCESS_LABELS[a]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
						</div>
					))}

					{canEdit && addable.length > 0 && (
						<Select
							value=""
							onValueChange={(actorId) =>
								setGrant.mutate({
									actorId,
									access: isKey
										? defaultAccess === 'read'
											? 'none'
											: 'read_write'
										: startingAccess(defaultAccess, integration.provider),
								})
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

					{supportsAskFirst(integration.provider) && (
						<p className="text-xs text-muted-foreground">
							Ask first: the agent can write drafts, and each email waits for your approval in the
							chat. Read & write: it sends on its own, except to contacts you marked protected.
						</p>
					)}

					<p className="text-xs text-muted-foreground">
						{canEdit
							? isKey
								? 'Applies to new sessions. A session already running keeps the key until it ends.'
								: 'Applies to new sessions. A session already running keeps the access it started with.'
							: isKey
								? 'Only the person who saved this key or a workspace admin can change who can use it.'
								: 'Only the person who connected this or a workspace admin can change agent access.'}
					</p>
				</div>
			)}
		</div>
	)
}
