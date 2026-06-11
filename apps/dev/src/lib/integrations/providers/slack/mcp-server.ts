import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { logger } from '../../../logger'

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
	 * Subscript shown next to the bot — combines the calling agent's name
	 * with the workspace name, e.g. `Synthesizer · in mesh-firm`.
	 */
	agentLabel: string
	/** PNG URL for the shared Machine avatar; omitted when unset. */
	machineIconUrl?: string
	/** For logs only — tells us which workspace the post came from. */
	workspaceId: string
	/** For logs only — tells us which actor in that workspace sent it. */
	actorId: string
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

async function slackPostMessage(
	ctx: SlackPostContext,
	args: { channel: string; text: string; thread_ts?: string },
): Promise<SlackPostMessageResponse> {
	if (!isSlackBotToken(ctx.botToken)) {
		throw new Error(
			'Slack integration is misconfigured: stored access token is not a bot token (expected xoxb- prefix). Reconnect Slack to grant bot scopes.',
		)
	}

	const body: Record<string, unknown> = {
		channel: args.channel,
		text: args.text,
		username: ctx.agentLabel,
	}
	if (ctx.machineIconUrl) body.icon_url = ctx.machineIconUrl
	if (args.thread_ts) body.thread_ts = args.thread_ts

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

/**
 * Build a fresh MCP server per request. The server exposes one tool —
 * `slack_send_message` — that posts to Slack as Machine with the calling
 * agent's subscript. Identity (`agentLabel`, `machineIconUrl`) is bound at
 * server-construction time so a single connection can't be reused across
 * workspaces by mistake.
 */
export function createSlackMcpServer(ctx: SlackPostContext): McpServer {
	const server = new McpServer({ name: 'maskin-slack', version: '0.1.0' })

	server.registerTool(
		'slack_send_message',
		{
			description:
				'Post a message to Slack as Machine. The calling agent\'s name and the workspace name are appended automatically as the `username` subscript (e.g. "Synthesizer · in mesh-firm") — do not prefix the message text with your own identity.',
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

	return server
}
