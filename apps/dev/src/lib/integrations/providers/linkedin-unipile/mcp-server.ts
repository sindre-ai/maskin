import type { Database } from '@maskin/db'
import {
	deletePostInputShape,
	editPostInputShape,
	linkedinAttachmentsArraySchema,
} from '@maskin/mcp'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'
import { isLinkedInIntegrationError } from './errors'
import {
	commentOnLinkedInPost,
	deleteLinkedInPost,
	editLinkedInPost,
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
	sendLinkedInConnectionRequest,
	sendLinkedInMessage,
} from './operations'

/**
 * In-process MCP server for the LinkedIn (LinkedIn-backed) provider, served
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
						'Provider id of the recipient member, as returned in the `recipient_urn` field of linkedin_list_conversations — an opaque LinkedIn member id like "ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx". Pass it through verbatim. It is NOT a "urn:li:person:..." URN: do not construct one, do not reformat this value, and do not pass a LinkedIn account_id.',
					),
				body: z
					.string()
					.min(1)
					.max(8000)
					.describe(
						'Plain-text message body. Max 8000 chars (LinkedIn hard limit). No HTML; newlines allowed.',
					),
				attachments: linkedinAttachmentsArraySchema
					.optional()
					.describe(
						'Optional messaging attachments. Each entry carries `send_mode` (native vs file) — LinkedIn inlines "native" attachments in the DM and delivers "file" attachments as a hosted file link. LinkedIn accepts up to 9 images together (carousel) OR exactly one non-image (video or document). Mixed types are rejected.',
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
		'linkedin_send_connection_request',
		{
			description:
				"Send a LinkedIn connection invitation from the connected identity of the calling actor to a target member. Use this BEFORE linkedin_send_message when linkedin_search_people or linkedin_get_profile reports the target as SECOND_DEGREE or THIRD_DEGREE — LinkedIn does not let you DM a non-connection without an invitation first. On success returns { status: 'sent', sent_at }. Two failure classes matter for agent branching: LINKEDIN_INVITE_QUOTA_EXCEEDED means LinkedIn has spent the connected account's weekly invite quota — stop sending invitations from this identity for the week and tell a human; LINKEDIN_ALREADY_CONNECTED means the target is already a first-degree connection OR has an outstanding invitation from this account — treat it as a successful no-op and move on to linkedin_send_message.",
			inputSchema: {
				user_id: z
					.string()
					.min(1)
					.describe(
						'LinkedIn provider id of the member to invite — the same opaque id that appears as `recipient_urn` on linkedin_search_people / linkedin_list_connections / linkedin_get_profile results (e.g. "ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxxx"). Pass it through verbatim. It is NOT a "urn:li:person:..." URN and NOT the target\'s public handle: do not construct one or pass "janedoe" here — use linkedin_get_profile with the handle first, then pass its `recipient_urn`.',
					),
				message: z
					.string()
					.optional()
					.describe(
						"Optional personal note attached to the invitation. LinkedIn enforces the length cap on the wire (currently 200 chars); an over-long note surfaces as an INVALID_INPUT / LINKEDIN_INVITE_QUOTA_EXCEEDED error rather than a client-side rejection. Leave omitted for a bare invite, or keep short and specific — LinkedIn's own research shows short, specific notes convert better than generic ones.",
					),
			},
		},
		async (args) => {
			try {
				return jsonResult(await sendLinkedInConnectionRequest(ctx, args))
			} catch (err) {
				return toolError('linkedin_send_connection_request', err)
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
	// comments — impressions unavailable on LinkedIn v2). The four destructive
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
				attachments: linkedinAttachmentsArraySchema
					.optional()
					.describe(
						'Optional attachments. LinkedIn accepts up to 9 images together (carousel) OR exactly one non-image (video or document). Mixed types are rejected. Each entry: base64 `content`, `content_type` (one of the LinkedIn-supported MIME types), and `filename`.',
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
						'Provider-specific opaque payload passed through to LinkedIn — reserved for advanced options that do not warrant a named field.',
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

	// ── R11-B destructive post CRUD (edit/delete) ─────────────────────────
	// Two verbs the R11-A fan-out registers per-identity as
	// `linkedin-{accSlug}-{identitySlug}__edit_post` /
	// `__delete_post`. R11-A's concrete registrar has not landed yet, so the
	// current shell registers them under the Phase-1 flat naming; R11-A will
	// re-namespace on top when its follow-up commits land.

	server.registerTool(
		'linkedin_edit_post',
		{
			description:
				'Edit the text OR commenting permissions of a LinkedIn post the connected identity already published. Does NOT accept attachments — LinkedIn v2 only allows text + can_comment on edit (attachments are frozen at publish time). Fails with POST_NOT_FOUND if this identity is not the post author. LinkedIn shows an "edited" marker on the post after this call. Two identical edits of the same post_id within 24h dedup on the linkedin_tool_calls ledger keyed on (actor_id, tool_name, target_id).',
			inputSchema: editPostInputShape,
		},
		async (args) => {
			try {
				return jsonResult(await editLinkedInPost(ctx, args))
			} catch (err) {
				return toolError('linkedin_edit_post', err)
			}
		},
	)

	server.registerTool(
		'linkedin_delete_post',
		{
			description:
				'Delete a LinkedIn post the connected identity already published. Irreversible. Fails with POST_NOT_FOUND if this identity is not the post author. LinkedIn returns 204 on success; a SECOND call for the same post_id returns POST_NOT_FOUND — treat that as a successful no-op (the response envelope reports `already_deleted: true`). Two identical deletes within 24h dedup on the linkedin_tool_calls ledger.',
			inputSchema: deletePostInputShape,
		},
		async (args) => {
			try {
				return jsonResult(await deleteLinkedInPost(ctx, args))
			} catch (err) {
				return toolError('linkedin_delete_post', err)
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
						'LinkedIn company page URN, e.g. `urn:li:organization:12345`. The connected LinkedIn account must be an admin of the page — LinkedIn relays the publish under the page identity via `post_as`.',
					),
				attachments: linkedinAttachmentsArraySchema
					.optional()
					.describe(
						'Optional attachments. LinkedIn accepts up to 9 images together (carousel) OR exactly one non-image (video or document). Mixed types are rejected.',
					),
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
					.describe('Provider-specific opaque payload passed through to LinkedIn.'),
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
				'Post a top-level comment on a LinkedIn post as the connected personal profile. Returns the new comment_id — use it with linkedin_reply_to_comment to thread further. Dedup semantics identical to linkedin_publish_post: an identical call within 24h replays the stored response without hitting LinkedIn again.',
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
				'Fetch engagement metrics for a LinkedIn post: reactions (total + a sample) and comments count, plus base post metadata. Fan-out of three LinkedIn calls (retrievePost + listReactions + countComments). A sub-call failure sets `partial_errors.<field>` and `is_partial: true` on the envelope — the caller keeps whatever was successfully collected. IMPRESSIONS ARE NOT AVAILABLE on LinkedIn v2 for third-party posts and are deliberately absent from the response — do not surface a fake impressions number to the user.',
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
