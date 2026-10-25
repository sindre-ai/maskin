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
import type {
	AgentGrant,
	AgentGrantAccess,
	DefaultAgentAccess,
	IntegrationResponse,
} from '@/lib/api'
import { getStoredActor } from '@/lib/auth'
import { cn } from '@/lib/cn'
import { sortByName } from '@/lib/sort'
import { useWorkspace } from '@/lib/workspace-context'
import { AGENT_ACCESS_LABELS, requiresApprovalToAct } from '@maskin/shared'
import { ChevronRight } from 'lucide-react'
import { useState } from 'react'

/** The levels offered for one agent, and for "All other agents". */
export const ACCESS_ORDER: AgentGrantAccess[] = ['read', 'read_write', 'none']
export const DEFAULT_ACCESS_ORDER: DefaultAgentAccess[] = ['read', 'read_write', 'none']

/**
 * The one-line reading of who can do what, shown while the section is collapsed. The
 * default row covers every agent without an entry of its own, so the common case ("all
 * agents can read, two can also write") never needs a list.
 */
export function summarizeAgentAccess(
	defaultAccess: DefaultAgentAccess,
	grants: Pick<AgentGrant, 'access'>[],
): string {
	const writers = grants.filter((g) => g.access === 'read_write').length
	const blocked = grants.filter((g) => g.access === 'none').length
	if (defaultAccess === 'read_write') {
		const parts = ['All agents can read & write']
		const readers = grants.filter((g) => g.access === 'read').length
		if (readers > 0) parts.push(`${readers} can only read`)
		if (blocked > 0) parts.push(`${blocked} ${blocked === 1 ? 'has' : 'have'} no access`)
		return parts.join(' · ')
	}
	if (defaultAccess === 'read') {
		const parts = ['All agents can read']
		if (writers > 0) parts.push(`${writers} can also write`)
		if (blocked > 0) parts.push(`${blocked} ${blocked === 1 ? 'has' : 'have'} no access`)
		return parts.join(' · ')
	}
	const withAccess = grants.length - blocked
	if (withAccess === 0) return 'No agents have access'
	return `${withAccess} ${withAccess === 1 ? 'agent has' : 'agents have'} access`
}

/** What a newly added agent starts with: the step up from the default. */
export function startingAccess(defaultAccess: DefaultAgentAccess): AgentGrantAccess {
	// When every agent already writes, an entry of its own can only hold one back.
	return defaultAccess === 'read' ? 'read_write' : 'read'
}

/**
 * Whether an agent's access is what every agent without an entry already gets. For a key,
 * the default's 'read' means Full access, which is `read_write` on an entry.
 */
export function matchesDefault(
	defaultAccess: DefaultAgentAccess,
	access: AgentGrantAccess,
	isKey = false,
): boolean {
	if (isKey) return (defaultAccess === 'read') === (access !== 'none')
	return access === defaultAccess
}

/** A saved key is on or off per agent, so these two are its only levels. */
const KEY_ACCESS_LABELS = { read_write: 'Full access', none: 'No access' } as const
const KEY_ACCESS_ORDER: AgentGrantAccess[] = ['read_write', 'none']
const KEY_DEFAULT_ORDER: DefaultAgentAccess[] = ['read', 'none']

/** The collapsed line for a saved key: who has it, in words. */
export function summarizeKeyAccess(
	defaultAccess: DefaultAgentAccess,
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
	const agents = sortByName((actors ?? []).filter((a) => a.type === 'agent'))
	// Walk the sorted agents (not the grants) so the listed rows are alphabetical too.
	const listed = agents.flatMap((agent) => {
		const grant = grants.find((g) => g.actorId === agent.id)
		return grant ? [{ agent, access: grant.access }] : []
	})
	const addable = agents.filter((a) => !grants.some((g) => g.actorId === a.id))

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
							onValueChange={(v) => setDefault.mutate(v as DefaultAgentAccess)}
							disabled={!canEdit || busy}
						>
							<SelectTrigger aria-label="Access for all other agents" className="w-full sm:w-36">
								<SelectValue />
							</SelectTrigger>
							<SelectContent>
								{(isKey ? KEY_DEFAULT_ORDER : DEFAULT_ACCESS_ORDER).map((a) => (
									<SelectItem key={a} value={a}>
										{isKey && a === 'read' ? 'Full access' : AGENT_ACCESS_LABELS[a]}
									</SelectItem>
								))}
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
										{(isKey ? KEY_ACCESS_ORDER : ACCESS_ORDER).map((a) => (
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
										: startingAccess(defaultAccess),
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

					{requiresApprovalToAct(integration.provider) && (
						<p className="text-xs text-muted-foreground">
							Read & write lets an agent write drafts. Each email still waits for your approval in
							the chat before it is sent.
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
