import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { capturePosthogEvent } from '../../../analytics/posthog'
import { logger } from '../../../logger'
import {
	SlackApiError,
	downloadSlackText,
	isSlackBotToken,
	slackApiCall,
	slackPaginate,
} from './slack-api'

// Re-exported: session-manager.ts and the MCP route both import the guard from
// here, and the tests assert on it. The implementation now lives in slack-api.ts
// alongside the transport it guards.
export { isSlackBotToken, isSlackUserToken } from './slack-api'

/** Pages of `conversations.list` to walk before giving up and reporting truncation. */
const MAX_CHANNEL_PAGES = 10
/** Pages of `users.list` to walk before giving up and reporting truncation. */
const MAX_USER_PAGES = 10
/** Slack's own per-page maximum for the listing endpoints. */
const LIST_PAGE_SIZE = 200
/**
 * `conversations.join` failures that genuinely mean "Maskin cannot add itself,
 * a human must invite it" — the only cases where the original `not_in_channel`
 * text ("this one is private, so a human must invite the Maskin app") is a true
 * statement rather than a guess. Slack answers a private channel with
 * `method_not_supported_for_channel_type`, and an invite-only or restricted one
 * with `restricted_action` / `channel_not_found`. Anything else (missing scope,
 * rate limit, revoked token, 5xx) is reported on its own terms instead.
 */
const JOIN_MEMBERSHIP_REFUSALS = new Set([
	'method_not_supported_for_channel_type',
	'restricted_action',
	'channel_not_found',
	'is_archived',
])

/** Inline canvas text returned to an agent, in characters. */
const MAX_CANVAS_CHARS = 100_000

export interface SlackToolContext {
	/**
	 * Bot token (`xoxb-...`). Used for every read and write except search.
	 * Resolution is caller-owned so the route can look it up per-request from
	 * the active workspace integration.
	 */
	botToken: string
	/**
	 * The installer's user token (`xoxp-...`), present only when the install
	 * granted `search:read`. `search.messages` has no bot-token equivalent, so
	 * the search tool is registered ONLY when this is set — an agent's tool list
	 * then reflects what the workspace can actually do, instead of advertising a
	 * tool that always fails.
	 *
	 * Never used for writes. See `assertBotToken`.
	 */
	userToken?: string
	/**
	 * Subscript shown next to the bot — combines the calling agent's name
	 * with the workspace name, e.g. `Synthesizer · in mesh-firm`.
	 */
	agentLabel: string
	/** PNG URL for the shared Maskin avatar; omitted when unset. */
	iconUrl?: string
	/** For logs only — tells us which workspace the call came from. */
	workspaceId: string
	/** For logs only — tells us which actor in that workspace called. */
	actorId: string
	/**
	 * Slack `team_id` for the workspace integration — drives the ship metric
	 * breakdown by Slack workspace. Sourced from `integration.externalId`.
	 */
	slackTeamId?: string
}

/** @deprecated Kept so existing imports keep compiling; use `SlackToolContext`. */
export type SlackPostContext = SlackToolContext

interface SlackPostMessageResponse {
	ok: boolean
	ts?: string
	channel?: string
	error?: string
}

/**
 * Every write path runs through this.
 *
 * With both tokens now on the integration row, a plumbing mistake that handed
 * the user token to `chat.postMessage` would silently attribute agent messages
 * to the human who installed the app — the original mesh-firm bug. Assert at the
 * write boundary rather than trusting the call sites.
 */
function assertBotToken(ctx: SlackToolContext): string {
	if (!isSlackBotToken(ctx.botToken)) {
		throw new SlackApiError(
			'not_bot_token',
			'Slack integration is misconfigured: the stored access token is not a bot token (expected an xoxb- prefix). Reconnect Slack to grant bot scopes.',
		)
	}
	return ctx.botToken
}

/** Standard MCP success envelope — one JSON payload in `content`. */
function ok(payload: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(payload, null, 2) }] }
}

