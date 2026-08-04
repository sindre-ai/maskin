// Shared snapshot helpers for catalog package publishers. Strips credentials
// and runtime state (apiKey, memory, agentState, createdBy, timestamps, ids)
// from actor/trigger source records before they're written into a
// catalog_package_items.item_snapshot, keeping the exact same shape across
// every publish-*.ts script and their tests.
//
// The input types are intentionally structural (a subset of the columns), so
// both a live Drizzle `actors`/`triggers` row and a plain record loaded from
// the checked-in `data/dev-actors.json` / `data/dev-triggers.json` snapshots
// satisfy them.

export interface ActorSnapshotSource {
	type: string | null
	name: string | null
	description: string | null
	systemPrompt: string | null
	llmProvider: string | null
	llmConfig: unknown
	tools: unknown
}

export interface TriggerSnapshotSource {
	name: string | null
	type: string | null
	config: unknown
	actionPrompt: string | null
	targetActorId: string
	enabled: boolean | null
}

// tools.mcpServers.*.env / headers routinely carry live secrets (API keys,
// bearer tokens) hardcoded by source-workspace admins instead of ${VAR}
// placeholders. catalog_package_items.item_snapshot is readable by any
// workspace that browses or installs the package, so mcpServers is dropped
// entirely rather than trusted to be redacted — installers reconfigure their
// own MCP servers after install.
function stripMcpServers(tools: unknown): unknown {
	if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
		return tools
	}
	const { mcpServers, ...rest } = tools as Record<string, unknown>
	return rest
}

export function actorSnapshot(row: ActorSnapshotSource): Record<string, unknown> {
	// apiKey, memory, agentState, isSystem, createdBy, timestamps are
	// install-time / runtime state — they never belong in a publish.
	return {
		type: row.type,
		name: row.name,
		description: row.description,
		systemPrompt: row.systemPrompt,
		llmProvider: row.llmProvider,
		llmConfig: row.llmConfig,
		tools: stripMcpServers(row.tools),
	}
}

export function triggerSnapshot(row: TriggerSnapshotSource): Record<string, unknown> {
	return {
		name: row.name,
		type: row.type,
		config: row.config,
		actionPrompt: row.actionPrompt,
		// Carry the source actor id as-is. The install path's rewriteWiring()
		// swaps it for the installed actor's local id using the source_item_id → local_id map.
		targetActorId: row.targetActorId,
		enabled: row.enabled,
	}
}
