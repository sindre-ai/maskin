import type { Database } from '@maskin/db'
import type { LinkedInMcpInstanceConfig, LinkedInPhase1Verb } from '@maskin/mcp/linkedin'
import { toolName, toolsForIdentity } from '@maskin/mcp/linkedin'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { isLinkedInIntegrationError } from './errors'
import {
	commentOnLinkedInPost,
	getLinkedInPostEngagement,
	getLinkedInProfile,
	listLinkedInConnections,
	listLinkedInConversations,
	listLinkedInMessages,
	publishLinkedInPost,
	readLinkedInPostComments,
	replyToLinkedInComment,
	replyToLinkedInThread,
	searchLinkedInPeople,
	sendLinkedInConnectionRequest,
	sendLinkedInMessage,
} from './operations'

/**
 * In-process MCP server for the LinkedIn (LinkedIn-backed) provider, served
 * over Streamable HTTP at `/api/integrations/linkedin-unipile/mcp`.
 *
 * R11-A rebuilds this file around the fan-out identity model — see
 * linkedin-mcp-phase2-technical-spec.md §1 and §2. The old flat
 * `linkedin_*` global namespace (a single set of 13 tools per connected
 * credential, with the connected personal profile as the only ever author)
 * is gone. Each connected LinkedIn identity — the human profile plus every
 * admined company page — is its own MCP instance registered under
 * `linkedin-{unipileAccSlug}-{identitySlug}`, and every tool on that
 * instance is pre-scoped to that identity's URN. There is no `post_as` /
 * `comment_as` / `send_as` input on any tool — cross-identity confusion is
 * eliminated by construction.
 *
 * `registerLinkedInMcpInstance(server, cfg, deps)` is the one entry-point
 * this file exposes for that. The `/mcp` route handler iterates the
 * connected credentials for the calling workspace, reads their instances
 * from `packages/mcp/src/lib/registry.ts` (populated by the connect-callback
 * path and the admin refresh-identities endpoint), and calls this function
 * once per instance to attach its fan-out tools. Nothing else registers
 * tools here.
 */
export interface LinkedInMcpContext {
	db: Database
	/** Calling actor — used as the ledger key by the operations layer. */
	actorId: string
	workspaceId: string
}

/**
 * Surface a terminal `LinkedInIntegrationError` as an MCP tool error carrying
 * the wire code, rather than throwing. The six classes drive agent behaviour
 * (retry, escalate to a human, pause the send loop for 24h), so the code has
 * to survive into the text the agent reads — `CREDENTIAL_NOT_CONNECTED` tells
 * it to ask for a reconnect, while `RATE_LIMITED_LINKEDIN` tells it to wait.
 * A bare thrown exception would collapse all six into one opaque failure.
 */