async function slackPostMessage(
	ctx: SlackToolContext,
	args: { channel: string; text: string; thread_ts?: string },
): Promise<SlackPostMessageResponse> {
	const token = assertBotToken(ctx)
	const body: Record<string, unknown> = {
		channel: args.channel,
		text: args.text,
		username: 'Maskin',
	}
	if (ctx.iconUrl) body.icon_url = ctx.iconUrl
	if (args.thread_ts) body.thread_ts = args.thread_ts
	if (ctx.agentLabel?.trim()) {
		body.blocks = [
			{ type: 'section', text: { type: 'mrkdwn', text: args.text } },
			{ type: 'context', elements: [{ type: 'mrkdwn', text: ctx.agentLabel }] },
		]
	}
	return slackApiCall<SlackPostMessageResponse>(token, 'chat.postMessage', body, 'POST')
}

/**
 * Read a conversation, joining the channel first if that is what is blocking.
 *
 * `conversations.history` / `.replies` answer `not_in_channel` unless the bot is
 * a member. For a public channel that is a formality we can clear ourselves with
 * the `channels:join` scope. For a private channel it genuinely needs a human to
 * invite the app, so the original (actionable) error is what surfaces.
 */
async function readConversation<T>(
	ctx: SlackToolContext,
	method: 'conversations.history' | 'conversations.replies',
	params: Record<string, unknown>,
): Promise<T> {
	const token = assertBotToken(ctx)
	try {
		return await slackApiCall<T>(token, method, params, 'GET')
	} catch (err) {
		if (!(err instanceof SlackApiError) || err.code !== 'not_in_channel') throw err
		try {
			await slackApiCall(token, 'conversations.join', { channel: params.channel }, 'POST')
		} catch (joinErr) {
			// The join failed — but WHY decides what the caller should be told.
			//
			// The `not_in_channel` text asserts the channel is private and a human
			// must `/invite @Maskin`. That is only true when the join was refused on
			// membership grounds. Blanket-rethrowing `err` here would state that
			// diagnosis for a missing `channels:join` scope, a rate limit, a revoked
			// token or a Slack 5xx as well — sending an admin to invite the app into
			// a public channel, where it will fail again for the unchanged real
			// reason. So: surface the join error when it stands on its own terms,
			// and keep the invite instruction only for a genuine membership refusal.
			const joinCode = joinErr instanceof SlackApiError ? joinErr.code : 'unknown'
			logger.warn('Slack auto-join failed while satisfying a read', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: String(params.channel),
				method,
				joinCode,
				error: joinErr instanceof Error ? joinErr.message : String(joinErr),
			})
			if (!JOIN_MEMBERSHIP_REFUSALS.has(joinCode)) throw joinErr
			throw err
		}
		logger.info('Joined Slack channel to satisfy a read', {
			workspaceId: ctx.workspaceId,
			actorId: ctx.actorId,
			channel: String(params.channel),
		})
		return await slackApiCall<T>(token, method, params, 'GET')
	}
}

interface SlackChannel {
	id: string
	name?: string
	is_private?: boolean
	is_archived?: boolean
	num_members?: number
	topic?: { value?: string }
	purpose?: { value?: string }
}

interface SlackUser {
	id: string
	name?: string
	real_name?: string
	deleted?: boolean
	is_bot?: boolean
	profile?: Record<string, unknown>
}

function summariseChannel(c: SlackChannel) {
	return {
		id: c.id,
		name: c.name,
		is_private: c.is_private ?? false,
		is_archived: c.is_archived ?? false,
		num_members: c.num_members,
		topic: c.topic?.value || undefined,
		purpose: c.purpose?.value || undefined,
	}
}

function summariseUser(u: SlackUser) {
	const profile = (u.profile ?? {}) as Record<string, unknown>
	return {
		id: u.id,
		name: u.name,
		real_name: u.real_name ?? (profile.real_name as string | undefined),
		title: profile.title as string | undefined,
		is_bot: u.is_bot ?? false,
		deleted: u.deleted ?? false,
	}
}

/**
 * Build a fresh MCP server per request.
 *
 * Identity (`agentLabel`, `iconUrl`) and both tokens are bound at construction
 * time so a single connection cannot be reused across workspaces by mistake.
 */
