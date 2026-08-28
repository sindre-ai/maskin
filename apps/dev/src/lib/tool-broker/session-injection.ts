import { type Database, toolBrokerActors, workspaceToolBrokers } from '@maskin/db'
import { and, eq } from 'drizzle-orm'
import { logger } from '../logger'
import { ensureActorIdentity, getToolBrokerClient } from './provisioning'
import { mintToolBrokerSessionToken } from './session-token'

// ---------------------------------------------------------------------------
// What a session launch needs from the tool broker, and nothing more.
//
// Free of broker I/O on the steady-state path: this runs on the session-launch
// hot path, so the usual case is two indexed reads and nothing else. Integration
// names are cached on the provisioning row precisely to keep it that way.
//
// The one exception is an agent's FIRST launch after the workspace is
// provisioned, which mints that agent's broker identity — once per agent, ever.
// That call is wrapped: a failure skips injection instead of failing the launch,
// so an integrations outage still cannot stop an agent from starting.
//
// The MCP entry and the preamble are returned together, from one gate, so the
// instruction and the capability cannot drift apart — an agent is never told
// about tools it does not have, and never given tools it was not told about.
// ---------------------------------------------------------------------------

export interface ToolBrokerSessionInjection {
	/** MCP server entry, keyed `tool-broker` by the caller. */
	readonly mcpServer: { type: 'http'; url: string; headers: Record<string, string> }
	/** Scoped, short-lived token for the container. */
	readonly sessionToken: string
	/** Prepended to SYSTEM_PROMPT. Empty string when there is nothing to say. */
	readonly preamble: string
}

/**
 * Teach the agent that the broker exists and how to use it.
 *
 * WHY THIS IS NECESSARY. Measured during the go/no-go: given a task solvable
 * another way, an agent never touches the broker. The three tools it exposes are
 * called `execute`, `skills` and `resume`, which advertise nothing about what is
 * behind them, and they sit among a couple of hundred deferred tools. Told that
 * the server exists and what it reaches, the same agent navigates it reliably
 * and unassisted — it reads the docs, searches, describes, then calls.
 *
 * So this names the integrations. Without the names the pointer is too weak to
 * beat a tool the agent already knows, like web access.
 */
export const buildToolBrokerPreamble = (integrationNames: readonly string[]): string => {
	const names =
		integrationNames.length > 0
			? integrationNames.join(', ')
			: 'external integrations added to this workspace'

	return [
		'## External integrations',
		'',
		`This workspace can reach ${names} through the \`tool-broker\` MCP server.`,
		'These are not listed as individual tools — a small fixed set of tools sits in',
		'front of the whole catalogue, so the integrations are only visible once you look.',
		'',
		'To use one, first call `skills({ name: "execute" })` for the exact workflow, then',
		'inside `execute`: `tools.search({ query })` to find a tool, `tools.describe.tool({ path })`',
		'to read its schema, and `tools.<path>(args)` to call it. Results come back as',
		'`{ ok: true, data }` or `{ ok: false, error }` — check `ok` before using `data`.',
		'',
		`Prefer these over generic web access when a task involves ${names}.`,
		'',
		'',
	].join('\n')
}

/**
 * Resolve everything the launcher needs, or null when the feature is off.
 *
 * Returns null — meaning "change nothing" — when the broker is unconfigured, the
 * workspace has no toolkit, or the actor has no identity. The caller adds no MCP
 * key and no preamble in that case, so the session config is byte-identical to
 * what it would have been before this feature existed.
 */
export const resolveToolBrokerInjection = async (
	db: Database,
	input: {
		sessionId: string
		workspaceId: string
		actorId: string
		/** Maskin's own base URL as reachable from inside a container. */
		internalApiUrl: string
	},
): Promise<ToolBrokerSessionInjection | null> => {
	if (!process.env.TOOL_BROKER_URL || !process.env.TOOL_BROKER_SESSION_SECRET) return null

	const [row] = await db
		.select()
		.from(workspaceToolBrokers)
		.where(
			and(
				eq(workspaceToolBrokers.workspaceId, input.workspaceId),
				eq(workspaceToolBrokers.status, 'active'),
			),
		)
		.limit(1)
	if (!row) return null

	// The session runs as the AGENT, but the settings page provisions the HUMAN
	// who clicked it — so an agent reaching the proxy for the first time has a
	// toolkit and no identity of its own, and every call fails. Mint one here.
	//
	// The fast path stays free of broker I/O: this only calls out when the row is
	// genuinely absent, which is once per agent, ever. A failure skips injection
	// rather than failing the launch — an integrations problem must never stop an
	// agent from starting.
	const [identity] = await db
		.select({ actorId: toolBrokerActors.actorId })
		.from(toolBrokerActors)
		.where(eq(toolBrokerActors.actorId, input.actorId))
		.limit(1)
	if (!identity) {
		const client = getToolBrokerClient()
		if (!client) return null
		try {
			await ensureActorIdentity(db, client, input.actorId)
		} catch (error) {
			logger.warn('Could not provision a tool broker identity for this agent; skipping injection', {
				actorId: input.actorId,
				error: error instanceof Error ? error.message : String(error),
			})
			return null
		}
	}

	const sessionToken = mintToolBrokerSessionToken({
		sessionId: input.sessionId,
		workspaceId: input.workspaceId,
		actorId: input.actorId,
	})

	const names = Array.isArray(row.connectedNames)
		? (row.connectedNames as unknown[]).filter((n): n is string => typeof n === 'string')
		: []

	return {
		mcpServer: {
			type: 'http',
			url: `${input.internalApiUrl.replace(/\/+$/, '')}/api/tool-broker/mcp`,
			// The literal placeholder is expanded by envsubst inside the container,
			// same as every other injected MCP credential — the token itself reaches
			// the container as a reserved env var, not baked into this JSON.
			headers: { Authorization: 'Bearer ${TOOL_BROKER_SESSION_TOKEN}' },
		},
		sessionToken,
		preamble: buildToolBrokerPreamble(names),
	}
}
