import type { Database } from '@maskin/db'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { isLinkedInIntegrationError } from './errors'
import {
	getLinkedInProfile,
	listLinkedInConnections,
	listLinkedInConversations,
	listLinkedInMessages,
	replyToLinkedInThread,
	searchLinkedInPeople,
	sendLinkedInMessage,
} from './operations'

/**
 * In-process MCP server for the LinkedIn (Unipile-backed) provider, served
 * over Streamable HTTP at `/api/integrations/linkedin-unipile/mcp`. Mirrors
 * `providers/slack/mcp-server.ts` — the established shape for an integration
 * whose tools run against our own backend rather than a hosted third-party
 * MCP endpoint.
 *
 * Every tool delegates to `operations.ts`, which owns the credential lookup,
 * retry policy, idempotency dedup and the six-class error taxonomy. Nothing
 * here re-implements any of that; this file is the MCP shell.
 *
 * Scoping note: unlike Slack, whose bot token is workspace-wide, LinkedIn
 * credentials are keyed by (workspace, actor, provider). The context therefore
 * carries the calling actor's id and the identity that sends is that actor's
 * own — an agent cannot send as a colleague's LinkedIn account by pointing at
 * a different workspace member.
 */
export interface LinkedInMcpContext {
	db: Database
	/** Calling actor — selects which connected LinkedIn identity sends. */
	actorId: string
	workspaceId: string
}