export function createSlackMcpServer(ctx: SlackToolContext): McpServer {
	const server = new McpServer({ name: 'maskin-slack', version: '0.2.0' })

	// Log every tool failure exactly once, at the boundary where it leaves us.
	//
	// Without this, nothing here is observable. The MCP SDK turns a thrown error
	// into an `isError` text result and answers the transport with a 200, so a
	// Slack outage, a workspace-wide missing scope or a revoked token is visible
	// only inside individual agent transcripts — and when a customer reports "the
	// agent can't read Slack", there is nothing to query. The rest of this
	// provider (mention.ts, fan-out.ts, unfurl.ts) logs failures consistently;
	// wrapping registration keeps the 13 handlers below from each having to
	// remember to. Rethrows unchanged: the agent-facing prose is unaffected.
	const registerTool: McpServer['registerTool'] = (name, config, handler) =>
		server.registerTool(name, config, (async (...handlerArgs: unknown[]) => {
			try {
				return await (handler as (...a: unknown[]) => unknown)(...handlerArgs)
			} catch (err) {
				logger.error('Slack MCP tool failed', {
					tool: name,
					workspaceId: ctx.workspaceId,
					actorId: ctx.actorId,
					slackTeamId: ctx.slackTeamId,
					code: err instanceof SlackApiError ? err.code : 'unknown',
					needed: err instanceof SlackApiError ? err.needed : undefined,
					error: err instanceof Error ? err.message : String(err),
				})
				throw err
			}
		}) as typeof handler)

	// ----------------------------------------------------------------- writing

	registerTool(
		'slack_send_message',
		{
			description:
				'Post a message to Slack as Maskin. The calling agent\'s name and the workspace name are appended automatically as the `username` subscript (e.g. "Synthesizer · in mesh-firm") — do not prefix the message text with your own identity. To post later instead of now, use `slack_schedule_message`.',
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe(
						'Slack channel or DM ID (e.g. `C0123456789`) or `#channel-name`. Look one up with `slack_search_channels`.',
					),
				text: z
					.string()
					.min(1)
					.describe(
						'Message text. Slack mrkdwn is supported. The post will be attributed to the calling agent — username and avatar are set server-side, do not include them here.',
					),
				thread_ts: z
					.string()
					.optional()
					.describe('Reply in a thread by passing the parent message ts.'),
			},
		},
		async (args: { channel: string; text: string; thread_ts?: string }) => {
			const result = await slackPostMessage(ctx, args)
			logger.info('Slack chat.postMessage succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: result.channel ?? args.channel,
				ts: result.ts,
				agentLabel: ctx.agentLabel,
			})
			void capturePosthogEvent('slack.message.posted', ctx.workspaceId, {
				workspace_id: ctx.workspaceId,
				slack_team_id: ctx.slackTeamId ?? null,
				posted_as_machine: isSlackBotToken(ctx.botToken),
				has_agent_subscript: Boolean(ctx.agentLabel?.trim()),
				agent_actor_id: ctx.actorId,
			})
			return ok({ ok: true, ts: result.ts, channel: result.channel ?? args.channel })
		},
	)

	registerTool(
		'slack_schedule_message',
		{
			description:
				'Schedule a message to be posted to Slack at a future time, as Maskin. Same attribution rules as `slack_send_message`. Returns a `scheduled_message_id`.',
			inputSchema: {
				channel: z.string().min(1).describe('Slack channel or DM ID.'),
				text: z.string().min(1).describe('Message text. Slack mrkdwn is supported.'),
				post_at: z
					.number()
					.int()
					.positive()
					.describe('Unix timestamp (seconds) at which to post. Must be in the future.'),
				thread_ts: z.string().optional().describe('Reply in a thread by passing the parent ts.'),
			},
		},
		async (args: { channel: string; text: string; post_at: number; thread_ts?: string }) => {
			const token = assertBotToken(ctx)
			const body: Record<string, unknown> = {
				channel: args.channel,
				text: args.text,
				post_at: args.post_at,
				username: 'Maskin',
			}
			if (ctx.iconUrl) body.icon_url = ctx.iconUrl
			if (args.thread_ts) body.thread_ts = args.thread_ts
			const res = await slackApiCall<{ scheduled_message_id?: string; post_at?: number }>(
				token,
				'chat.scheduleMessage',
				body,
				'POST',
			)
			return ok({
				ok: true,
				scheduled_message_id: res.scheduled_message_id,
				post_at: res.post_at ?? args.post_at,
				channel: args.channel,
			})
		},
	)

	// ----------------------------------------------------------------- reading

	registerTool(
		'slack_search_channels',
		{
			description:
				'Find Slack channels by name, topic or purpose. Returns channel ids, names, topics, purposes, member counts and archive status. This is the tool to use when you have a channel NAME and need its `C...` id, or have a channel id and need to know what it is. Read-only.',
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe(
						'Case-insensitive substring matched against channel name, topic and purpose. Omit to list every channel. Channel names are usually lowercase with hyphens.',
					),
				include_private: z
					.boolean()
					.optional()
					.describe('Include private channels Maskin has been invited to. Default true.'),
				include_archived: z
					.boolean()
					.optional()
					.describe('Include archived channels. Default false.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Maximum channels to return after filtering. Default 100.'),
			},
		},
		async (args: {
			query?: string
			include_private?: boolean
			include_archived?: boolean
			limit?: number
		}) => {
			const token = assertBotToken(ctx)
			const types =
				args.include_private === false ? 'public_channel' : 'public_channel,private_channel'
			const { items, truncated } = await slackPaginate<SlackChannel>(
				token,
				'conversations.list',
				{
					types,
					limit: LIST_PAGE_SIZE,
					exclude_archived: args.include_archived ? undefined : true,
				},
				(page) => (page.channels as SlackChannel[] | undefined) ?? [],
				MAX_CHANNEL_PAGES,
			)

			const needle = args.query?.trim().toLowerCase()
			const matched = needle
				? items.filter((c) =>
						[c.name, c.topic?.value, c.purpose?.value]
							.filter(Boolean)
							.some((field) => (field as string).toLowerCase().includes(needle)),
					)
				: items
			const limit = args.limit ?? 100
			const channels = matched.slice(0, limit).map(summariseChannel)

			return ok({
				channels,
				total_matched: matched.length,
				total_scanned: items.length,
				// Never let a cap look like an empty result: an agent that reads
				// "no matches" as "no such channel" is the exact failure this tool
				// surface exists to fix.
				...(truncated
					? {
							warning: `Only the first ${items.length} channels were scanned (page cap reached), so this list may be incomplete. Narrow the query, or set include_private/include_archived to reduce the set.`,
						}
					: {}),
				...(matched.length > channels.length
					? {
							note: `${matched.length} channels matched; showing the first ${channels.length}.`,
						}
					: {}),
			})
		},
	)

	registerTool(
		'slack_get_channel_info',
		{
			description:
				'Get full metadata for one Slack channel by id: name, topic, purpose, privacy, archive status, member count and creation time. Use `slack_search_channels` when you only know the name. Read-only.',
			inputSchema: {
				channel_id: z.string().min(1).describe('Channel id, e.g. `C0123456789`.'),
			},
		},
		async (args: { channel_id: string }) => {
			const token = assertBotToken(ctx)
			const res = await slackApiCall<{ channel?: SlackChannel & { created?: number } }>(
				token,
				'conversations.info',
				{ channel: args.channel_id, include_num_members: true },
				'GET',
			)
			if (!res.channel) return ok({ channel: null })
			return ok({ channel: { ...summariseChannel(res.channel), created: res.channel.created } })
		},
	)

	registerTool(
		'slack_read_channel',
		{
			description:
				'Read messages from a Slack channel, newest first. Also reads a DM with Maskin by passing the DM id. If Maskin is not yet in a public channel it joins automatically; a private channel needs a human to run `/invite @Maskin`. Use `slack_read_thread` to expand a message that has replies. Read-only.',
			inputSchema: {
				channel_id: z
					.string()
					.min(1)
					.describe('Channel, private group or DM id. Find one with `slack_search_channels`.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(100)
					.optional()
					.describe('Number of messages to return, 1-100. Default 50.'),
				oldest: z
					.string()
					.optional()
					.describe('Start of the time range, Slack ts (e.g. "1234567890.123456").'),
				latest: z.string().optional().describe('End of the time range, Slack ts.'),
				cursor: z
					.string()
					.optional()
					.describe('`next_cursor` from a previous call, to page further back.'),
			},
		},
		async (args: {
			channel_id: string
			limit?: number
			oldest?: string
			latest?: string
			cursor?: string
		}) => {
			const res = await readConversation<{
				messages?: Record<string, unknown>[]
				has_more?: boolean
				response_metadata?: { next_cursor?: string }
			}>(ctx, 'conversations.history', {
				channel: args.channel_id,
				limit: args.limit ?? 50,
				oldest: args.oldest,
				latest: args.latest,
				cursor: args.cursor,
			})
			const messages = (res.messages ?? []).map((m) => ({
				ts: m.ts,
				user: m.user ?? m.bot_id,
				text: m.text,
				thread_ts: m.thread_ts,
				reply_count: m.reply_count,
				subtype: m.subtype,
			}))
			return ok({
				channel_id: args.channel_id,
				messages,
				has_more: res.has_more ?? false,
				next_cursor: res.response_metadata?.next_cursor || undefined,
			})
		},
	)

	registerTool(
		'slack_read_thread',
		{
			description:
				'Read one Slack thread — the parent message plus all replies. Requires the channel id and the parent message ts, both of which `slack_read_channel` returns. Read-only.',
			inputSchema: {
				channel_id: z.string().min(1).describe('Channel id the thread lives in.'),
				message_ts: z
					.string()
					.min(1)
					.describe('Timestamp of the PARENT message, e.g. "1234567890.123456".'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Replies to return. Default 100.'),
				cursor: z.string().optional().describe('`next_cursor` from a previous call.'),
			},
		},
		async (args: {
			channel_id: string
			message_ts: string
			limit?: number
			cursor?: string
		}) => {
			const res = await readConversation<{
				messages?: Record<string, unknown>[]
				has_more?: boolean
				response_metadata?: { next_cursor?: string }
			}>(ctx, 'conversations.replies', {
				channel: args.channel_id,
				ts: args.message_ts,
				limit: args.limit ?? 100,
				cursor: args.cursor,
			})
			const messages = (res.messages ?? []).map((m) => ({
				ts: m.ts,
				user: m.user ?? m.bot_id,
				text: m.text,
				thread_ts: m.thread_ts,
			}))
			return ok({
				channel_id: args.channel_id,
				parent_ts: args.message_ts,
				messages,
				has_more: res.has_more ?? false,
				next_cursor: res.response_metadata?.next_cursor || undefined,
			})
		},
	)

	registerTool(
		'slack_search_users',
		{
			description:
				'Find Slack users by name, handle or job title. Returns user ids, handles, real names and titles. Use `slack_read_user_profile` for full detail on a known id. Read-only.',
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe(
						'Case-insensitive substring matched against handle, real name and title. Omit to list everyone.',
					),
				include_bots: z.boolean().optional().describe('Include bot users. Default false.'),
				include_deleted: z
					.boolean()
					.optional()
					.describe('Include deactivated users. Default false.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Maximum users to return. Default 50.'),
			},
		},
		async (args: {
			query?: string
			include_bots?: boolean
			include_deleted?: boolean
			limit?: number
		}) => {
			const token = assertBotToken(ctx)
			const { items, truncated } = await slackPaginate<SlackUser>(
				token,
				'users.list',
				{ limit: LIST_PAGE_SIZE },
				(page) => (page.members as SlackUser[] | undefined) ?? [],
				MAX_USER_PAGES,
			)
			const needle = args.query?.trim().toLowerCase()
			const matched = items
				.filter((u) => (args.include_bots ? true : !u.is_bot))
				.filter((u) => (args.include_deleted ? true : !u.deleted))
				.filter((u) => {
					if (!needle) return true
					const profile = (u.profile ?? {}) as Record<string, unknown>
					return [u.name, u.real_name, profile.real_name, profile.title]
						.filter(Boolean)
						.some((field) => String(field).toLowerCase().includes(needle))
				})
			const limit = args.limit ?? 50
			const users = matched.slice(0, limit).map(summariseUser)
			return ok({
				users,
				total_matched: matched.length,
				...(truncated
					? {
							warning: `Only the first ${items.length} users were scanned (page cap reached), so this list may be incomplete.`,
						}
					: {}),
			})
		},
	)

	registerTool(
		'slack_read_user_profile',
		{
			description:
				"Get a Slack user's profile: handle, real name, title, timezone, status and whether they are a bot. Find an id with `slack_search_users`. Read-only.",
			inputSchema: {
				user_id: z.string().min(1).describe('Slack user id, e.g. `U0ABC12345`.'),
			},
		},
		async (args: { user_id: string }) => {
			const token = assertBotToken(ctx)
			const res = await slackApiCall<{
				user?: SlackUser & { tz?: string; tz_label?: string; is_admin?: boolean }
			}>(token, 'users.info', { user: args.user_id }, 'GET')
			if (!res.user) return ok({ user: null })
			const profile = (res.user.profile ?? {}) as Record<string, unknown>
			return ok({
				user: {
					...summariseUser(res.user),
					tz: res.user.tz,
					tz_label: res.user.tz_label,
					is_admin: res.user.is_admin ?? false,
					status_text: profile.status_text as string | undefined,
					status_emoji: profile.status_emoji as string | undefined,
				},
			})
		},
	)

	// ---------------------------------------------------------------- canvases

	registerTool(
		'slack_read_canvas',
		{
			description:
				'Read the markdown content of a Slack canvas by its file id (`F...`). Returns the canvas title and body. Read-only — use `slack_update_canvas` to change it.',
			inputSchema: {
				canvas_id: z.string().min(1).describe('Canvas file id, e.g. `F1234ABCD`.'),
			},
		},
		async (args: { canvas_id: string }) => {
			const token = assertBotToken(ctx)
			const info = await slackApiCall<{
				file?: { id: string; title?: string; url_private?: string; url_private_download?: string }
			}>(token, 'files.info', { file: args.canvas_id }, 'GET')
			const file = info.file
			const url = file?.url_private_download ?? file?.url_private
			if (!url) {
				return ok({
					canvas_id: args.canvas_id,
					title: file?.title,
					content: null,
					note: 'Slack returned no downloadable URL for this canvas.',
				})
			}
			const { text, truncated } = await downloadSlackText(url, token, MAX_CANVAS_CHARS)
			return ok({
				canvas_id: args.canvas_id,
				title: file?.title,
				content: text,
				...(truncated ? { warning: `Canvas truncated to ${MAX_CANVAS_CHARS} characters.` } : {}),
			})
		},
	)

	registerTool(
		'slack_create_canvas',
		{
			description:
				'Create a Slack canvas from markdown. Returns the new `canvas_id`, which `slack_read_canvas` and `slack_update_canvas` both take.',
			inputSchema: {
				title: z.string().optional().describe('Canvas title.'),
				markdown: z
					.string()
					.min(1)
					.describe(
						'Canvas body as markdown. Headings, lists, tables and code blocks are supported.',
					),
				channel_id: z
					.string()
					.optional()
					.describe('Channel to tab the canvas in. Required on free Slack plans.'),
			},
		},
		async (args: { title?: string; markdown: string; channel_id?: string }) => {
			const token = assertBotToken(ctx)
			const res = await slackApiCall<{ canvas_id?: string }>(
				token,
				'canvases.create',
				{
					title: args.title,
					channel_id: args.channel_id,
					document_content: { type: 'markdown', markdown: args.markdown },
				},
				'POST',
			)
			return ok({ ok: true, canvas_id: res.canvas_id, title: args.title })
		},
	)

	registerTool(
		'slack_update_canvas',
		{
			description:
				'Update a Slack canvas. Slack applies ONE operation per call: replace the whole document, append or prepend markdown, or rename it. Use `slack_read_canvas` first to see the current content.',
			inputSchema: {
				canvas_id: z.string().min(1).describe('Canvas file id, e.g. `F1234ABCD`.'),
				operation: z
					.enum(['replace', 'insert_at_start', 'insert_at_end', 'rename'])
					.describe(
						'`replace` overwrites the document, `insert_at_start`/`insert_at_end` prepend/append, `rename` sets the title.',
					),
				markdown: z
					.string()
					.optional()
					.describe('Markdown content. Required for every operation except `rename`.'),
				title: z
					.string()
					.optional()
					.describe('New title. Required for `rename`, ignored otherwise.'),
			},
		},
		async (args: {
			canvas_id: string
			operation: 'replace' | 'insert_at_start' | 'insert_at_end' | 'rename'
			markdown?: string
			title?: string
		}) => {
			const token = assertBotToken(ctx)
			if (args.operation === 'rename' && !args.title?.trim()) {
				throw new SlackApiError('invalid_arguments', 'The `rename` operation requires `title`.')
			}
			if (args.operation !== 'rename' && !args.markdown?.trim()) {
				throw new SlackApiError(
					'invalid_arguments',
					`The \`${args.operation}\` operation requires \`markdown\`.`,
				)
			}
			const change =
				args.operation === 'rename'
					? { operation: 'rename', title_content: { type: 'markdown', markdown: args.title } }
					: {
							operation: args.operation,
							document_content: { type: 'markdown', markdown: args.markdown },
						}
			await slackApiCall(
				token,
				'canvases.edit',
				{ canvas_id: args.canvas_id, changes: [change] },
				'POST',
			)
			return ok({ ok: true, canvas_id: args.canvas_id, operation: args.operation })
		},
	)

	// ------------------------------------------------- search (user token only)

	// `search.messages` has no bot-scope equivalent — Slack offers `search:read`
	// only as a user scope. Registered conditionally so a workspace whose install
	// predates the user-token grant simply does not see this tool, rather than
	// seeing a tool that always fails.
	//
	// There is exactly ONE search tool on purpose. `search.messages` takes no
	// channel-scoping parameter: its reach is fixed by the user token's granted
	// `search:read.*` scopes, which the install requests as the full set
	// (public, private, mpim, im — see config.ts). A `slack_search_public` that
	// merely *labelled* its results `public_channel` while issuing the identical
	// unconstrained request would be worse than no tool at all — an agent picks
	// the narrow-sounding name precisely to stay out of private conversations,
	// and would be handed DM content under an assurance the request never made.
	// If Slack ever adds real channel-type scoping, split this then.
	if (ctx.userToken) {
		const userToken = ctx.userToken
		registerTool(
			'slack_search_messages',
			{
				description:
					'Search message content across ALL Slack conversations the installing user can see — public channels, and also their private channels, group DMs and DMs. There is no way to narrow this to public channels only: Slack scopes search by the searching identity, not per call. Treat every result as potentially confidential, and do not repost an excerpt into a channel without checking where it came from. Supports Slack\'s search modifiers: `in:#channel`, `from:@user`, `before:YYYY-MM-DD`, `after:YYYY-MM-DD`, `has:link`, `is:thread`, `"exact phrase"`, `-excluded` — use `in:#channel` to constrain the surface yourself. Space-separated terms are ANDed; there are no boolean operators. Runs with the Slack visibility of the person who installed Maskin, not of the calling agent. Read-only.',
				inputSchema: {
					query: z
						.string()
						.min(1)
						.describe('Search query, optionally with Slack search modifiers.'),
					count: z
						.number()
						.int()
						.min(1)
						.max(100)
						.optional()
						.describe('Results per page, 1-100. Default 20.'),
					page: z.number().int().min(1).optional().describe('Page number, 1-based. Default 1.'),
					sort: z.enum(['score', 'timestamp']).optional().describe('Sort by relevance or date.'),
					sort_dir: z.enum(['asc', 'desc']).optional().describe('Sort direction. Default desc.'),
				},
			},
			async (args: {
				query: string
				count?: number
				page?: number
				sort?: string
				sort_dir?: string
			}) => {
				const res = await slackApiCall<{
					messages?: {
						total?: number
						matches?: Record<string, unknown>[]
						paging?: Record<string, unknown>
					}
				}>(
					userToken,
					'search.messages',
					{
						query: args.query,
						count: args.count ?? 20,
						page: args.page ?? 1,
						sort: args.sort,
						sort_dir: args.sort_dir,
					},
					'GET',
				)
				const matches = (res.messages?.matches ?? []).map((m) => {
					const channel = m.channel as
						| {
								id?: string
								name?: string
								is_private?: boolean
								is_im?: boolean
								is_mpim?: boolean
						  }
						| undefined
					return {
						ts: m.ts,
						text: m.text,
						username: m.username,
						user: m.user,
						channel: channel?.id,
						channel_name: channel?.name,
						// Per-match, from Slack's own metadata — so the agent can tell a
						// public-channel hit from a private one instead of trusting a
						// blanket claim about the whole result set.
						//
						// OR, not `??`: Slack sets `is_private: false` on DMs and group
						// DMs, where privacy is carried by `is_im` / `is_mpim` instead. A
						// `??` chain short-circuits on that `false` and reports a DM hit
						// as public — the one thing this field exists to prevent. Stays
						// `undefined` only when the match carries no channel object at
						// all, so "unknown" remains distinguishable from "public".
						is_private:
							channel === undefined
								? undefined
								: Boolean(channel.is_private || channel.is_im || channel.is_mpim),
						permalink: m.permalink,
					}
				})
				return ok({
					query: args.query,
					total: res.messages?.total ?? matches.length,
					matches,
					paging: res.messages?.paging,
				})
			},
		)
	}

	return server
}
