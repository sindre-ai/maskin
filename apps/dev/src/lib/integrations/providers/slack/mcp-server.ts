import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { capturePosthogEvent } from '../../../analytics/posthog'
import { logger } from '../../../logger'
import {
	type SlackConversation,
	type SlackConversationType,
	listSlackConversations,
	listSlackUsers,
	slackGet,
	slackPost,
} from './client'
import { SlackApiError } from './slack-api'

const SLACK_API_BASE = 'https://slack.com/api'
const REQUEST_TIMEOUT_MS = 10_000

export interface SlackPostContext {
	/**
	 * Bot token (`xoxb-...`) used to call chat.postMessage. Resolution is
	 * caller-owned so the route can look it up per-request from the active
	 * workspace integration.
	 */
	botToken: string
	/**
	 * Row id of the workspace's Slack integration. Used as the cache key for
	 * the `conversations.list` / `users.list` lookups shared with the REST
	 * routes, so an agent listing channels reuses the same 5-minute cache the
	 * trigger-filter UI already warms.
	 */
	integrationId: string
	/**
	 * Subscript shown next to the bot — combines the calling agent's name
	 * with the workspace name, e.g. `Synthesizer · in mesh-firm`.
	 */
	agentLabel: string
	/** PNG URL for the shared Maskin avatar; omitted when unset. */
	iconUrl?: string
	/** For logs only — tells us which workspace the post came from. */
	workspaceId: string
	/** For logs only — tells us which actor in that workspace sent it. */
	actorId: string
	/**
	 * Slack `team_id` for the workspace integration — drives the bet's ship
	 * metric breakdown by Slack workspace. Sourced from `integration.externalId`,
	 * which is populated by `parseTokenResponse` / `resolveExternalId` on the
	 * provider config. Undefined when an older integration row predates that
	 * stash and `resolveExternalId` hasn't backfilled yet.
	 */
	slackTeamId?: string
}

interface SlackPostMessageResponse {
	ok: boolean
	ts?: string
	channel?: string
	error?: string
}

/**
 * Refuse to talk to Slack with anything other than a workspace bot token.
 *
 * Slack's `chat:write.customize` scope only honours `username` + `icon_url`
 * on `chat.postMessage` when the token is the bot token; user tokens
 * (`xoxp-`) silently fall back to posting as the human owner — the exact
 * bug this bet is closing. We check at both the session-manager injection
 * site and here so an out-of-band stored credential can't bypass the guard.
 */
export function isSlackBotToken(token: string | undefined | null): boolean {
	return typeof token === 'string' && token.startsWith('xoxb-')
}

/**
 * Guard every tool, not just the posting one. A user (`xoxp-`) token would make
 * `conversations.join` and `reactions.add` act as the human who installed the
 * app rather than as Maskin — the same impersonation this bet closed for
 * `chat.postMessage` — and would scope `conversations.list` to that person's
 * channels instead of the bot's.
 */
function assertBotToken(ctx: SlackPostContext): void {
	if (!isSlackBotToken(ctx.botToken)) {
		throw new Error(
			'Slack integration is misconfigured: stored access token is not a bot token (expected xoxb- prefix). Reconnect Slack to grant bot scopes.',
		)
	}
}

async function slackPostMessage(
	ctx: SlackPostContext,
	args: { channel: string; text: string; thread_ts?: string },
): Promise<SlackPostMessageResponse> {
	assertBotToken(ctx)

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

	let res: Response
	try {
		res = await fetch(`${SLACK_API_BASE}/chat.postMessage`, {
			method: 'POST',
			headers: {
				Authorization: `Bearer ${ctx.botToken}`,
				'Content-Type': 'application/json; charset=utf-8',
			},
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		})
	} catch (err) {
		if (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
			throw new Error(`Slack chat.postMessage timed out after ${REQUEST_TIMEOUT_MS}ms`)
		}
		throw err
	}

	if (!res.ok) {
		// Slack's edge can return 5xx/4xx with an HTML body (e.g. a CDN error page);
		// calling res.json() there throws `SyntaxError: Unexpected token <` and masks
		// the real status, so the agent and ops can't tell 429 from 503. Surface the
		// HTTP status with a short body snippet for context.
		let bodySnippet = ''
		try {
			bodySnippet = (await res.text()).slice(0, 200)
		} catch {
			// ignore — the status alone is the useful signal
		}
		throw new Error(
			`Slack chat.postMessage HTTP ${res.status}${bodySnippet ? `: ${bodySnippet}` : ''}`,
		)
	}

	const json = (await res.json()) as SlackPostMessageResponse
	if (!json.ok) {
		throw new Error(`Slack chat.postMessage failed: ${json.error ?? 'unknown error'}`)
	}
	return json
}

