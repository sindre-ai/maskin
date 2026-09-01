// ---------------------------------------------------------------------------
// What an agent is actually allowed to use.
//
// Pure functions over rows, so the rules can be tested without a database and
// reused by the two very different enforcement points: the session launch (which
// withholds MCP servers and credentials from the container) and the tool-broker
// toolkit (which is default-deny upstream).
//
// The resolution rule is deliberately narrow: an agent's own grant, else the
// workspace ceiling ONLY as an upper bound, else nothing. A workspace-level row
// never grants on its own — it says what an agent MAY be given, not what it has.
// ---------------------------------------------------------------------------

export type GrantMode = 'all' | 'read' | 'custom'

export interface GrantRow {
	actorId: string | null
	integrationRef: string
	mode: GrantMode
	tools: string[]
}

/** One integration's tools, as collected from the server's own `tools/list`. */
export interface KnownTool {
	name: string
	/** NULL where the server did not declare it. Never treated as read. */
	readOnly: boolean | null
}

/** What an agent may use for one integration. */
export interface ResolvedGrant {
	integrationRef: string
	mode: GrantMode
	/**
	 * The concrete tool names allowed.
	 *
	 * Empty with mode `all` means "every tool, including ones we have not listed
	 * yet" — the two are not the same and callers must not conflate them, which is
	 * why `mode` is kept alongside rather than being flattened into a list.
	 */
	tools: string[]
}

/**
 * Narrow one grant by another.
 *
 * Used to clamp an agent's grant to the workspace ceiling. `all` is the widest,
 * so anything narrows it; two explicit lists intersect.
 */
const narrow = (agent: GrantRow, ceiling: GrantRow, known: KnownTool[]): ResolvedGrant => {
	const expand = (row: GrantRow): string[] | null => {
		if (row.mode === 'all') return null // null = unbounded
		if (row.mode === 'read') return known.filter((t) => t.readOnly === true).map((t) => t.name)
		return row.tools
	}

	const a = expand(agent)
	const c = expand(ceiling)

	if (a === null && c === null)
		return { integrationRef: agent.integrationRef, mode: 'all', tools: [] }
	if (a === null) return { integrationRef: agent.integrationRef, mode: 'custom', tools: c ?? [] }
	if (c === null) return { integrationRef: agent.integrationRef, mode: agent.mode, tools: a }

	const allowed = new Set(c)
	return {
		integrationRef: agent.integrationRef,
		mode: 'custom',
		tools: a.filter((name) => allowed.has(name)),
	}
}

/**
 * Resolve every grant that applies to one agent.
 *
 * `known` supplies the tool list per integration, needed only to turn a `read`
 * grant into concrete names. An integration with no known tools and a `read`
 * grant resolves to NOTHING rather than everything — failing closed, because the
 * alternative is handing over write tools we simply have not classified yet.
 */
export const resolveGrantsForAgent = (
	rows: GrantRow[],
	knownByIntegration: Map<string, KnownTool[]>,
): ResolvedGrant[] => {
	const agentRows = new Map<string, GrantRow>()
	const workspaceRows = new Map<string, GrantRow>()
	for (const row of rows) {
		if (row.actorId) agentRows.set(row.integrationRef, row)
		else workspaceRows.set(row.integrationRef, row)
	}

	const resolved: ResolvedGrant[] = []
	for (const [ref, agentRow] of agentRows) {
		const known = knownByIntegration.get(ref) ?? []
		const ceiling = workspaceRows.get(ref)
		const grant = ceiling ? narrow(agentRow, ceiling, known) : expandAlone(agentRow, known)
		// A grant that resolves to no tools at all is the same as not having it,
		// and keeping it would render an integration the agent cannot use.
		if (grant.mode === 'all' || grant.tools.length > 0) resolved.push(grant)
	}
	return resolved
}

const expandAlone = (row: GrantRow, known: KnownTool[]): ResolvedGrant => {
	if (row.mode === 'all') return { integrationRef: row.integrationRef, mode: 'all', tools: [] }
	if (row.mode === 'read') {
		return {
			integrationRef: row.integrationRef,
			mode: 'read',
			tools: known.filter((t) => t.readOnly === true).map((t) => t.name),
		}
	}
	return { integrationRef: row.integrationRef, mode: 'custom', tools: row.tools }
}

/**
 * The integration refs an agent may use at all.
 *
 * This is what the session launch filters on: it withholds whole MCP servers and
 * their credentials, since a container-side server cannot be filtered tool by
 * tool without proxying it.
 */
export const allowedIntegrationRefs = (resolved: ResolvedGrant[]): Set<string> =>
	new Set(resolved.map((g) => g.integrationRef))
