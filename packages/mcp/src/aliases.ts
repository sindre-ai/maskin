// The alias table: one row per old parameter spelling that still works.
//
// Callers (stored prompts, older agents) send a name the tool no longer
// advertises. The rows below tell `normaliseArgs` (./alias-layer.ts) how to
// turn each old spelling into the canonical one before the MCP SDK validates
// the call. `tools/list` is generated from the canonical shape, so it only
// ever shows the new names.
//
// Canonical names are whatever each tool advertises today (read from the live
// `tools/list`); a row only adds a second spelling. Nothing here renames or
// removes a canonical name.

export type AliasKind =
	// Top-level key: old key becomes new key.
	| 'rename'
	// Scalar becomes a one-element array under the new key (an array passes
	// through unchanged).
	| 'wrap'
	// Dotted path: the rename is applied to the object found at that path. A
	// segment that holds an array is applied to every element, and array
	// indexes are dropped from the path (edges.source_id, not edges[0].source_id).
	| 'nested'

export interface AliasRow {
	tool: string
	oldPath: string
	newPath: string
	kind: AliasKind
}

export const ALIASES: readonly AliasRow[] = [
	// driver_id -> driver, on the tools that call it driver.
	{ tool: 'list_objects', oldPath: 'driver_id', newPath: 'driver', kind: 'rename' },
	{ tool: 'create_objects', oldPath: 'nodes.driver_id', newPath: 'nodes.driver', kind: 'nested' },
	{
		tool: 'update_objects',
		oldPath: 'updates.driver_id',
		newPath: 'updates.driver',
		kind: 'nested',
	},

	// source_id / target_id -> source / target, on the tool that calls them
	// source and target.
	{ tool: 'create_objects', oldPath: 'edges.source_id', newPath: 'edges.source', kind: 'nested' },
	{ tool: 'create_objects', oldPath: 'edges.target_id', newPath: 'edges.target', kind: 'nested' },

	// actor_id <-> target_actor_id, per tool: each tool keeps its own name and
	// accepts the other one.
	{ tool: 'create_trigger', oldPath: 'actor_id', newPath: 'target_actor_id', kind: 'rename' },
	{ tool: 'update_trigger', oldPath: 'actor_id', newPath: 'target_actor_id', kind: 'rename' },
	{ tool: 'create_session', oldPath: 'target_actor_id', newPath: 'actor_id', kind: 'rename' },
	{ tool: 'list_sessions', oldPath: 'target_actor_id', newPath: 'actor_id', kind: 'rename' },

	// The key names agents send most often to the four read tools behind most
	// schema-validation misfires. Each tool keeps its canonical name.
	{ tool: 'get_comments', oldPath: 'object_id', newPath: 'entity_id', kind: 'rename' },
	{ tool: 'search_objects', oldPath: 'query', newPath: 'q', kind: 'rename' },
	{ tool: 'get_session', oldPath: 'session_id', newPath: 'id', kind: 'rename' },
	{ tool: 'get_actor', oldPath: 'actor_id', newPath: 'id', kind: 'rename' },

	// id sent to a tool that wants a list of ids.
	{ tool: 'get_objects', oldPath: 'id', newPath: 'ids', kind: 'wrap' },

	// Skill tools take name. A caller holding an id from list_workspace_skills
	// sends id; this rescues the key spelling only. Resolving an id value to a
	// skill is the skill lookup task.
	{ tool: 'get_workspace_skill', oldPath: 'id', newPath: 'name', kind: 'rename' },
	{ tool: 'update_workspace_skill', oldPath: 'id', newPath: 'name', kind: 'rename' },
	{ tool: 'delete_workspace_skill', oldPath: 'id', newPath: 'name', kind: 'rename' },
]

// workspace_id is required today on these three tools (the ones built on
// requiredWorkspaceId in ./tools.ts). A call that leaves it out gets the
// connection's default workspace. This is a relaxation, not an alias: no old
// name is involved, so it is not in the table above and is never reported as
// a rename. The advertised schema is unchanged.
export const DEFAULT_WORKSPACE_TOOLS: ReadonlySet<string> = new Set([
	'create_objects',
	'list_objects',
	'create_loop',
])

const ROWS_BY_TOOL = new Map<string, AliasRow[]>()
for (const row of ALIASES) {
	const rows = ROWS_BY_TOOL.get(row.tool) ?? []
	rows.push(row)
	ROWS_BY_TOOL.set(row.tool, rows)
}

export function aliasRowsFor(tool: string): readonly AliasRow[] {
	return ROWS_BY_TOOL.get(tool) ?? []
}
