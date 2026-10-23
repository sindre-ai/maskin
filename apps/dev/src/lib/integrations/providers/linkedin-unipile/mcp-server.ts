import type { Database } from '@maskin/db'
import {
	deletePostInputShape,
	editPostInputShape,
	linkedinAttachmentsArraySchema,
} from '@maskin/mcp'
import type { LinkedInMcpInstanceConfig, LinkedInVerb } from '@maskin/mcp/linkedin'
import { toolName, toolsForIdentity } from '@maskin/mcp/linkedin'
import type { StorageProvider } from '@maskin/storage'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { FLAGS, isFlagEnabledForWorkspace } from '../../../feature-flags'
import { logger } from '../../../logger'
import { SendTargetError, assertSendable, recordSendOutcome } from '../../../send-closure'
import {
	type ActionFields,
	type ActionLogContext,
	type ActionRecorder,
	LinkedInActionRefusal,
	type LinkedInToolKind,
	withActionLog,
} from './action-log'
import type { CapSpec } from './caps'
import { LinkedInIntegrationError, isLinkedInIntegrationError } from './errors'
import {
	REINVITE_LOCK_DAYS,
	WITHDRAW_DAILY_CAP,
	addDays,
	findRecentWithdrawalOfPerson,
} from './invitation-withdrawal'
import {
	ATTACHMENTS_REFUSED_MESSAGE,
	commentOnLinkedInPost,
	deleteLinkedInPost,
	editLinkedInPost,
	getLinkedInInmailBalance,
	getLinkedInPostEngagement,
	getLinkedInProfile,
	listLinkedInConnections,
	listLinkedInConversations,
	listLinkedInMessages,
	listLinkedInSentInvitations,
	publishLinkedInPost,
	readLinkedInPostComments,
	replyToLinkedInComment,
	replyToLinkedInThread,
	searchLinkedInPeople,
	sendLinkedInConnectionRequest,
	sendLinkedInMessage,
	withdrawLinkedInInvitation,
} from './operations'
import { getLinkedInCompany, listLinkedInUserPosts, reactToLinkedInPost } from './posts-operations'
import { PROFILE_VIEW_CAP, type PostsToolDeps, REACT_TO_POST_CAP } from './posts-tools'
import { sendApprovedLinkedInObject } from './send-object'

/**
 * In-process MCP server for the LinkedIn (LinkedIn-backed) provider, served
 * over Streamable HTTP at `/api/integrations/linkedin-unipile/mcp/{instanceSlug}`
 * (one endpoint per connected LinkedIn identity). The un-slugged aggregate
 * `/api/integrations/linkedin-unipile/mcp` path is a deprecated, empty-tool
 * endpoint kept live for backwards compatibility — see
 * `routes/integrations-linkedin-unipile-mcp.ts`.
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
	/** The Maskin session making the call (X-Maskin-Session-Id), for the tool-call event only. */
	sessionId?: string | null
	/** Where workspace files are read from, for an approved message that carries one. */
	storage?: StorageProvider
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

const sendObjectIdSchema = z
	.string()
	.uuid()
	.optional()
	.describe(
		'The task or draft this send carries out. Once LinkedIn accepts the message, the server records the send on it and moves a task to done, so do not update it yourself. Refused, with nothing sent, if that object was already sent.',
	)

/**
 * Runs a send and, when the caller named the object it carries out, ends that object with
 * the send: the object is checked before anything goes out (it exists, it was not sent
 * before) and the send is recorded on it afterwards. Without `object_id` the send behaves
 * exactly as before.
 */