const sendMessageInput = {
	channel: z
		.string()
		.min(1)
		.describe(
			'Slack channel or DM ID (e.g. `C0123456789`) or `#channel-name`. The bot must be a member.',
		),
	text: z
		.string()
		.min(1)
		.describe(
			'Message text. Slack mrkdwn is supported. The post will be attributed to the calling agent — username and avatar are set server-side, do not include them here.',
		),
	thread_ts: z.string().optional().describe('Reply in a thread by passing the parent message ts.'),
}

// ── Shared helpers for the lookup / membership tools ───────────────────────

/**
 * Slack conversation IDs: `C` public + private channels, `D` DMs, `G` legacy
 * private groups. Anything else is treated as a human-typed name to resolve.
 */
const CHANNEL_ID_RE = /^[CDG][A-Z0-9]{6,}$/

/** Slack emoji shortcodes, with the optional skin-tone suffix. */
const EMOJI_RE = /^[a-z0-9_+'-]+(::skin-tone-[2-6])?$/i

const CONVERSATION_TYPES = ['public_channel', 'private_channel', 'im', 'mpim'] as const

function jsonResult(value: unknown) {
	return { content: [{ type: 'text' as const, text: JSON.stringify(value) }] }
}

function conversationKind(c: SlackConversation): 'public' | 'private' | 'im' | 'mpim' {
	if (c.is_im) return 'im'
	if (c.is_mpim) return 'mpim'
	return c.is_private ? 'private' : 'public'
}

/**
 * Every scope these tools need is already in the provider's `scopes` array, so
 * a `missing_scope` here means the workspace connected Slack before the scope
 * was added and is still running on the older grant. Say so, rather than
 * leaving the agent to guess at a raw Slack error code.
 */
async function withScopeHint<T>(op: () => Promise<T>): Promise<T> {
	try {
		return await op()
	} catch (err) {
		if (err instanceof SlackApiError && err.code === 'missing_scope') {
			throw new Error(
				`${err.message} — this Slack install predates the scope. Reconnect Slack from Settings → Integrations to re-consent.`,
			)
		}
		throw err
	}
}

/**
 * Turn `#general`, `general`, `mpdm-alice--bob--1`, or `C0123456789` into a
 * channel ID.
 *
 * Public + private channels are the common case; the DM/MPIM fallback exists
 * so the read-history tools can resolve MPIMs referenced by their `mpdm-…`
 * name. True 1:1 DMs have no name and must be referenced by their D-prefixed
 * ID directly (which the regex above passes straight through).
 */
async function resolveChannelId(ctx: SlackPostContext, ref: string): Promise<string> {
	const trimmed = ref.trim()
	if (!trimmed) throw new Error('Channel reference is empty')
	if (CHANNEL_ID_RE.test(trimmed)) return trimmed

	const name = trimmed.replace(/^#/, '').toLowerCase()
	const channels = await withScopeHint(() =>
		listSlackConversations(ctx.integrationId, ctx.botToken, ['public_channel', 'private_channel']),
	)
	let match = channels.find((c) => c.name.toLowerCase() === name)
	if (!match) {
		const dms = await withScopeHint(() =>
			listSlackConversations(ctx.integrationId, ctx.botToken, ['im', 'mpim']),
		)
		match = dms.find((c) => c.name.toLowerCase() === name)
	}
	if (!match) {
		throw new Error(
			`No channel named #${name} is visible to this Slack app. Call slack_list_channels to see what is available — private channels only appear once the bot has been invited to them.`,
		)
	}
	return match.id
}

// ── Read-history + fold-in tool internals ──────────────────────────────────

interface RawSlackMessage {
	ts: string
	user?: string
	text?: string
	thread_ts?: string
	reply_count?: number
	latest_reply?: string
	subtype?: string
	bot_id?: string
}

interface HistoryResponse {
	ok: boolean
	messages?: RawSlackMessage[]
	has_more?: boolean
	response_metadata?: { next_cursor?: string }
}

interface OpenConversationResponse {
	ok: boolean
	channel?: { id?: string; is_open?: boolean }
	no_op?: boolean
	already_open?: boolean
}

interface ChannelInfoResponse {
	ok: boolean
	channel?: {
		id?: string
		name?: string
		is_channel?: boolean
		is_group?: boolean
		is_im?: boolean
		is_mpim?: boolean
		is_private?: boolean
		is_archived?: boolean
		is_member?: boolean
		num_members?: number
		created?: number
		topic?: { value?: string }
		purpose?: { value?: string }
	}
}

function mapHistoryMessage(
	m: RawSlackMessage,
	includeReplyCounts: boolean,
): Record<string, unknown> {
	const out: Record<string, unknown> = {
		ts: m.ts,
		user: m.user ?? null,
		text: m.text ?? '',
	}
	if (m.thread_ts) out.thread_ts = m.thread_ts
	if (includeReplyCounts && typeof m.reply_count === 'number') {
		out.reply_count = m.reply_count
		if (m.latest_reply) out.latest_reply = m.latest_reply
	}
	if (m.subtype) out.subtype = m.subtype
	if (m.bot_id) out.bot_id = m.bot_id
	return out
}

/**
 * Rewrite Slack's `not_in_channel` into the actionable "join first" hint used
 * by every tool that reads or writes into a channel the bot might not be in.
 * Anything else is re-thrown unchanged.
 */
function rewriteNotInChannel(err: unknown, channelRef: string): Error {
	const message = err instanceof Error ? err.message : String(err)
	if (message.includes('not_in_channel')) {
		const name = channelRef.trim().replace(/^#/, '')
		return new Error(
			`The bot is not a member of #${name}. Call slack_join_channel first, then retry.`,
		)
	}
	return err instanceof Error ? err : new Error(message)
}

/**
 * Build a fresh MCP server per request. Identity (`agentLabel`, `iconUrl`) and
 * the integration (`botToken`, `integrationId`) are bound at server-construction
 * time so a single connection can't be reused across workspaces by mistake.
 *
 * Tools fall into four groups:
 *   - write:        `slack_send_message`, `slack_add_reaction`,
 *                   `slack_update_message`, `slack_delete_message`
 *   - discovery:    `slack_list_channels`, `slack_list_users`,
 *                   `slack_get_permalink`, `slack_conversations_info`
 *   - membership:   `slack_join_channel`, `slack_open_conversation`
 *   - read-history: `slack_get_channel_history`, `slack_get_thread_replies`
 *
 * The read-history pair returns a bounded `HistoryMessage` shape (no
 * `blocks`/`attachments`/`files`/`reactions`/`edited`) and surfaces
 * `truncated` + `next_cursor` so pagination is agent-driven rather than
 * consumed inside the tool. `slack_update_message` and `slack_delete_message`
 * can only modify the bot's own posts — Slack enforces server-side and we
 * rewrite `cant_update_message` / `cant_delete_message` into an actionable
 * hint.
 */
export function createSlackMcpServer(ctx: SlackPostContext): McpServer {
	const server = new McpServer({ name: 'maskin-slack', version: '0.1.0' })

	server.registerTool(
		'slack_send_message',
		{
			description:
				'Post a message to Slack as Maskin. The calling agent\'s name and the workspace name are appended automatically as the `username` subscript (e.g. "Synthesizer · in mesh-firm") — do not prefix the message text with your own identity.',
			inputSchema: sendMessageInput,
		},
		async (args) => {
			const result = await slackPostMessage(ctx, args)
			logger.info('Slack chat.postMessage succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: result.channel ?? args.channel,
				ts: result.ts,
				agentLabel: ctx.agentLabel,
			})
			// Drives the bet's ≥80% ship metric — we only get here on a 2xx +
			// `ok: true` Slack response, so a successful send maps 1:1 to an event.
			void capturePosthogEvent('slack.message.posted', ctx.workspaceId, {
				workspace_id: ctx.workspaceId,
				slack_team_id: ctx.slackTeamId ?? null,
				posted_as_machine: isSlackBotToken(ctx.botToken),
				has_agent_subscript: Boolean(ctx.agentLabel?.trim()),
				agent_actor_id: ctx.actorId,
			})
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({
							ok: true,
							ts: result.ts,
							channel: result.channel ?? args.channel,
						}),
					},
				],
			}
		},
	)

	server.registerTool(
		'slack_list_channels',
		{
			description:
				"List the Slack channels this app can see, so you never have to ask a human to copy a channel ID out of the Slack UI. Returns each channel's ID, name, kind and whether the bot is already a member — `is_member: false` on a public channel means you must call slack_join_channel before slack_send_message will succeed. Results are workspace-wide for public channels; private channels appear only after the bot has been invited.",
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe('Case-insensitive substring to match against the channel name.'),
				types: z
					.array(z.enum(CONVERSATION_TYPES))
					.optional()
					.describe(
						'Conversation types to include. Defaults to public_channel + private_channel; add im/mpim to include DMs and group DMs.',
					),
				only_member: z
					.boolean()
					.optional()
					.describe('When true, return only conversations the bot has already joined.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Maximum channels to return (default 50, max 200).'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const types = (args.types ?? ['public_channel', 'private_channel']) as SlackConversationType[]
			const limit = args.limit ?? 50
			const all = await withScopeHint(() =>
				listSlackConversations(ctx.integrationId, ctx.botToken, types),
			)

			const needle = args.query?.trim().replace(/^#/, '').toLowerCase()
			const matched = all.filter((c) => {
				if (args.only_member && !c.is_member) return false
				if (needle && !c.name.toLowerCase().includes(needle)) return false
				return true
			})
			const channels = matched.slice(0, limit).map((c) => ({
				id: c.id,
				name: c.name,
				kind: conversationKind(c),
				is_member: c.is_member,
			}))

			return jsonResult({
				matched: matched.length,
				returned: channels.length,
				// Never let a cap read as "this is everything" — say so explicitly.
				truncated: matched.length > channels.length,
				channels,
			})
		},
	)

	server.registerTool(
		'slack_list_users',
		{
			description:
				'List the people in the connected Slack workspace. Use this to turn a name into the `U…` ID needed to mention someone — a mention only notifies when written as `<@U0123456789>` in the message text; typing `@alice` is inert plain text.',
			inputSchema: {
				query: z
					.string()
					.optional()
					.describe('Case-insensitive substring matched against username and real name.'),
				include_bots: z
					.boolean()
					.optional()
					.describe('Include bot users in the results (default false).'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Maximum users to return (default 50, max 200).'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const limit = args.limit ?? 50
			const all = await withScopeHint(() => listSlackUsers(ctx.integrationId, ctx.botToken))

			const needle = args.query?.trim().replace(/^@/, '').toLowerCase()
			const matched = all.filter((u) => {
				if (!args.include_bots && u.is_bot) return false
				if (!needle) return true
				return u.name.toLowerCase().includes(needle) || u.real_name.toLowerCase().includes(needle)
			})
			const users = matched.slice(0, limit).map((u) => ({
				id: u.id,
				name: u.name,
				real_name: u.real_name,
				is_bot: u.is_bot,
				mention: `<@${u.id}>`,
			}))

			return jsonResult({
				matched: matched.length,
				returned: users.length,
				truncated: matched.length > users.length,
				users,
			})
		},
	)

	server.registerTool(
		'slack_join_channel',
		{
			description:
				'Join a public Slack channel so the bot can post in it. Idempotent — joining a channel the bot is already in succeeds. Private channels cannot be joined this way: a human has to invite the app with `/invite @Maskin`.',
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe('Channel ID (`C0123456789`) or name (`#general` / `general`).'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			await withScopeHint(() =>
				slackPost('conversations.join', ctx.botToken, { channel: channelId }),
			)
			logger.info('Slack conversations.join succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: channelId,
			})
			return jsonResult({ ok: true, channel: channelId })
		},
	)

	server.registerTool(
		'slack_add_reaction',
		{
			description:
				'Add an emoji reaction to a Slack message — the low-noise way to acknowledge a request (👀 on pick-up, ✅ on completion) without posting another message into the channel.',
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe('Channel ID (`C0123456789`) or name (`#general` / `general`).'),
				timestamp: z
					.string()
					.min(1)
					.describe('The `ts` of the target message, e.g. `1717000000.000100`.'),
				emoji: z
					.string()
					.min(1)
					.describe('Emoji shortcode without colons, e.g. `eyes` or `white_check_mark`.'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const emoji = args.emoji.trim().replace(/^:|:$/g, '')
			if (!EMOJI_RE.test(emoji)) {
				throw new Error(
					`Invalid emoji shortcode: ${args.emoji}. Pass the name without colons, e.g. "eyes".`,
				)
			}
			const channelId = await resolveChannelId(ctx, args.channel)
			try {
				await withScopeHint(() =>
					slackPost('reactions.add', ctx.botToken, {
						channel: channelId,
						timestamp: args.timestamp,
						name: emoji,
					}),
				)
			} catch (err) {
				// Reacting twice is a no-op, not a failure — report it as success so
				// a retried tool call doesn't read as a broken integration. Keyed on
				// Slack's parsed `error` code: a substring match on the message would
				// report success if that token ever appeared in an unrelated error.
				if (!(err instanceof SlackApiError) || err.code !== 'already_reacted') throw err
				return jsonResult({ ok: true, channel: channelId, emoji, already_reacted: true })
			}
			return jsonResult({ ok: true, channel: channelId, emoji, already_reacted: false })
		},
	)

	server.registerTool(
		'slack_get_permalink',
		{
			description:
				'Get the permanent URL for a Slack message. Use it when citing a Slack conversation from a Maskin object, so the link survives and points back at the original thread.',
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe('Channel ID (`C0123456789`) or name (`#general` / `general`).'),
				message_ts: z
					.string()
					.min(1)
					.describe('The `ts` of the target message, e.g. `1717000000.000100`.'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			const json = await withScopeHint(() =>
				slackGet<{ ok: boolean; permalink?: string }>('chat.getPermalink', ctx.botToken, {
					channel: channelId,
					message_ts: args.message_ts,
				}),
			)
			return jsonResult({ ok: true, channel: channelId, permalink: json.permalink })
		},
	)

	server.registerTool(
		'slack_get_channel_history',
		{
			description:
				'Read recent messages from a Slack channel, DM, or MPIM the bot can see. Bounded, member-only, agent-driven pagination — `truncated` and `next_cursor` are surfaced but not auto-followed, so agents can decide whether to page further without blowing the tool-call context. Returns a minimal message shape (ts, user, text, and — when include_thread_reply_counts is true — thread reply counts so you can decide whether a follow-up `slack_get_thread_replies` is warranted).',
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe(
						'Channel ID (`C0123456789`) or name (`#general` / `general`). For DMs, pass the D-prefixed conversation ID from `slack_list_channels` with types=["im"].',
					),
				oldest: z
					.string()
					.optional()
					.describe(
						'Slack timestamp (e.g. `1717000000.000100`) to start FROM (exclusive). Omit to fetch newest-first from now.',
					),
				latest: z
					.string()
					.optional()
					.describe('Slack timestamp to end AT (exclusive). Omit for now.'),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe(
						'Max messages to return. Default 50, max 200. Server enforces a single-page cap; the tool sets `truncated: true` in the response if `has_more` came back from Slack.',
					),
				include_thread_reply_counts: z
					.boolean()
					.optional()
					.describe(
						'Default true. When true, `reply_count` and `latest_reply` are included per message so agents know which parents warrant a follow-up `slack_get_thread_replies` call.',
					),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			const includeReplyCounts = args.include_thread_reply_counts ?? true
			const params: Record<string, string> = {
				channel: channelId,
				limit: String(args.limit ?? 50),
				inclusive: 'false',
			}
			if (args.oldest) params.oldest = args.oldest
			if (args.latest) params.latest = args.latest

			let json: HistoryResponse
			try {
				json = await withScopeHint(() =>
					slackGet<HistoryResponse>('conversations.history', ctx.botToken, params),
				)
			} catch (err) {
				throw rewriteNotInChannel(err, args.channel)
			}

			const raw = json.messages ?? []
			const messages = raw.map((m) => mapHistoryMessage(m, includeReplyCounts))
			logger.info('Slack conversations.history succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: channelId,
				returned: messages.length,
				truncated: Boolean(json.has_more),
			})
			return jsonResult({
				matched: raw.length,
				returned: messages.length,
				truncated: Boolean(json.has_more),
				next_cursor: json.response_metadata?.next_cursor ?? null,
				messages,
			})
		},
	)

	server.registerTool(
		'slack_get_thread_replies',
		{
			description:
				'Read the replies to a Slack thread. Returns the parent message flagged `is_parent: true` followed by replies in oldest-first order (Slack default). Uses the same minimal message shape as `slack_get_channel_history` and surfaces `truncated` / `next_cursor` for agent-driven pagination.',
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe(
						'Channel ID (`C0123456789`) or name. Same resolution as slack_get_channel_history.',
					),
				thread_ts: z
					.string()
					.min(1)
					.describe(
						"The `ts` of the thread parent message. This is the `thread_ts` field returned by slack_get_channel_history — NOT a reply's own `ts`.",
					),
				limit: z
					.number()
					.int()
					.min(1)
					.max(200)
					.optional()
					.describe('Max replies to return. Default 50, max 200.'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			const params: Record<string, string> = {
				channel: channelId,
				ts: args.thread_ts,
				limit: String(args.limit ?? 50),
			}
			let json: HistoryResponse
			try {
				json = await withScopeHint(() =>
					slackGet<HistoryResponse>('conversations.replies', ctx.botToken, params),
				)
			} catch (err) {
				throw rewriteNotInChannel(err, args.channel)
			}
			const raw = json.messages ?? []
			const messages = raw.map((m, i) => {
				const mapped = mapHistoryMessage(m, true)
				if (i === 0) mapped.is_parent = true
				return mapped
			})
			logger.info('Slack conversations.replies succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: channelId,
				thread_ts: args.thread_ts,
				returned: messages.length,
				truncated: Boolean(json.has_more),
			})
			return jsonResult({
				matched: raw.length,
				returned: messages.length,
				truncated: Boolean(json.has_more),
				next_cursor: json.response_metadata?.next_cursor ?? null,
				messages,
			})
		},
	)

	server.registerTool(
		'slack_update_message',
		{
			description:
				"Replace the text of a Slack message the bot previously posted. Slack replaces content in full (not a diff) — pass the complete new text. The bot can only edit its OWN messages: `cant_update_message` is returned if the target wasn't posted by this bot token.",
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe('Channel ID (`C0123456789`) or name. Same resolution as slack_send_message.'),
				ts: z
					.string()
					.min(1)
					.describe(
						'The `ts` of the message to update. Returned by slack_send_message (or by slack_get_channel_history for a prior bot-authored message).',
					),
				text: z
					.string()
					.min(1)
					.max(40000)
					.describe(
						'Replacement message text. Same 40k Slack cap as slack_send_message. Slack replaces the message content in full — pass the complete new text, not a diff.',
					),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			try {
				await withScopeHint(() =>
					slackPost('chat.update', ctx.botToken, {
						channel: channelId,
						ts: args.ts,
						text: args.text,
					}),
				)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				if (message.includes('cant_update_message')) {
					const name = args.channel.trim().replace(/^#/, '')
					throw new Error(
						`Cannot update message ${args.ts} in #${name}: it was not posted by the Maskin bot. slack_update_message can only edit the bot's own messages.`,
					)
				}
				throw rewriteNotInChannel(err, args.channel)
			}
			logger.info('Slack chat.update succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: channelId,
				ts: args.ts,
			})
			return jsonResult({ channel: channelId, ts: args.ts, updated: true })
		},
	)

	server.registerTool(
		'slack_delete_message',
		{
			description:
				"Delete a Slack message the bot previously posted. Permanent — no undo. The bot can only delete its OWN messages: `cant_delete_message` is returned if the target wasn't posted by this bot token. Enterprise workspaces with compliance exports may disallow deletes entirely.",
			inputSchema: {
				channel: z.string().min(1).describe('Channel ID or name.'),
				ts: z
					.string()
					.min(1)
					.describe('The `ts` of the message to delete. Bot can only delete its own messages.'),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			try {
				await withScopeHint(() =>
					slackPost('chat.delete', ctx.botToken, {
						channel: channelId,
						ts: args.ts,
					}),
				)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				if (message.includes('cant_delete_message')) {
					const name = args.channel.trim().replace(/^#/, '')
					throw new Error(
						`Cannot delete message ${args.ts} in #${name}: it was not posted by the Maskin bot. slack_delete_message can only remove the bot's own messages.`,
					)
				}
				throw rewriteNotInChannel(err, args.channel)
			}
			logger.info('Slack chat.delete succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				channel: channelId,
				ts: args.ts,
			})
			return jsonResult({ channel: channelId, ts: args.ts, deleted: true })
		},
	)

	server.registerTool(
		'slack_open_conversation',
		{
			description:
				'Open a 1:1 DM (1 user) or group DM (2-8 users) with people in the workspace. Idempotent: reopening an existing conversation returns the same channel id with `is_new: false`. Group DMs (>1 users) require the `mpim:write` scope — if that scope is not granted for this install, the call will surface via `withScopeHint` as a reconnect instruction.',
			inputSchema: {
				users: z
					.array(z.string().min(1))
					.min(1)
					.max(8)
					.describe(
						'Slack user IDs (`U0123456789`) to open the conversation with. 1 user = 1:1 DM; 2-8 users = group DM. Find ids via `slack_list_users`.',
					),
				return_im: z
					.boolean()
					.optional()
					.describe(
						'Default true. When true, returns the full DM channel object; when false, only the channel id. Mirrors the Slack API knob.',
					),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const usersParam = args.users.join(',')
			let json: OpenConversationResponse
			try {
				json = await withScopeHint(() =>
					slackPost<OpenConversationResponse>('conversations.open', ctx.botToken, {
						users: usersParam,
						return_im: args.return_im ?? true,
					}),
				)
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				if (message.includes('user_not_found')) {
					throw new Error(
						`Slack could not resolve one of the users in [${args.users.join(', ')}] — resolve via slack_list_users and retry.`,
					)
				}
				throw err
			}
			const channelId = json.channel?.id ?? ''
			const isNew = !json.no_op
			logger.info('Slack conversations.open succeeded', {
				workspaceId: ctx.workspaceId,
				actorId: ctx.actorId,
				users: args.users,
				channel: channelId,
				is_new: isNew,
			})
			return jsonResult({ channel_id: channelId, is_new: isNew, users: args.users })
		},
	)

	server.registerTool(
		'slack_conversations_info',
		{
			description:
				"Read a Slack conversation's metadata — id, name, kind, topic, purpose, membership, and (optionally) member count. Bounded shape: enterprise-shared / previous-names / pending-shared fields and topic/purpose creator metadata are intentionally not exposed.",
			inputSchema: {
				channel: z
					.string()
					.min(1)
					.describe('Channel ID or name. Same resolution as slack_get_channel_history.'),
				include_num_members: z
					.boolean()
					.optional()
					.describe(
						'Default false. When true, includes `num_members`. Adds a small Slack-side cost — omit if the agent only needs topic/purpose.',
					),
			},
		},
		async (args) => {
			assertBotToken(ctx)
			const channelId = await resolveChannelId(ctx, args.channel)
			const params: Record<string, string> = {
				channel: channelId,
				include_num_members: args.include_num_members ? 'true' : 'false',
			}
			const json = await withScopeHint(() =>
				slackGet<ChannelInfoResponse>('conversations.info', ctx.botToken, params),
			)
			const c = json.channel ?? {}
			const info: Record<string, unknown> = {
				id: c.id ?? channelId,
				name: c.name ?? null,
				is_channel: Boolean(c.is_channel),
				is_group: Boolean(c.is_group),
				is_im: Boolean(c.is_im),
				is_mpim: Boolean(c.is_mpim),
				is_private: Boolean(c.is_private),
				is_archived: Boolean(c.is_archived),
				is_member: Boolean(c.is_im) || Boolean(c.is_mpim) || Boolean(c.is_member),
				topic: c.topic?.value ?? null,
				purpose: c.purpose?.value ?? null,
				created: c.created ?? null,
			}
			if (args.include_num_members && typeof c.num_members === 'number') {
				info.num_members = c.num_members
			}
			return jsonResult({ channel: info })
		},
	)

	return server
}
