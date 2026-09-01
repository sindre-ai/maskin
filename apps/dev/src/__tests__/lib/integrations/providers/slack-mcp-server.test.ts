import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	createSlackMcpServer,
	isSlackBotToken,
} from '../../../../lib/integrations/providers/slack/mcp-server'

describe('isSlackBotToken', () => {
	it('accepts xoxb- prefixed tokens', () => {
		expect(isSlackBotToken('xoxb-123-456-abc')).toBe(true)
	})

	it('rejects user (xoxp) tokens — the bug this bet closes', () => {
		expect(isSlackBotToken('xoxp-123-456-abc')).toBe(false)
	})

	it('rejects empty, null, or wrongly-prefixed values', () => {
		expect(isSlackBotToken(undefined)).toBe(false)
		expect(isSlackBotToken(null)).toBe(false)
		expect(isSlackBotToken('')).toBe(false)
		expect(isSlackBotToken('xoxe-something')).toBe(false)
	})
})

describe('createSlackMcpServer — slack_send_message', () => {
	const ctx = {
		botToken: 'xoxb-test-token',
		agentLabel: 'Synthesizer · in mesh-firm',
		iconUrl: 'https://maskin.example.com/maskin.png',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		slackTeamId: 'T123ABC',
	}

	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue({
			ok: true,
			json: async () => ({ ok: true, ts: '1717000000.000100', channel: 'C123' }),
		} as Response)
		vi.stubGlobal('fetch', fetchMock)
		capturePosthogEventMock.mockClear()
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	async function callSendMessage(args: Record<string, unknown>) {
		const server = createSlackMcpServer(ctx)
		const tools = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools
		const tool = tools.slack_send_message
		expect(tool).toBeDefined()
		return tool.handler(args, {})
	}

	it('posts to chat.postMessage as Maskin with the agent label in a Block Kit context block', async () => {
		await callSendMessage({ channel: 'C123', text: 'hello' })

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://slack.com/api/chat.postMessage')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token')

		const body = JSON.parse(init.body as string)
		expect(body.channel).toBe('C123')
		expect(body.text).toBe('hello')
		expect(body.username).toBe('Maskin')
		expect(body.icon_url).toBe('https://maskin.example.com/maskin.png')
		expect(body.blocks).toEqual([
			{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } },
			{ type: 'context', elements: [{ type: 'mrkdwn', text: 'Synthesizer · in mesh-firm' }] },
		])
	})

	it('forwards thread_ts when provided', async () => {
		await callSendMessage({ channel: 'C123', text: 'reply', thread_ts: '1717000000.000050' })
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit
		const body = JSON.parse(init.body as string)
		expect(body.thread_ts).toBe('1717000000.000050')
	})

	it('omits icon_url when no iconUrl is configured', async () => {
		const server = createSlackMcpServer({ ...ctx, iconUrl: undefined })
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_send_message
		await tool.handler({ channel: 'C123', text: 'hi' }, {})
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect('icon_url' in body).toBe(false)
		expect(body.username).toBe('Maskin')
	})

	it('omits the context block when agentLabel is empty — no placeholder text', async () => {
		const server = createSlackMcpServer({ ...ctx, agentLabel: '' })
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_send_message
		await tool.handler({ channel: 'C123', text: 'hi' }, {})
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect(body.username).toBe('Maskin')
		expect('blocks' in body).toBe(false)
	})

	it('omits the context block when agentLabel is whitespace-only', async () => {
		const server = createSlackMcpServer({ ...ctx, agentLabel: '   ' })
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_send_message
		await tool.handler({ channel: 'C123', text: 'hi' }, {})
		const body = JSON.parse((fetchMock.mock.calls[0]?.[1] as RequestInit).body as string)
		expect('blocks' in body).toBe(false)
	})

	it('refuses to post when the context token is not a bot token — defense in depth', async () => {
		const server = createSlackMcpServer({ ...ctx, botToken: 'xoxp-user-token' })
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_send_message
		await expect(tool.handler({ channel: 'C123', text: 'hi' }, {})).rejects.toThrow(
			/not a bot token/i,
		)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('surfaces Slack API errors so failures are not swallowed', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ ok: false, error: 'channel_not_found' }),
		} as Response)
		await expect(callSendMessage({ channel: 'C123', text: 'hi' })).rejects.toThrow(
			/channel_not_found/,
		)
	})

	it('emits slack.message.posted to PostHog after a successful send — drives the bet ship metric', async () => {
		await callSendMessage({ channel: 'C123', text: 'hello' })

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		const [event, distinctId, props] = capturePosthogEventMock.mock.calls[0] as [
			string,
			string,
			Record<string, unknown>,
		]
		expect(event).toBe('slack.message.posted')
		expect(distinctId).toBe('ws-1')
		expect(props).toEqual({
			workspace_id: 'ws-1',
			slack_team_id: 'T123ABC',
			posted_as_machine: true,
			has_agent_subscript: true,
			agent_actor_id: 'actor-1',
		})
	})

	it('records slack_team_id as null when the integration row predates externalId backfill', async () => {
		const server = createSlackMcpServer({ ...ctx, slackTeamId: undefined })
		const tool = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools.slack_send_message
		await tool.handler({ channel: 'C123', text: 'hi' }, {})
		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(props.slack_team_id).toBeNull()
	})

	it('does NOT emit slack.message.posted when the post fails', async () => {
		fetchMock.mockResolvedValueOnce({
			ok: true,
			json: async () => ({ ok: false, error: 'channel_not_found' }),
		} as Response)
		await expect(callSendMessage({ channel: 'C123', text: 'hi' })).rejects.toThrow()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('surfaces the HTTP status when Slack returns a non-2xx HTML body instead of throwing SyntaxError from res.json()', async () => {
		const htmlBody = '<html><body>503 Service Unavailable</body></html>'
		fetchMock.mockResolvedValueOnce({
			ok: false,
			status: 503,
			json: async () => {
				throw new SyntaxError('Unexpected token < in JSON at position 0')
			},
			text: async () => htmlBody,
		} as unknown as Response)
		await expect(callSendMessage({ channel: 'C123', text: 'hi' })).rejects.toThrow(/HTTP 503/)
	})
})