async function sendForObject<T extends object>(
	ctx: LinkedInMcpContext,
	objectId: string | undefined,
	send: () => Promise<T>,
	eventData: (sent: T) => Record<string, unknown>,
) {
	if (!objectId) return jsonResult(await send())
	let target: Awaited<ReturnType<typeof assertSendable>>
	try {
		target = await assertSendable(ctx.db, { workspaceId: ctx.workspaceId, objectId })
	} catch (err) {
		if (err instanceof SendTargetError) {
			throw new LinkedInIntegrationError('INVALID_INPUT', err.message)
		}
		throw err
	}
	const sent = await send()
	const outcome = await recordSendOutcome(ctx.db, {
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		target,
		provider: 'linkedin',
		data: eventData(sent),
	})
	return jsonResult({ ...sent, object: { id: target.id, ...outcome } })
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
	const allowed = new Set<LinkedInVerb>(toolsForIdentity(cfg))
	const opCtx = {
		db: ctx.db,
		actorId: ctx.actorId,
		workspaceId: ctx.workspaceId,
		identity: cfg,
		storage: ctx.storage,
	}
	const logCtx: ActionLogContext = {
		db: ctx.db,
		workspaceId: ctx.workspaceId,
		actorId: ctx.actorId,
		integrationId: cfg.integrationId,
		identityType: cfg.identityType,
		sessionId: ctx.sessionId,
	}
	/**
	 * Every handler below runs inside this: one linkedin_actions row and one linkedin_tool_called
	 * event per call, whatever the outcome. `target` is the person or company known before the
	 * call; `run` adds what the call learns through the recorder.
	 */
	const logged = <T>(
		verb: LinkedInVerb,
		kind: LinkedInToolKind,
		target: string | undefined,
		run: (rec: ActionRecorder) => Promise<T>,
		cap?: CapSpec,
	) => withActionLog(logCtx, { tool: verb, kind, targetProviderId: target, cap }, run)
	/**
	 * A handle or slug that list_user_posts must turn into a provider id is a profile view of its
	 * own: it takes a slot from the same daily budget and is logged as a get_profile or
	 * get_company row.
	 */
	const viewLookup: PostsToolDeps['lookup'] = (tool, run) =>
		withActionLog(logCtx, { tool, kind: 'read', cap: PROFILE_VIEW_CAP }, async (rec) => {
			const author = await run()
			rec.set({ targetProviderId: author.provider_id })
			return author
		})
	/** Records what a finished call learned, and that a replay or already-gone result changed nothing. */
	const learned = <T extends object>(rec: ActionRecorder, result: T, fields: ActionFields): T => {
		rec.set(fields)
		const flags = result as { replayed?: unknown; already_deleted?: unknown }
		if (flags.replayed === true || flags.already_deleted === true) rec.markNoop()
		return result
	}

	if (allowed.has('publish_post')) {
		server.registerTool(
			toolName(cfg, 'publish_post'),
			{
				description: scopedDescription('Publish a LinkedIn post', cfg),
				inputSchema: {
					text: z
						.string()
						.min(1)
						.max(3000)
						.describe('Post body. Max 3000 chars — LinkedIn hard limit.'),
					attachments: linkedinAttachmentsArraySchema
						.optional()
						.describe(
							'Optional attachments. LinkedIn accepts up to 9 images together (carousel) OR exactly one non-image (video or document). Mixed types are rejected.',
						),
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
					return jsonResult(
						await logged('publish_post', 'write', undefined, async (rec) => {
							const result = await publishLinkedInPost(opCtx, args)
							return learned(rec, result, { refId: result.post_id })
						}),
					)
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
					return jsonResult(
						await logged('read_post_comments', 'read', undefined, () =>
							readLinkedInPostComments(opCtx, args),
						),
					)
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
					return jsonResult(
						await logged('comment_on_post', 'write', undefined, async (rec) => {
							const result = await commentOnLinkedInPost(opCtx, args)
							return learned(rec, result, { refId: result.comment_id })
						}),
					)
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
					return jsonResult(
						await logged('reply_to_comment', 'write', undefined, async (rec) => {
							const result = await replyToLinkedInComment(opCtx, args)
							return learned(rec, result, { refId: result.comment_id })
						}),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'reply_to_comment'), err)
				}
			},
		)
	}

	if (allowed.has('edit_post')) {
		server.registerTool(
			toolName(cfg, 'edit_post'),
			{
				description: scopedDescription(
					'Edit the text or commenting permissions of a LinkedIn post this identity already published. Does NOT accept attachments — LinkedIn v2 only allows text + can_comment on edit (attachments are frozen at publish time). Fails with POST_NOT_FOUND if this identity is not the post author. LinkedIn shows an "edited" marker on the post after this call. Two identical edits of the same post_id within 24h dedup on the linkedin_tool_calls ledger keyed on (actor_id, tool_name, target_id).',
					cfg,
				),
				inputSchema: editPostInputShape,
			},
			async (args) => {
				try {
					// No ref id: the same post can be edited many times and each edit is a real action,
					// so it must not collide on the one-ok-row-per-ref index.
					return jsonResult(
						await logged('edit_post', 'write', undefined, () => editLinkedInPost(opCtx, args)),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'edit_post'), err)
				}
			},
		)
	}

	if (allowed.has('delete_post')) {
		server.registerTool(
			toolName(cfg, 'delete_post'),
			{
				description: scopedDescription(
					'Delete a LinkedIn post this identity already published. Irreversible. Fails with POST_NOT_FOUND if this identity is not the post author. LinkedIn returns 204 on success; a SECOND call for the same post_id returns POST_NOT_FOUND — treat that as a successful no-op (the response envelope reports `already_deleted: true`). Two identical deletes within 24h dedup on the linkedin_tool_calls ledger.',
					cfg,
				),
				inputSchema: deletePostInputShape,
			},
			async (args) => {
				try {
					return jsonResult(
						await logged('delete_post', 'write', undefined, async (rec) => {
							const result = await deleteLinkedInPost(opCtx, args)
							return learned(rec, result, { refId: result.post_id })
						}),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'delete_post'), err)
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
					return jsonResult(
						await logged('get_post_engagement', 'read', undefined, () =>
							getLinkedInPostEngagement(opCtx, args),
						),
					)
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
				description: scopedDescription(
					'Send a LinkedIn direct message. To send a draft a person approved on its card, pass object_id (the task or object that holds the draft): the text sent is the approved text read from the object, and it is refused until a person has approved it. The recipient (recipient_provider_id) and an optional file (attachment_file_id) are filed on the object, and a message with a thread_id on the object goes into that conversation. Then recipient_urn, body and idempotency_key are not used. Without object_id, pass recipient_urn, body and idempotency_key; plain text only, this tool takes no attachments',
					cfg,
				),
				// Passthrough so a call that still sends the removed `attachments` reaches the handler and
				// is refused by name, instead of the field being dropped and the text going out alone.
				inputSchema: z
					.object({
						recipient_urn: z.string().min(1).optional(),
						body: z.string().min(1).max(8000).optional(),
						idempotency_key: z.string().min(1).max(128).optional(),
						object_id: sendObjectIdSchema,
					})
					.passthrough(),
			},
			async (args) => {
				try {
					return await logged('send_message', 'send', args.recipient_urn, async (rec) => {
						if ((args as { attachments?: unknown }).attachments !== undefined) {
							throw new LinkedInIntegrationError('INVALID_INPUT', ATTACHMENTS_REFUSED_MESSAGE)
						}
						if (args.object_id) {
							rec.set({ objectId: args.object_id })
							if (args.body !== undefined || args.recipient_urn !== undefined) {
								throw new LinkedInIntegrationError(
									'INVALID_INPUT',
									'Do not pass body or recipient_urn with object_id: the text and the recipient sent are the ones on the approved object.',
								)
							}
							const sent = await sendApprovedLinkedInObject(opCtx, {
								object_id: args.object_id,
								onResolved: (resolved) => rec.set(resolved),
							})
							return jsonResult(learned(rec, sent, { refId: sent.message_id }))
						}
						const sent = await sendLinkedInMessage(opCtx, args)
						return jsonResult(learned(rec, sent, { refId: sent.message_id }))
					})
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
				description: scopedDescription(
					'Reply in an existing LinkedIn conversation thread. To send a draft a person approved on its card, pass object_id (the task or object that holds the draft): the text sent is the approved text read from the object, and it is refused until a person has approved it. Then thread_id is optional when the object has metadata.thread_id, and body and idempotency_key are not used. Without object_id, pass thread_id, body and idempotency_key',
					cfg,
				),
				inputSchema: {
					object_id: sendObjectIdSchema,
					thread_id: z.string().min(1).optional(),
					body: z.string().min(1).max(8000).optional(),
					in_reply_to_message_id: z
						.string()
						.min(1)
						.optional()
						.describe(
							'Id of the inbound message you are answering. The server builds the idempotency key from the thread and this id, so a webhook reply and a sweep reply to the same message send once. On the webhook path this is message_id from the event data; on the sweep path it is the last inbound message id from list_messages. Any idempotency_key you also pass is ignored. Not used with object_id.',
						),
					idempotency_key: z
						.string()
						.min(1)
						.max(128)
						.optional()
						.describe(
							'Legacy. Only used when in_reply_to_message_id is absent, and logs a warning. Prefer in_reply_to_message_id.',
						),
				},
			},
			async (args) => {
				try {
					return await logged('reply', 'send', undefined, async (rec) => {
						if (args.object_id) {
							rec.set({ objectId: args.object_id })
							if (args.body !== undefined) {
								throw new LinkedInIntegrationError(
									'INVALID_INPUT',
									'Do not pass body with object_id: the text sent is the approved text on the object.',
								)
							}
							const sent = await sendApprovedLinkedInObject(opCtx, {
								object_id: args.object_id,
								thread_id: args.thread_id,
								onResolved: (resolved) => rec.set(resolved),
							})
							return jsonResult(learned(rec, sent, { refId: sent.message_id }))
						}
						const sent = await replyToLinkedInThread(opCtx, args)
						return jsonResult(learned(rec, sent, { refId: sent.message_id }))
					})
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
				description: scopedDescription('List LinkedIn conversations', cfg),
				inputSchema: {
					limit: z.number().int().min(1).max(50).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(
						await logged('list_conversations', 'read', undefined, () =>
							listLinkedInConversations(opCtx, args),
						),
					)
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
					return jsonResult(
						await logged('list_messages', 'read', undefined, () =>
							listLinkedInMessages(opCtx, args),
						),
					)
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
					return jsonResult(
						await logged('list_connections', 'read', undefined, () =>
							listLinkedInConnections(opCtx, args),
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'list_connections'), err)
				}
			},
		)
	}

	if (allowed.has('list_sent_invitations')) {
		server.registerTool(
			toolName(cfg, 'list_sent_invitations'),
			{
				description: scopedDescription(
					"List the connection invitations this account sent that are still pending, in the order LinkedIn lists them. Each row has invitation_id, recipient_provider_id, public_identifier, name, headline, sent_at, age_days and message. sent_at and age_days are null when LinkedIn gave no date. older_than_days keeps rows at least that many days old and never matches a row with no date; rows_without_date says how many rows on the page had none. Page with next_offset (null on the last page): it counts rows on LinkedIn's list, so it moves the same with or without older_than_days. total_pending is null when LinkedIn gave no total.",
					cfg,
				),
				inputSchema: {
					limit: z.number().int().min(1).max(100).optional(),
					offset: z.number().int().min(0).optional(),
					older_than_days: z.number().int().min(0).max(3650).optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(
						await logged('list_sent_invitations', 'read', undefined, () =>
							listLinkedInSentInvitations(opCtx, args),
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'list_sent_invitations'), err)
				}
			},
		)
	}

	// The flag is read when the server is built, which is once per request, so with it off the
	// tool is absent from tools/list and cannot be called.
	if (
		allowed.has('withdraw_invitation') &&
		isFlagEnabledForWorkspace(ctx.workspaceId, FLAGS.LINKEDIN_OUTREACH_ACTIONS, {
			actorId: ctx.actorId,
		})
	) {
		server.registerTool(
			toolName(cfg, 'withdraw_invitation'),
			{
				description: scopedDescription(
					"Withdraw one pending connection invitation this account sent. Pass the invitation_id from list_sent_invitations. Only an invitation that is in this account's sent list and at least 14 days old can be withdrawn; where LinkedIn gave no send date, the age counts from the first time list_sent_invitations showed it. Anything else is refused with INVALID_INPUT and nothing is withdrawn. At most 30 withdrawals per rolling 24 hours (RATE_LIMITED_LINKEDIN, with the time a slot frees up). Returns invitation_id, recipient_provider_id, withdrawn, already_withdrawn (true when it was withdrawn before or is already gone; that costs nothing against the limit) and can_reinvite_after: LinkedIn blocks a new invitation to the same person for up to 21 days after a withdrawal, and send_connection_request refuses until then.",
					cfg,
				),
				inputSchema: { invitation_id: z.string().min(1) },
			},
			async (args) => {
				try {
					return jsonResult(
						await logged(
							'withdraw_invitation',
							'write',
							undefined,
							(rec) =>
								withdrawLinkedInInvitation(opCtx, args, {
									integrationId: cfg.integrationId,
									recorder: rec,
								}),
							WITHDRAW_DAILY_CAP,
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'withdraw_invitation'), err)
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
					return jsonResult(
						await logged('search_people', 'read', undefined, () =>
							searchLinkedInPeople(opCtx, args),
						),
					)
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
					object_id: sendObjectIdSchema,
				},
			},
			async (args) => {
				try {
					return await logged('send_connection_request', 'send', args.user_id, async (rec) => {
						rec.set({ objectId: args.object_id })
						// LinkedIn blocks a new invite to someone whose invite was withdrawn, and the
						// sweep that withdraws is automated, so the rule is enforced here, not in prompts.
						const withdrawnAt = await findRecentWithdrawalOfPerson(
							ctx.db,
							cfg.integrationId,
							args.user_id.trim(),
							new Date(),
						)
						if (withdrawnAt) {
							throw new LinkedInActionRefusal(
								'refused_rule',
								'INVALID_INPUT',
								`This account withdrew its invitation to this person on ${withdrawnAt.toISOString()}. LinkedIn blocks a new invitation to the same person for up to ${REINVITE_LOCK_DAYS} days after a withdrawal, so nothing was sent. Invite again after ${addDays(withdrawnAt, REINVITE_LOCK_DAYS).toISOString()}.`,
							)
						}
						return sendForObject(
							ctx,
							args.object_id,
							async () => {
								const sent = await sendLinkedInConnectionRequest(opCtx, args)
								return learned(rec, sent, { refId: sent.invitation_id })
							},
							(sent) => ({ invitation_id: sent.invitation_id, sent_at: sent.sent_at }),
						)
					})
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
				description: scopedDescription(
					'Fetch one LinkedIn profile by public handle, provider id, or the recipient_urn a prior search_people / list_connections result surfaced (a urn:li:... member URN is accepted and reduced to its bare provider id). Pass sections: ["experience"] to also get dated job history (company, title, start and end as ISO dates, current); it is off by default and only that value is supported. An experience pull is a heavier LinkedIn view that may be throttled: Unipile suggests staying under about 100 profile views per account per day. If the pull is throttled or rejected you still get the base profile plus experience_unavailable: true, never an empty list that looks like no jobs.',
					cfg,
				),
				inputSchema: {
					identifier: z.string().min(1),
					sections: z.array(z.enum(['experience'])).optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(
						await logged(
							'get_profile',
							'read',
							undefined,
							async (rec) => {
								const profile = await getLinkedInProfile(opCtx, args)
								return learned(rec, profile, { targetProviderId: profile.recipient_urn })
							},
							PROFILE_VIEW_CAP,
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'get_profile'), err)
				}
			},
		)
	}

	if (allowed.has('list_user_posts')) {
		server.registerTool(
			toolName(cfg, 'list_user_posts'),
			{
				description: scopedDescription(
					'List the recent posts of one person or one company. Pass exactly one of person (public handle, provider id or member URN) or company (numeric id, slug or company URL). Returns author (provider_id, type, name, public_identifier), posts (post_id, posted_at, text cut to 500 characters, is_repost, reactions, comments, already_liked, url) and next_cursor. Use post_id exactly as returned for react_to_post and read_post_comments. A handle or slug costs two profile views, a provider id or numeric company id costs one; profile views share a budget of 100 a day with get_profile and get_company.',
					cfg,
				),
				inputSchema: {
					person: z.string().min(1).optional(),
					company: z.string().min(1).optional(),
					limit: z.number().int().min(1).max(20).optional(),
					cursor: z.string().optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(
						await logged(
							'list_user_posts',
							'read',
							undefined,
							async (rec) => {
								const result = await listLinkedInUserPosts(opCtx, args, viewLookup)
								return learned(rec, result, { targetProviderId: result.author.provider_id })
							},
							PROFILE_VIEW_CAP,
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'list_user_posts'), err)
				}
			},
		)
	}

	if (allowed.has('get_company')) {
		server.registerTool(
			toolName(cfg, 'get_company'),
			{
				description: scopedDescription(
					'Look up one LinkedIn company: company_id, name, public_identifier, industry, size_band, headcount, headquarters, website, follower_count, description (cut to 500 characters) and url. Pass company as a numeric id, a slug or a linkedin.com/company URL. Costs one profile view of the 100 a day shared with get_profile and list_user_posts.',
					cfg,
				),
				inputSchema: { company: z.string().min(1) },
			},
			async (args) => {
				try {
					return jsonResult(
						await logged(
							'get_company',
							'read',
							undefined,
							async (rec) => {
								const company = await getLinkedInCompany(opCtx, args)
								return learned(rec, company, { targetProviderId: company.company_id })
							},
							PROFILE_VIEW_CAP,
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'get_company'), err)
				}
			},
		)
	}

	// A write tool the outreach flag gates is not registered while the flag is off. The server
	// is built per request, so switching the flag needs no other code.
	if (
		allowed.has('react_to_post') &&
		isFlagEnabledForWorkspace(ctx.workspaceId, FLAGS.LINKEDIN_OUTREACH_ACTIONS, {
			actorId: ctx.actorId,
		})
	) {
		server.registerTool(
			toolName(cfg, 'react_to_post'),
			{
				description: scopedDescription(
					'Like one LinkedIn post. Pass post_id exactly as list_user_posts returned it and author_provider_id (author.provider_id from the same call). Only a like is supported. Limits: 15 likes a day, and one like per author per 7 days; a post this account already liked returns already_liked: true and sends nothing.',
					cfg,
				),
				inputSchema: {
					post_id: z.string().trim().min(1),
					author_provider_id: z.string().trim().min(1),
					reaction: z.enum(['like']).optional(),
				},
			},
			async (args) => {
				try {
					return jsonResult(
						await logged(
							'react_to_post',
							'write',
							args.author_provider_id,
							async (rec) => {
								const result = await reactToLinkedInPost(opCtx, logCtx, args)
								rec.set({ refId: result.post_id })
								if (result.already_liked) rec.markNoop()
								return result
							},
							REACT_TO_POST_CAP,
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'react_to_post'), err)
				}
			},
		)
	}

	if (allowed.has('get_inmail_balance')) {
		server.registerTool(
			toolName(cfg, 'get_inmail_balance'),
			{
				description: scopedDescription(
					'Read the InMail credits of this account. Returns seat (premium, sales_navigator, recruiter, free or unknown when the credits call failed), credits_classic, credits_sales_navigator, and sendable_now: classic credits above the 2 we always keep back, never below 0. Check it before drafting an InMail; at sendable_now 0 do not draft one.',
					cfg,
				),
				inputSchema: {},
			},
			async () => {
				try {
					return jsonResult(
						await logged('get_inmail_balance', 'read', undefined, () =>
							getLinkedInInmailBalance(opCtx),
						),
					)
				} catch (err) {
					return toolError(toolName(cfg, 'get_inmail_balance'), err)
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
	/** Called before any tool is registered, e.g. to gate tools on the caller's access. */
	onServer?: (server: McpServer) => void,
): McpServer {
	const server = new McpServer({ name: 'maskin-linkedin', version: '0.2.0' })
	onServer?.(server)
	for (const cfg of instances) {
		registerLinkedInMcpInstance(server, cfg, ctx)
	}
	return server
}