/**
 * Surface a terminal `LinkedInIntegrationError` as an MCP tool error carrying
 * the wire code, rather than throwing. The six classes drive agent behaviour
 * (retry, escalate to a human, pause the send loop for 24h), so the code has
 * to survive into the text the agent reads — `CREDENTIAL_NOT_CONNECTED` tells
 * it to ask for a reconnect, while `RATE_LIMITED_UNIPILE` tells it to wait.
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
				text: `UNIPILE_UNAVAILABLE: Unexpected upstream error in ${operation}`,
			},
		],
	}
}

function jsonResult(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }] }
}

export function createLinkedInMcpServer(ctx: LinkedInMcpContext): McpServer {
	const server = new McpServer({ name: 'maskin-linkedin', version: '0.1.0' })

	server.registerTool(
		'linkedin_send_message',
		{
			description:
				'Send a LinkedIn direct message to a recipient on behalf of the connected LinkedIn identity of the calling actor. Returns the LinkedIn-side message id and the timestamp the send was accepted by LinkedIn (not delivery confirmation to the recipient inbox). Errors arrive as "<CODE>: <message>" using the six-class taxonomy — CREDENTIAL_NOT_CONNECTED means the actor must reconnect LinkedIn at Settings > Integrations, LINKEDIN_ACCOUNT_RESTRICTED means stop sending and tell a human.',
			inputSchema: {
				recipient_urn: z
					.string()
					.min(1)
					.describe(
						'Provider id of the recipient member, as returned in the `recipient_urn` field of linkedin_list_conversations — an opaque LinkedIn member id like "ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx". Pass it through verbatim. It is NOT a "urn:li:person:..." URN: do not construct one, do not reformat this value, and do not pass a Unipile account_id.',
					),
				body: z
					.string()
					.min(1)
					.max(8000)
					.describe(
						'Plain-text message body. Max 8000 chars (LinkedIn hard limit). No HTML; newlines allowed.',
					),
				idempotency_key: z
					.string()
					.min(1)
					.max(128)
					.describe(
						'Client-generated key that deduplicates retries. If the server has seen this key from the same actor within the TTL window, the prior response is replayed and no second LinkedIn send occurs. Recommended format: "{contact_id}:{draft_id}" or a stable hash of (recipient_urn, body).',
					),
			},
		},
		async (args) => {
			try {
				return jsonResult(await sendLinkedInMessage(ctx, args))
			} catch (err) {
				return toolError('linkedin_send_message', err)
			}
		},
	)

	server.registerTool(
		'linkedin_reply',
		{
			description:
				'Reply in an existing LinkedIn conversation thread on behalf of the connected LinkedIn identity of the calling actor. Use thread_id from linkedin_list_conversations.',
			inputSchema: {
				thread_id: z.string().min(1).describe('Conversation id from linkedin_list_conversations.'),
				body: z
					.string()
					.min(1)
					.max(8000)
					.describe('Plain-text reply body. Max 8000 chars (LinkedIn hard limit).'),
				idempotency_key: z
					.string()
					.min(1)
					.max(128)
					.describe(
						'Client-generated key that deduplicates retries — same semantics as linkedin_send_message.',
					),
			},
		},
		async (args) => {
			try {
				return jsonResult(await replyToLinkedInThread(ctx, args))
			} catch (err) {
				return toolError('linkedin_reply', err)
			}
		},
	)

	server.registerTool(
		'linkedin_list_conversations',
		{
			description:
				"List the connected actor's LinkedIn conversations, newest first. Paginated via an opaque cursor. Use this to discover recipient_urns and thread_ids for follow-on send/reply calls. Read-only.",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe('Max conversations to return, 1..50. Defaults to the provider default.'),
				cursor: z
					.string()
					.optional()
					.describe('Opaque pagination cursor returned as next_cursor by a prior call.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await listLinkedInConversations(ctx, args))
			} catch (err) {
				return toolError('linkedin_list_conversations', err)
			}
		},
	)

	// ── Read tools ────────────────────────────────────────────────────────
	// All four are read-only: they add no way to contact anyone that
	// send/reply did not already provide.

	server.registerTool(
		'linkedin_list_messages',
		{
			description:
				'Read the messages in one LinkedIn conversation, newest first. linkedin_list_conversations returns only a one-line preview per thread — use this to read what was actually said before replying. Each message carries from_me, so you can tell which side sent it. Read-only.',
			inputSchema: {
				thread_id: z.string().min(1).describe('Conversation id from linkedin_list_conversations.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe('Max messages to return, 1..100. Defaults to the provider default.'),
				cursor: z
					.string()
					.optional()
					.describe('Opaque pagination cursor returned as next_cursor by a prior call.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await listLinkedInMessages(ctx, args))
			} catch (err) {
				return toolError('linkedin_list_messages', err)
			}
		},
	)

	server.registerTool(
		'linkedin_list_connections',
		{
			description:
				"List the connected LinkedIn account's own connections (first-degree). Returns each person's recipient_urn — pass that to linkedin_send_message to DM them. These are people the account is already connected to, so they can be messaged directly. Use linkedin_search_people to find people outside the network. Read-only.",
			inputSchema: {
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe('Max connections to return, 1..100. Defaults to the provider default.'),
				cursor: z
					.string()
					.optional()
					.describe('Opaque pagination cursor returned as next_cursor by a prior call.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await listLinkedInConnections(ctx, args))
			} catch (err) {
				return toolError('linkedin_list_connections', err)
			}
		},
	)

	server.registerTool(
		'linkedin_search_people',
		{
			description:
				"Search LinkedIn for people by keywords — the same results the connected member would see in LinkedIn's own people search. Most hits are 2nd/3rd degree: check network_distance before assuming you can message someone, because a non-connection usually cannot receive a DM without an invitation first. Read-only; this does not connect with or contact anyone.",
			inputSchema: {
				keywords: z
					.string()
					.min(1)
					.optional()
					.describe(
						'Free-text search, e.g. "product manager fintech Oslo". Either this or search_url is required.',
					),
				search_url: z
					.string()
					.optional()
					.describe(
						'A https://www.linkedin.com/ search URL copied from the browser, for a search already refined with LinkedIn’s own filters. Overrides keywords when both are given.',
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(50)
					.optional()
					.describe('Max results to return, 1..50. Defaults to the provider default.'),
				cursor: z
					.string()
					.optional()
					.describe('Opaque pagination cursor returned as next_cursor by a prior call.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await searchLinkedInPeople(ctx, args))
			} catch (err) {
				return toolError('linkedin_search_people', err)
			}
		},
	)

	server.registerTool(
		'linkedin_get_profile',
		{
			description:
				'Fetch one LinkedIn profile by public handle (the "janedoe" in linkedin.com/in/janedoe) or by the recipient_urn returned from another LinkedIn tool. Pass "me" to get the connected account’s own profile — use that to answer whose LinkedIn identity you are posting as. Read-only.',
			inputSchema: {
				identifier: z
					.string()
					.min(1)
					.describe(
						'Public handle, recipient_urn, or the literal "me" for the connected account’s own profile.',
					),
			},
		},
		async (args) => {
			try {
				return jsonResult(await getLinkedInProfile(ctx, args))
			} catch (err) {
				return toolError('linkedin_get_profile', err)
			}
		},
	)

	return server
}