// ─────────────────────────────────────────────────────────────────────────────
// The read/search surface added so agents can resolve a channel id to a name
// without asking a human to paste it out of the Slack UI.
// ─────────────────────────────────────────────────────────────────────────────

type ToolMap = Record<
	string,
	{
		description?: string
		handler: (args: unknown, extra: unknown) => Promise<{ content: { text: string }[] }>
	}
>

function toolsOf(ctx: Parameters<typeof createSlackMcpServer>[0]): ToolMap {
	return (createSlackMcpServer(ctx) as unknown as { _registeredTools: ToolMap })._registeredTools
}

/** Parse the JSON payload a tool returns in `content[0].text`. */
function payload(result: { content: { text: string }[] }): Record<string, unknown> {
	return JSON.parse(result.content[0].text)
}

function jsonResponse(body: unknown) {
	return { ok: true, json: async () => body } as Response
}

const baseCtx = {
	botToken: 'xoxb-test-token',
	agentLabel: 'Chief of Staff · in mesh-firm',
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	slackTeamId: 'T123ABC',
}

describe('createSlackMcpServer — tool registration', () => {
	it('registers the full bot-token read surface', () => {
		const tools = toolsOf(baseCtx)
		for (const name of [
			'slack_send_message',
			'slack_schedule_message',
			'slack_search_channels',
			'slack_get_channel_info',
			'slack_read_channel',
			'slack_read_thread',
			'slack_search_users',
			'slack_read_user_profile',
			'slack_read_canvas',
			'slack_create_canvas',
			'slack_update_canvas',
		]) {
			expect(tools[name], `${name} should be registered`).toBeDefined()
		}
	})

	// Slack offers `search:read` only as a user scope, so a workspace whose
	// install predates the user-token grant genuinely cannot search. Omitting the
	// tool is honest; registering one that always fails is not.
	it('omits the search tool when the workspace has no user token', () => {
		const tools = toolsOf(baseCtx)
		expect(tools.slack_search_messages).toBeUndefined()
	})

	it('registers the search tool when a user token is present', () => {
		const tools = toolsOf({ ...baseCtx, userToken: 'xoxp-user-token' })
		expect(tools.slack_search_messages).toBeDefined()
	})

	// `search.messages` has no channel-scoping parameter — its reach is fixed by
	// the user token's scopes. A second, narrower-sounding tool could therefore
	// only differ in its label, and an agent that picked it to stay out of private
	// conversations would be handed DM content under an assurance the request
	// never made. One tool, honestly described.
	it('registers exactly one search tool, and does not claim a public-only one', () => {
		const tools = toolsOf({ ...baseCtx, userToken: 'xoxp-user-token' })
		expect(Object.keys(tools).filter((n) => n.startsWith('slack_search_m'))).toEqual([
			'slack_search_messages',
		])
		expect(tools.slack_search_public).toBeUndefined()
		expect(tools.slack_search_public_and_private).toBeUndefined()
	})

	it('warns in its description that search reaches private channels and DMs', () => {
		const tools = toolsOf({ ...baseCtx, userToken: 'xoxp-user-token' })
		expect(tools.slack_search_messages.description).toMatch(/private channels/i)
		expect(tools.slack_search_messages.description).toMatch(/DMs/)
	})
})

