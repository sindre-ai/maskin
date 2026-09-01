import { type Database, integrationTools, toolGrants } from '@maskin/db'
import { and, eq, isNull, or } from 'drizzle-orm'
import {
	type GrantMode,
	type GrantRow,
	type KnownTool,
	type ResolvedGrant,
	allowedIntegrationRefs,
	resolveGrantsForAgent,
} from './resolve'

// ---------------------------------------------------------------------------
// What one agent may use, loaded once per session launch.
//
// The launch filters at the POINT OF INJECTION rather than stripping afterwards,
// because a credential and its MCP server are written in the same place and only
// removing the server leaves the token in the container — which is the gap this
// whole feature exists to close. An agent with no Slack tool must not hold the
// Slack token, particularly since the CLI runs with permission checks off.
// ---------------------------------------------------------------------------

export interface SessionGrants {
	/**
	 * Whether grants govern this workspace at all.
	 *
	 * FALSE means "no grant rows exist here", which must behave exactly as before
	 * this feature — every integration reaches every agent. The distinction is
	 * load-bearing: an empty allow-list and an absent policy look identical if you
	 * only carry `refs`, and treating the second as the first would revoke every
	 * integration in every workspace the moment this shipped.
	 *
	 * Enforcement therefore begins when a workspace gets its first grant, and the
	 * backfill writes rows for what each agent can already reach, so switching on
	 * changes nothing until someone narrows something.
	 */
	readonly enforced: boolean
	/** Integration refs this agent may use at all. Only meaningful when enforced. */
	readonly refs: ReadonlySet<string>
	/** Full resolution, for the broker toolkit which can scope tool by tool. */
	readonly resolved: readonly ResolvedGrant[]
}

/** No policy in this workspace — legacy behaviour, everything reaches every agent. */
export const NO_GRANTS: SessionGrants = { enforced: false, refs: new Set(), resolved: [] }

/** Is this integration allowed for the agent? Unenforced workspaces allow all. */
export const grantsAllow = (grants: SessionGrants, ref: string): boolean =>
	!grants.enforced || grants.refs.has(ref)

export const loadSessionGrants = async (
	db: Database,
	input: { workspaceId: string; actorId: string },
): Promise<SessionGrants> => {
	const rows = await db
		.select({
			actorId: toolGrants.actorId,
			integrationRef: toolGrants.integrationRef,
			mode: toolGrants.mode,
			tools: toolGrants.tools,
		})
		.from(toolGrants)
		.where(
			and(
				eq(toolGrants.workspaceId, input.workspaceId),
				// The agent's own rows plus the workspace ceiling; resolution needs
				// both, since a ceiling narrows a grant but never creates one.
				or(eq(toolGrants.actorId, input.actorId), isNull(toolGrants.actorId)),
			),
		)

	// Only well-formed rows decide anything. This reads defensive, but the value
	// being computed is an authorization outcome, and a row that is not a grant
	// must not be able to flip a whole workspace into enforcement — the failure
	// there is silent and total: every agent loses every integration.
	//
	// Enforcement follows the well-formed rows, so a malformed one leaves the
	// workspace exactly as it was rather than half-applying a policy.
	const grantRows = rows.filter(
		(row): row is typeof row & { integrationRef: string; mode: GrantMode } =>
			typeof row.integrationRef === 'string' &&
			row.integrationRef.length > 0 &&
			(row.mode === 'all' || row.mode === 'read' || row.mode === 'custom'),
	)

	if (grantRows.length === 0) return NO_GRANTS

	const tools = await db
		.select({
			integrationRef: integrationTools.integrationRef,
			name: integrationTools.name,
			readOnly: integrationTools.readOnly,
		})
		.from(integrationTools)
		.where(eq(integrationTools.workspaceId, input.workspaceId))

	const known = new Map<string, KnownTool[]>()
	for (const tool of tools) {
		const list = known.get(tool.integrationRef) ?? []
		list.push({ name: tool.name, readOnly: tool.readOnly })
		known.set(tool.integrationRef, list)
	}

	const resolved = resolveGrantsForAgent(
		grantRows.map(
			(row): GrantRow => ({
				actorId: row.actorId,
				integrationRef: row.integrationRef,
				mode: row.mode as GrantMode,
				tools: row.tools ?? [],
			}),
		),
		known,
	)

	return { enforced: true, refs: allowedIntegrationRefs(resolved), resolved }
}

/**
 * The MCP server key a workspace integration is injected under.
 *
 * These strings are the grant's `integration_ref`, so the two sides cannot drift
 * apart — a change here without a matching migration would silently revoke every
 * grant rather than fail loudly.
 */
export const integrationRefFor = {
	provider: (provider: string) => `integration-${provider}`,
	githubOwner: (ownerLogin: string) => `github-${ownerLogin.toLowerCase()}`,
} as const
