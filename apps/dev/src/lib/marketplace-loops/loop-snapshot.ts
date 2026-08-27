// Shared snapshot helpers for marketplace loop publishers. Strips credentials
// and runtime state (apiKey, memory, agentState, createdBy, timestamps, ids)
// from actor/trigger source records before they're written into a
// marketplace_loop_items.item_snapshot, keeping the exact same shape across
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

export interface SkillSnapshotSource {
	name: string | null
	description: string | null
	content: string | null
	isValid: boolean | null
}

// The placeholder an actor's MCP config uses to opt into a browser sidecar.
// session-manager.ts's needsBrowserSidecar() string-matches this in the
// serialised MCP config to decide whether to provision Chromium for a session.
const BROWSER_CDP_PLACEHOLDER = '${BROWSER_CDP_URL}'

// Canonical, secret-free browser MCP entry. Kept byte-identical to
// BROWSER_MCP_PRESET in apps/web/src/components/agents/mcp-servers.tsx (the
// "Add Browser" button) so an installed agent and a hand-configured one get
// exactly the same server. Every value here is a constant or a placeholder
// expanded inside the container — nothing publisher-specific survives.
export const BROWSER_MCP_SERVER = {
	type: 'stdio',
	command: 'npx',
	args: ['@playwright/mcp@latest', '--cdp-endpoint', BROWSER_CDP_PLACEHOLDER],
} as const

export const BROWSER_MCP_SERVER_NAME = 'playwright'

function referencesBrowserCdp(mcpServers: unknown): boolean {
	if (mcpServers === null || typeof mcpServers !== 'object') return false
	return JSON.stringify(mcpServers).includes(BROWSER_CDP_PLACEHOLDER)
}

// tools.mcpServers.*.env / headers routinely carry live secrets (API keys,
// bearer tokens) hardcoded by source-workspace admins instead of ${VAR}
// placeholders. marketplace_loop_items.item_snapshot is readable by any
// workspace that browses or installs the loop, so mcpServers is dropped
// entirely rather than trusted to be redacted — installers reconfigure their
// own MCP servers after install.
//
// One capability survives that drop, as a boolean rather than a config:
// `tools.browser`. Dropping mcpServers wholesale also dropped the browser
// entry, which carries no secret (it is the constant BROWSER_MCP_SERVER above)
// but IS what makes session-manager.ts provision a Chromium sidecar. Installed
// agents therefore silently lost browser access while their system prompts
// still told them they had it — see expandBrowserCapability for the other half.
function stripMcpServers(tools: unknown): unknown {
	if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
		return tools
	}
	const { mcpServers, ...rest } = tools as Record<string, unknown>
	return referencesBrowserCdp(mcpServers) ? { ...rest, browser: true } : rest
}

/**
 * Inverse of stripMcpServers' browser handling, applied on the install path:
 * turn the snapshot's `tools.browser === true` capability flag back into a
 * real MCP server entry, so the installed actor's sessions provision a browser
 * sidecar. Any other MCP servers on the actor are left untouched, and an
 * existing entry under the same name always wins — re-provisioning an install
 * must never clobber a server the installer configured themselves.
 */
export function expandBrowserCapability(tools: unknown): unknown {
	if (tools === null || typeof tools !== 'object' || Array.isArray(tools)) {
		return tools
	}
	const { browser, ...rest } = tools as Record<string, unknown>
	if (browser !== true) return tools
	const existing =
		rest.mcpServers && typeof rest.mcpServers === 'object' && !Array.isArray(rest.mcpServers)
			? (rest.mcpServers as Record<string, unknown>)
			: {}
	return {
		...rest,
		mcpServers: { [BROWSER_MCP_SERVER_NAME]: BROWSER_MCP_SERVER, ...existing },
	}
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

// storageKey/sizeBytes are deliberately NOT captured here. The install path
// mints a fresh UUID + workspace-scoped S3 key for every provisioned skill
// (see buildSkillInsert) instead of trusting the publisher's storageKey —
// carrying it through would point every installer's skill row at the
// publisher's own S3 object.
export function skillSnapshot(
	row: SkillSnapshotSource,
	attachedActorIds: string[],
): Record<string, unknown> {
	return {
		name: row.name,
		description: row.description,
		content: row.content,
		isValid: row.isValid,
		// Source actor ids (from the publisher workspace's agent_skills rows)
		// this skill is attached to, filtered to actors published in the same
		// loop. The install path's rewriteWiring() swaps them for local actor
		// ids using the source_item_id → local_id map, then inserts a fresh
		// agent_skills row per pair.
		attachedActorIds,
	}
}