describe('createSlackMcpServer — token separation', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	function authOf(callIndex: number): string {
		const init = fetchMock.mock.calls[callIndex]?.[1] as RequestInit
		return (init.headers as Record<string, string>).Authorization
	}

	it('searches with the USER token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, messages: { total: 0, matches: [] } }))
		const tools = toolsOf({ ...baseCtx, userToken: 'xoxp-user-token' })
		await tools.slack_search_messages.handler({ query: 'pricing' }, {})
		expect(authOf(0)).toBe('Bearer xoxp-user-token')
	})

	it('reads channels with the BOT token even when a user token is available', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, messages: [] }))
		const tools = toolsOf({ ...baseCtx, userToken: 'xoxp-user-token' })
		await tools.slack_read_channel.handler({ channel_id: 'C123' }, {})
		expect(authOf(0)).toBe('Bearer xoxb-test-token')
	})

	// The original mesh-firm bug: posting with a user token attributes every
	// agent message to the human who installed the app.
	it('never posts with the user token', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, ts: '1.1', channel: 'C123' }))
		const tools = toolsOf({ ...baseCtx, userToken: 'xoxp-user-token' })
		await tools.slack_send_message.handler({ channel: 'C123', text: 'hi' }, {})
		expect(authOf(0)).toBe('Bearer xoxb-test-token')
	})

	it('refuses every write when the bot token slot holds a user token', async () => {
		const tools = toolsOf({ ...baseCtx, botToken: 'xoxp-user-token' })
		await expect(
			tools.slack_schedule_message.handler(
				{ channel: 'C123', text: 'hi', post_at: 1893456000 },
				{},
			),
		).rejects.toThrow(/not a bot token/i)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})

