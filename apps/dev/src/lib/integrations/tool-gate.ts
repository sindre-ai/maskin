import type { Database } from '@maskin/db'
import { AGENT_ACCESS_EFFECT, AGENT_ACCESS_LABELS } from '@maskin/shared'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { recordEvent } from '../events/record-event'
import { logger } from '../logger'
import { type AgentAccess, canRead, canWrite, resolveAgentAccess } from './agent-access'
import { type ToolKind, classifyTool } from './tool-kinds'

/**
 * Enforces agent access on an integration's tools.
 *
 * The same decision is made in two places so an agent hears about it twice: the tool's
 * description says it is unavailable (so a model that reads tools/list does not reach
 * for it), and a call that goes through anyway is refused with a message that says why
 * and what to do. Without the second, a refused agent sees a bare error and concludes
 * the integration is broken.
 */
export interface ToolGateConfig {
	db: Database
	workspaceId: string
	actorId: string
	integrationId: string
	provider: string
	/** Name a person recognises: "Slack", "LinkedIn". */
	providerLabel: string
	access: AgentAccess
}

/** The level as the UI names it ("Read", "Read & write"), so a refusal matches what the person sees. */
const levelName = (access: AgentAccess) => AGENT_ACCESS_LABELS[access]

export function allows(access: AgentAccess, kind: ToolKind): boolean {
	return kind === 'read' ? canRead(access) : canWrite(access)
}

/** What the agent is told when a call is refused. Plain words, no ids, says what to do next. */
export function accessDeniedMessage(input: {
	providerLabel: string
	toolName: string
	kind: ToolKind
	access: AgentAccess
}): string {
	const { providerLabel, toolName, kind, access } = input
	const need = kind === 'read' ? 'read' : 'write'
	const have =
		access === 'none'
			? `You have no access to ${providerLabel}.`
			: `Your access to ${providerLabel} is "${levelName(access)}" (${AGENT_ACCESS_EFFECT[access]}).`
	return [
		`Access denied: ${toolName} needs ${need} access to ${providerLabel}. ${have}`,
		'This is a permission set by a person, not an outage, so do not retry and do not look for a workaround.',
		`Tell the person that this agent needs ${need} access to ${providerLabel}; a workspace admin can grant it under Settings → Integrations.`,
	].join(' ')
}

/** The note added to a tool's description when this agent cannot use it. */
export function unavailableNote(
	providerLabel: string,
	kind: ToolKind,
	access: AgentAccess,
): string {
	const need = kind === 'read' ? 'read' : 'write'
	return access === 'none'
		? `[Unavailable: you have no access to ${providerLabel}.]`
		: `[Unavailable: needs ${need} access to ${providerLabel}; your access is "${levelName(access)}".]`
}

async function recordDenial(cfg: ToolGateConfig, toolName: string, kind: ToolKind): Promise<void> {
	try {
		await recordEvent(cfg.db, {
			workspaceId: cfg.workspaceId,
			actorId: cfg.actorId,
			action: 'agent_access_denied',
			entityType: 'integration',
			entityId: cfg.integrationId,
			data: { provider: cfg.provider, tool: toolName, kind, access: cfg.access },
		})
	} catch (err) {
		// The refusal matters more than its log line.
		logger.warn('Could not record a denied integration tool call', {
			workspaceId: cfg.workspaceId,
			integrationId: cfg.integrationId,
			error: err instanceof Error ? err.name : 'unknown',
		})
	}
}

/**
 * Wraps `server.registerTool` so every tool registered afterwards is gated. Call it
 * immediately after `new McpServer(...)` and before any tool is registered.
 */
export function gateMcpServer(server: McpServer, cfg: ToolGateConfig): void {
	const register = server.registerTool.bind(server) as (
		name: string,
		config: Record<string, unknown>,
		cb: (...args: unknown[]) => unknown,
	) => unknown

	const gated = (
		name: string,
		config: Record<string, unknown>,
		cb: (...args: unknown[]) => unknown,
	) => {
		const annotations = (config.annotations ?? undefined) as
			| { readOnlyHint?: boolean; destructiveHint?: boolean }
			| undefined
		const kind = classifyTool(cfg.provider, name, annotations)
		const ok = allows(cfg.access, kind)
		const description = typeof config.description === 'string' ? config.description : ''
		const nextConfig = {
			...config,
			// Clients use this to separate reads from actions; ours is the authority.
			annotations: { ...annotations, readOnlyHint: kind === 'read' },
			description: ok
				? description
				: `${unavailableNote(cfg.providerLabel, kind, cfg.access)} ${description}`.trim(),
		}
		if (ok) return register(name, nextConfig, cb)
		return register(name, nextConfig, async () => {
			await recordDenial(cfg, name, kind)
			return {
				isError: true,
				content: [
					{
						type: 'text' as const,
						text: accessDeniedMessage({
							providerLabel: cfg.providerLabel,
							toolName: name,
							kind,
							access: cfg.access,
						}),
					},
				],
			}
		})
	}
	server.registerTool = gated as unknown as McpServer['registerTool']
}

/**
 * Resolves the caller's access once per request and returns the function a server
 * factory calls right after `new McpServer(...)`. With no integration row there is
 * nothing to gate: the tools already fail with their own "not connected" error.
 */
export async function toolGateFor(
	db: Database,
	input: {
		workspaceId: string
		actorId: string
		integrationId: string | null
		provider: string
		providerLabel: string
	},
): Promise<(server: McpServer) => void> {
	if (!input.integrationId) return () => {}
	const integrationId = input.integrationId
	// An integration this workspace does not have resolves to null: treat as no access.
	const access =
		(await resolveAgentAccess(db, input.workspaceId, integrationId, input.actorId)) ?? 'none'
	return (server) =>
		gateMcpServer(server, {
			db,
			workspaceId: input.workspaceId,
			actorId: input.actorId,
			integrationId,
			provider: input.provider,
			providerLabel: input.providerLabel,
			access,
		})
}
