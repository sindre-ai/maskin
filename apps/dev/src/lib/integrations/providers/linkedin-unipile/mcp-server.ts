import type { Database } from '@maskin/db'
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
	publishLinkedInBusinessPagePost,
	publishLinkedInPost,
	readLinkedInPostComments,
	replyToLinkedInComment,
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

	// ── Content / community tools (Task 7b) ────────────────────────────────
	// Six tools covering personal + business-page publishing, commenting +
	// replying-to-comment, reading comments, and engagement (reactions +
	// comments — impressions unavailable on Unipile v2). The four destructive
	// tools (publish x2, comment, reply-to-comment) dedup on a content hash
	// via the `linkedin_tool_calls` ledger.

	server.registerTool(
		'linkedin_publish_post',
		{
			description:
				'Publish a LinkedIn post from the connected personal profile on behalf of the calling actor. Returns the published post_id and the timestamp LinkedIn accepted it. `replayed: true` in the response means an identical call within the 24h TTL was already sent — the response is the stored one, no new post was published. Errors arrive as "<CODE>: <message>" using the six-class taxonomy plus LINKEDIN_POST_TOO_LONG (post body > 3000 chars — NEVER retry, shorten the text first).',
			inputSchema: {
				text: z
					.string()
					.min(1)
					.max(3000)
					.describe(
						'Post body. Max 3000 chars — LinkedIn hard limit. Plain text; newlines allowed; @mentions and hashtags render as-is on LinkedIn.',
					),
				attachments: z
					.array(z.unknown())
					.optional()
					.describe(
						'Optional attachments (images/documents/videos). Pass Unipile-compatible attachment descriptors; leave undefined for text-only posts.',
					),
				can_read: z
					.string()
					.optional()
					.describe(
						'Post visibility, e.g. "connections", "public". Defaults to LinkedIn account settings when omitted.',
					),
				can_comment: z
					.string()
					.optional()
					.describe(
						'Who can comment, e.g. "connections", "anyone", "none". Defaults to LinkedIn account settings when omitted.',
					),
				quoted_post_id: z
					.string()
					.optional()
					.describe('Post id to quote-share (repost with commentary).'),
				specifics: z
					.record(z.unknown())
					.optional()
					.describe(
						'Provider-specific opaque payload passed through to Unipile — reserved for advanced options that do not warrant a named field.',
					),
			},
		},
		async (args) => {
			try {
				return jsonResult(await publishLinkedInPost(ctx, args))
			} catch (err) {
				return toolError('linkedin_publish_post', err)
			}
		},
	)

	server.registerTool(
		'linkedin_publish_business_page_post',
		{
			description:
				'Publish a LinkedIn post as a business page the connected account admins. The `post_as` URN selects the page (e.g. `urn:li:organization:12345`); the same personal LinkedIn account is used — no separate credential. Same dedup + error semantics as linkedin_publish_post. `page_id` is a per-call arg, not a Stripe SKU.',
			inputSchema: {
				text: z
					.string()
					.min(1)
					.max(3000)
					.describe('Post body. Max 3000 chars — LinkedIn hard limit.'),
				post_as: z
					.string()
					.min(1)
					.describe(
						'LinkedIn company page URN, e.g. `urn:li:organization:12345`. The connected LinkedIn account must be an admin of the page — Unipile relays the publish under the page identity via `post_as`.',
					),
				attachments: z
					.array(z.unknown())
					.optional()
					.describe('Optional Unipile-compatible attachment descriptors.'),
				can_read: z
					.string()
					.optional()
					.describe('Post visibility, e.g. "public". Defaults to page settings when omitted.'),
				can_comment: z
					.string()
					.optional()
					.describe('Who can comment, e.g. "anyone", "none". Defaults to page settings.'),
				quoted_post_id: z
					.string()
					.optional()
					.describe('Post id to quote-share (repost with commentary).'),
				specifics: z
					.record(z.unknown())
					.optional()
					.describe('Provider-specific opaque payload passed through to Unipile.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await publishLinkedInBusinessPagePost(ctx, args))
			} catch (err) {
				return toolError('linkedin_publish_business_page_post', err)
			}
		},
	)

	server.registerTool(
		'linkedin_comment_on_post',
		{
			description:
				'Post a top-level comment on a LinkedIn post as the connected personal profile. Returns the new comment_id — use it with linkedin_reply_to_comment to thread further. Dedup semantics identical to linkedin_publish_post: an identical call within 24h replays the stored response without hitting Unipile again.',
			inputSchema: {
				post_id: z
					.string()
					.min(1)
					.describe(
						'Post id from linkedin_read_post_comments, linkedin_get_post_engagement, or the LinkedIn share URL slug.',
					),
				text: z.string().min(1).max(3000).describe('Comment body. Max 3000 chars.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await commentOnLinkedInPost(ctx, args))
			} catch (err) {
				return toolError('linkedin_comment_on_post', err)
			}
		},
	)

	server.registerTool(
		'linkedin_reply_to_comment',
		{
			description:
				"Reply to an existing LinkedIn comment as the connected personal profile — a threaded reply, not a top-level comment. Use comment_id from linkedin_read_post_comments. Dedup'd on content hash within a 24h window.",
			inputSchema: {
				comment_id: z.string().min(1).describe('Comment id from linkedin_read_post_comments.'),
				text: z.string().min(1).max(3000).describe('Reply body. Max 3000 chars.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await replyToLinkedInComment(ctx, args))
			} catch (err) {
				return toolError('linkedin_reply_to_comment', err)
			}
		},
	)

	server.registerTool(
		'linkedin_read_post_comments',
		{
			description:
				"Read comments on a LinkedIn post, newest first, paged via an opaque cursor. Read-only. Use before linkedin_reply_to_comment to pick the comment_id you're replying to.",
			inputSchema: {
				post_id: z.string().min(1).describe('Post id.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe('Max comments per page, 1..100.'),
				cursor: z
					.string()
					.optional()
					.describe('Opaque pagination cursor returned as next_cursor by a prior call.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await readLinkedInPostComments(ctx, args))
			} catch (err) {
				return toolError('linkedin_read_post_comments', err)
			}
		},
	)

	server.registerTool(
		'linkedin_get_post_engagement',
		{
			description:
				'Fetch engagement metrics for a LinkedIn post: reactions (total + a sample) and comments count, plus base post metadata. Fan-out of three Unipile calls (retrievePost + listReactions + countComments). A sub-call failure sets `partial_errors.<field>` and `is_partial: true` on the envelope — the caller keeps whatever was successfully collected. IMPRESSIONS ARE NOT AVAILABLE on Unipile v2 for third-party posts and are deliberately absent from the response — do not surface a fake impressions number to the user.',
			inputSchema: {
				post_id: z.string().min(1).describe('Post id.'),
			},
		},
		async (args) => {
			try {
				return jsonResult(await getLinkedInPostEngagement(ctx, args))
			} catch (err) {
				return toolError('linkedin_get_post_engagement', err)
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