describe('slack_search_channels', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	const channels = [
		{ id: 'C075JBZ65RT', name: 'maskin-alerts', topic: { value: 'Platform alerts' } },
		{ id: 'C0BRE23NFN1', name: 'maskin-coach', purpose: { value: 'Coach Solutions' } },
		{ id: 'C0BR48J5WG5', name: 'maskin-app', is_private: true },
	]

	// The scenario that motivated the whole tool: an agent holding a channel id
	// and needing its name.
	it('resolves a channel id to a name', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, channels }))
		const tools = toolsOf(baseCtx)
		const result = payload(await tools.slack_search_channels.handler({}, {}))
		const found = (result.channels as { id: string; name: string }[]).find(
			(c) => c.id === 'C0BR48J5WG5',
		)
		expect(found?.name).toBe('maskin-app')
	})

	it('filters on name, topic and purpose', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, channels }))
		const tools = toolsOf(baseCtx)
		const byPurpose = payload(await tools.slack_search_channels.handler({ query: 'coach' }, {}))
		expect((byPurpose.channels as { id: string }[]).map((c) => c.id)).toEqual(['C0BRE23NFN1'])

		const byTopic = payload(await tools.slack_search_channels.handler({ query: 'platform' }, {}))
		expect((byTopic.channels as { id: string }[]).map((c) => c.id)).toEqual(['C075JBZ65RT'])
	})

	it('requests private channels by default and public-only when asked', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, channels }))
		const tools = toolsOf(baseCtx)
		await tools.slack_search_channels.handler({}, {})
		expect(fetchMock.mock.calls[0][0]).toContain('public_channel%2Cprivate_channel')

		fetchMock.mockClear()
		await tools.slack_search_channels.handler({ include_private: false }, {})
		expect(fetchMock.mock.calls[0][0]).not.toContain('private_channel')
	})

	// A silent cap reads as "no such channel" to an agent — the exact
	// misdiagnosis this surface exists to prevent.
	it('reports truncation instead of silently capping the walk', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({
				ok: true,
				channels,
				response_metadata: { next_cursor: 'more-pages-forever' },
			}),
		)
		const tools = toolsOf(baseCtx)
		const result = payload(await tools.slack_search_channels.handler({}, {}))
		expect(result.warning).toMatch(/may be incomplete/i)
		// Bounded: it stops at the page cap rather than following the cursor forever.
		expect(fetchMock).toHaveBeenCalledTimes(10)
	})

	it('does not claim truncation when the walk completes', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: true, channels }))
		const tools = toolsOf(baseCtx)
		const result = payload(await tools.slack_search_channels.handler({}, {}))
		expect(result.warning).toBeUndefined()
	})
})

describe('slack_read_channel — membership handling', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	it('joins a public channel and retries when Slack says not_in_channel', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not_in_channel' }))
			.mockResolvedValueOnce(jsonResponse({ ok: true, channel: { id: 'C123' } }))
			.mockResolvedValueOnce(
				jsonResponse({ ok: true, messages: [{ ts: '1.1', text: 'hello', user: 'U1' }] }),
			)

		const tools = toolsOf(baseCtx)
		const result = payload(await tools.slack_read_channel.handler({ channel_id: 'C123' }, {}))

		expect(fetchMock.mock.calls[1][0]).toContain('conversations.join')
		expect((result.messages as { text: string }[])[0].text).toBe('hello')
	})

	// A private channel genuinely needs a human, so the actionable instruction
	// must survive — not be replaced by a confusing join failure.
	it('surfaces the invite instruction when the join is refused', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not_in_channel' }))
			.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'channel_not_found' }))

		const tools = toolsOf(baseCtx)
		await expect(tools.slack_read_channel.handler({ channel_id: 'C999' }, {})).rejects.toThrow(
			/invite the Maskin app/i,
		)
	})
})