function toolError(operation: string, err: unknown) {
	if (isLinkedInIntegrationError(err)) {
		logger.warn('LinkedIn MCP tool returned a terminal error', {
			operation,
			code: err.code,
			retryable: err.retryable,
		})
		return {
			isError: true as const,
			content: [{ type: 'text' as const, text: `${err.code}: ${err.message}` }],
		}
	}
	logger.error('LinkedIn MCP tool unexpected error', {
		operation,
		error: err instanceof Error ? err.message : String(err),
	})
	return {
		isError: true as const,
		content: [
			{
				type: 'text' as const,
				text: `LINKEDIN_UNAVAILABLE: Unexpected upstream error in ${operation}`,
			},
		],
	}
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

/**
 * Per-identity description templating. `displayName` and `identitySlug` land
 * into every description at register-time so `tools/list` names the identity
 * the tool is scoped to — no cross-identity confusion at read-time either.
 * The wording is the "AS {displayName} ({identitySlug})" pattern from spec
 * §3.1 and §10 R12, and the regex-matched shape the fan-out-shape test pins.
 */
function scopedDescription(base: string, cfg: LinkedInMcpInstanceConfig): string {
	return `${base} AS ${cfg.displayName} (${cfg.identitySlug}). This tool always acts as this identity — there is no post_as / comment_as / send_as selector.`
}

/**
 * Register the Phase 1 verbs allowed on `cfg`'s identity (per spec §2's
 * filter table via `toolsForIdentity(cfg)`) as fan-out tools on `server`.
 * Every tool's handler pulls `cfg.identityUrn` from this closure and passes
 * it down to the operations layer via `LinkedInOperationContext.identity`
 * — never from a per-call arg.
 *
 * Idempotent per (server, cfg): calling twice with the same cfg would try
 * to re-register the same tool name on the same server and the MCP SDK
 * would throw. The registry above guarantees single-registration per
 * `(integrationId, identitySlug)`, and the /mcp route builds a fresh
 * server per request, so this idempotency is implicit at the caller layer.
 */
export function registerLinkedInMcpInstance(
	server: McpServer,
	cfg: LinkedInMcpInstanceConfig,
	ctx: LinkedInMcpContext,
): void {
	const allowed = new Set<LinkedInPhase1Verb>(toolsForIdentity(cfg))
	const opCtx = { db: ctx.db, actorId: ctx.actorId, workspaceId: ctx.workspaceId, identity: cfg }

	if (allowed.has('publish_post')) {
		server.registerTool(
			toolName(cfg, 'publish_post'),
			{
				description: scopedDescription(
					'Publish a LinkedIn post',
					cfg,
				),
				inputSchema: {
					text: z
						.string()
						.min(1)
						.max(3000)
						.describe('Post body. Max 3000 chars — LinkedIn hard limit.'),
					can_read: z
						.string()
						.optional()
						.describe('Post visibility, e.g. "connections", "public".'),
					can_comment: z
						.string()
						.optional()
						.describe('Who can comment, e.g. "connections", "anyone", "none".'),
					quoted_post_id: z.string().optional().describe('Post id to quote-share.'),
				},
			},
			async (args) => {
				try {
					return jsonResult(await publishLinkedInPost(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'publish_post'), err)
				}
			},
		)
	}

	if (allowed.has('read_post_comments')) {
		server.registerTool(
			toolName(cfg, 'read_post_comments'),
			{
				description: scopedDescription('Read comments on a LinkedIn post', cfg),
				inputSchema: {
					post_id: z.string().min(1).describe('Post id.'),
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(await readLinkedInPostComments(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'read_post_comments'), err)
				}
			},
		)
	}

	if (allowed.has('comment_on_post')) {
		server.registerTool(
			toolName(cfg, 'comment_on_post'),
			{
				description: scopedDescription('Post a top-level comment on a LinkedIn post', cfg),
				inputSchema: {
					post_id: z.string().min(1),
					text: z.string().min(1).max(3000),
				},
			},
			async (args) => {
				try {
					return jsonResult(await commentOnLinkedInPost(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'comment_on_post'), err)
				}
			},
		)
	}

	if (allowed.has('reply_to_comment')) {
		server.registerTool(
			toolName(cfg, 'reply_to_comment'),
			{
				description: scopedDescription('Reply to an existing LinkedIn comment', cfg),
				inputSchema: {
					comment_id: z.string().min(1),
					text: z.string().min(1).max(3000),
				},
			},
			async (args) => {
				try {
					return jsonResult(await replyToLinkedInComment(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'reply_to_comment'), err)
				}
			},
		)
	}

	if (allowed.has('get_post_engagement')) {
		server.registerTool(
			toolName(cfg, 'get_post_engagement'),
			{
				description: scopedDescription(
					'Fetch engagement metrics (reactions + comments) for a LinkedIn post',
					cfg,
				),
				inputSchema: { post_id: z.string().min(1) },
			},
			async (args) => {
				try {
					return jsonResult(await getLinkedInPostEngagement(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'get_post_engagement'), err)
				}
			},
		)
	}

	if (allowed.has('send_message')) {
		server.registerTool(
			toolName(cfg, 'send_message'),
			{
				description: scopedDescription('Send a LinkedIn direct message', cfg),
				inputSchema: {
					recipient_urn: z.string().min(1),
					body: z.string().min(1).max(8000),
					idempotency_key: z.string().min(1).max(128),
				},
			},
			async (args) => {
				try {
					return jsonResult(await sendLinkedInMessage(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'send_message'), err)
				}
			},
		)
	}

	if (allowed.has('reply')) {
		server.registerTool(
			toolName(cfg, 'reply'),
			{
				description: scopedDescription('Reply in an existing LinkedIn conversation thread', cfg),
				inputSchema: {
					thread_id: z.string().min(1),
					body: z.string().min(1).max(8000),
					idempotency_key: z.string().min(1).max(128),
				},
			},
			async (args) => {
				try {
					return jsonResult(await replyToLinkedInThread(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'reply'), err)
				}
			},
		)
	}

	if (allowed.has('list_conversations')) {
		server.registerTool(
			toolName(cfg, 'list_conversations'),
			{
				description: scopedDescription("List LinkedIn conversations", cfg),
				inputSchema: {
					limit: z.number().int().min(1).max(50).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(await listLinkedInConversations(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'list_conversations'), err)
				}
			},
		)
	}

	if (allowed.has('list_messages')) {
		server.registerTool(
			toolName(cfg, 'list_messages'),
			{
				description: scopedDescription('Read messages in one LinkedIn conversation', cfg),
				inputSchema: {
					thread_id: z.string().min(1),
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(await listLinkedInMessages(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'list_messages'), err)
				}
			},
		)
	}

	if (allowed.has('list_connections')) {
		server.registerTool(
			toolName(cfg, 'list_connections'),
			{
				description: scopedDescription("List the LinkedIn account's first-degree connections", cfg),
				inputSchema: {
					limit: z.number().int().min(1).max(100).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(await listLinkedInConnections(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'list_connections'), err)
				}
			},
		)
	}

	if (allowed.has('search_people')) {
		server.registerTool(
			toolName(cfg, 'search_people'),
			{
				description: scopedDescription('Search LinkedIn for people by keywords', cfg),
				inputSchema: {
					keywords: z.string().min(1).optional(),
					search_url: z.string().optional(),
					limit: z.number().int().min(1).max(50).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(await searchLinkedInPeople(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'search_people'), err)
				}
			},
		)
	}

	if (allowed.has('send_connection_request')) {
		server.registerTool(
			toolName(cfg, 'send_connection_request'),
			{
				description: scopedDescription('Send a LinkedIn connection invitation', cfg),
				inputSchema: {
					user_id: z.string().min(1),
					message: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(await sendLinkedInConnectionRequest(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'send_connection_request'), err)
				}
			},
		)
	}

	if (allowed.has('get_profile')) {
		server.registerTool(
			toolName(cfg, 'get_profile'),
			{
				description: scopedDescription('Fetch one LinkedIn profile by public handle or provider id', cfg),
				inputSchema: { identifier: z.string().min(1) },
			},
			async (args) => {
				try {
					return jsonResult(await getLinkedInProfile(opCtx, args))
				} catch (err) {
					return toolError(toolName(cfg, 'get_profile'), err)
				}
			},
		)
	}
}

/**
 * Build a per-request LinkedIn MCP server whose tools are the fan-out
 * instances registered for `ctx`'s workspace. Empty-tool server if the
 * caller's workspace has no linkedin-unipile credential or no identities
 * enumerated yet — an agent hitting `tools/list` on an unconnected workspace
 * sees an empty list rather than a 4xx, matching the `github-*` MCP surface's
 * behaviour and letting `get_started`-driven onboarding proceed.
 */
export function createLinkedInMcpServer(
	ctx: LinkedInMcpContext,
	instances: LinkedInMcpInstanceConfig[],
): McpServer {
	const server = new McpServer({ name: 'maskin-linkedin', version: '0.2.0' })
	for (const cfg of instances) {
		registerLinkedInMcpInstance(server, cfg, ctx)
	}
	return server
}
