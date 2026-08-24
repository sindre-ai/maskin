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
		const message = err instanceof Error ? err.message : String(err)
		if (message.includes('missing_scope')) {
			throw new Error(
				`${message} — this Slack install predates the scope. Reconnect Slack from Settings → Integrations to re-consent.`,
			)
		}
		throw err
	}
}

/**
 * Turn `#general`, `general`, or `C0123456789` into a channel ID.
 *
 * `chat.postMessage` accepts `#name` directly, but `conversations.join`,
 * `reactions.add` and `chat.getPermalink` all require an ID — so agents would
 * otherwise have to hand-copy one out of the Slack UI, which is the exact
 * friction these tools exist to remove.
 */
async function resolveChannelId(ctx: SlackPostContext, ref: string): Promise<string> {
	const trimmed = ref.trim()
	if (!trimmed) throw new Error('Channel reference is empty')
	if (CHANNEL_ID_RE.test(trimmed)) return trimmed

	const name = trimmed.replace(/^#/, '').toLowerCase()
	const conversations = await withScopeHint(() =>
		listSlackConversations(ctx.integrationId, ctx.botToken, ['public_channel', 'private_channel']),
	)
	const match = conversations.find((c) => c.name.toLowerCase() === name)
	if (!match) {
		throw new Error(
			`No channel named #${name} is visible to this Slack app. Call slack_list_channels to see what is available — private channels only appear once the bot has been invited to them.`,
		)
	}
	return match.id
}

/**
 * Build a fresh MCP server per request. Identity (`agentLabel`, `iconUrl`) and
 * the integration (`botToken`, `integrationId`) are bound at server-construction
 * time so a single connection can't be reused across workspaces by mistake.
 *
 * Tools fall into three groups:
 *   - write:      `slack_send_message`, `slack_add_reaction`
 *   - discovery:  `slack_list_channels`, `slack_list_users`, `slack_get_permalink`
 *   - membership: `slack_join_channel`
 *
 * There is deliberately no history/backlog tool. `channels:history`,
 * `groups:history` and `mpim:history` are excluded from the provider's scopes
 * on purpose (see config.ts) — the bot sees what it is @mentioned in, not the
 * full backlog of every channel it lives in. Adding a read-history tool means
 * adding those scopes AND re-submitting the Marketplace listing, never one
 * without the other.
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
				// a retried tool call doesn't read as a broken integration.
				const message = err instanceof Error ? err.message : String(err)
				if (!message.includes('already_reacted')) throw err
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

	return server
}