describe('Slack error messages are actionable', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	// An install predating the history scopes is the single most likely failure
	// after this ships, and "missing_scope" alone tells an agent nothing.
	it('tells the caller to reconnect on missing_scope, naming the scope', async () => {
		fetchMock.mockResolvedValue(
			jsonResponse({ ok: false, error: 'missing_scope', needed: 'channels:history' }),
		)
		const tools = toolsOf(baseCtx)
		await expect(
			tools.slack_read_thread.handler({ channel_id: 'C1', message_ts: '1.1' }, {}),
		).rejects.toThrow(/reconnect/i)
	})

	it('keeps the raw Slack code in the message for log grepping', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'missing_scope' }))
		const tools = toolsOf(baseCtx)
		await expect(tools.slack_get_channel_info.handler({ channel_id: 'C1' }, {})).rejects.toThrow(
			/missing_scope/,
		)
	})

	// The auto-join fallback used to rethrow the original `not_in_channel`
	// whatever the join failed on — telling an admin to `/invite @Maskin` into a
	// PUBLIC channel when the real cause was a scope the reconnect prompt fixes.
	it('surfaces the join failure when the join failed for its own reason', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not_in_channel' }))
			.mockResolvedValueOnce(
				jsonResponse({ ok: false, error: 'missing_scope', needed: 'channels:join' }),
			)
		const tools = toolsOf(baseCtx)
		const err = await tools.slack_read_channel
			.handler({ channel_id: 'C1' }, {})
			.catch((e: Error) => e)
		expect(err.message).toMatch(/channels:join/)
		expect(err.message).not.toMatch(/\/invite/)
	})

	// ...but a genuine membership refusal is exactly when that instruction is true.
	it('keeps the invite instruction when the channel cannot be self-joined', async () => {
		fetchMock
			.mockResolvedValueOnce(jsonResponse({ ok: false, error: 'not_in_channel' }))
			.mockResolvedValueOnce(
				jsonResponse({ ok: false, error: 'method_not_supported_for_channel_type' }),
			)
		const tools = toolsOf(baseCtx)
		await expect(tools.slack_read_channel.handler({ channel_id: 'C1' }, {})).rejects.toThrow(
			/\/invite @Maskin/,
		)
	})

	it('points at slack_search_channels when a channel id is not found', async () => {
		fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'channel_not_found' }))
		const tools = toolsOf(baseCtx)
		await expect(
			tools.slack_get_channel_info.handler({ channel_id: 'C-nope' }, {}),
		).rejects.toThrow(/slack_search_channels/)
	})
})

describe('slack_update_canvas', () => {
	let fetchMock: ReturnType<typeof vi.fn>

	beforeEach(() => {
		fetchMock = vi.fn().mockResolvedValue(jsonResponse({ ok: true }))
		vi.stubGlobal('fetch', fetchMock)
	})
	afterEach(() => vi.unstubAllGlobals())

	it('sends a single markdown change for a content operation', async () => {
		const tools = toolsOf(baseCtx)
		await tools.slack_update_canvas.handler(
			{ canvas_id: 'F1', operation: 'insert_at_end', markdown: '## Notes' },
			{},
		)
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
		expect(body.canvas_id).toBe('F1')
		// Slack supports exactly one operation per call.
		expect(body.changes).toHaveLength(1)
		expect(body.changes[0]).toEqual({
			operation: 'insert_at_end',
			document_content: { type: 'markdown', markdown: '## Notes' },
		})
	})

	it('uses title_content for a rename', async () => {
		const tools = toolsOf(baseCtx)
		await tools.slack_update_canvas.handler(
			{ canvas_id: 'F1', operation: 'rename', title: 'Q3 plan' },
			{},
		)
		const body = JSON.parse((fetchMock.mock.calls[0][1] as RequestInit).body as string)
		expect(body.changes[0]).toEqual({
			operation: 'rename',
			title_content: { type: 'markdown', markdown: 'Q3 plan' },
		})
	})

	// Fail locally with a clear reason rather than spending a round-trip to have
	// Slack reject it with something vaguer.
	it('rejects a content operation with no markdown before calling Slack', async () => {
		const tools = toolsOf(baseCtx)
		await expect(
			tools.slack_update_canvas.handler({ canvas_id: 'F1', operation: 'replace' }, {}),
		).rejects.toThrow(/requires `markdown`/)
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('rejects a rename with no title before calling Slack', async () => {
		const tools = toolsOf(baseCtx)
		await expect(
			tools.slack_update_canvas.handler({ canvas_id: 'F1', operation: 'rename' }, {}),
		).rejects.toThrow(/requires `title`/)
		expect(fetchMock).not.toHaveBeenCalled()
	})
})
