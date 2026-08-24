import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { _resetSlackCaches } from '../../../../lib/integrations/providers/slack/client'
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
		integrationId: 'int-1',
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

describe('createSlackMcpServer — discovery and membership tools', () => {
	const ctx = {
		botToken: 'xoxb-test-token',
		integrationId: 'int-1',
		agentLabel: 'Synthesizer · in mesh-firm',
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		slackTeamId: 'T123ABC',
	}

	let fetchMock: ReturnType<typeof vi.fn>

	/** Queue one JSON envelope per expected Slack call, in order. */
	function queueSlackResponses(...bodies: Array<Record<string, unknown>>) {
		for (const body of bodies) {
			fetchMock.mockResolvedValueOnce({ ok: true, json: async () => body } as Response)
		}
	}

	const CHANNELS = [
		{ id: 'C075JBZ65RT', name: 'maskin-app', is_channel: true, is_member: false },
		{ id: 'C0GENERAL01', name: 'general', is_channel: true, is_member: true },
		{ id: 'C0PRIVATE01', name: 'founders', is_channel: true, is_private: true, is_member: true },
	]

	beforeEach(() => {
		_resetSlackCaches()
		fetchMock = vi.fn()
		vi.stubGlobal('fetch', fetchMock)
	})

	afterEach(() => {
		vi.unstubAllGlobals()
	})

	function tool(name: string) {
		const server = createSlackMcpServer(ctx)
		const registered = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools[name]
		expect(registered).toBeDefined()
		return registered
	}

	async function callTool(name: string, args: Record<string, unknown>) {
		const result = (await tool(name).handler(args, {})) as {
			content: Array<{ text: string }>
		}
		return JSON.parse(result.content[0].text)
	}

	it('refuses every tool when the stored credential is a user token, not just the posting one', async () => {
		const server = createSlackMcpServer({ ...ctx, botToken: 'xoxp-user-token' })
		const registered = (
			server as unknown as {
				_registeredTools: Record<
					string,
					{ handler: (args: unknown, extra: unknown) => Promise<unknown> }
				>
			}
		)._registeredTools

		const calls: Array<[string, Record<string, unknown>]> = [
			['slack_list_channels', {}],
			['slack_list_users', {}],
			['slack_join_channel', { channel: 'C0GENERAL01' }],
			['slack_add_reaction', { channel: 'C0GENERAL01', timestamp: '1.1', emoji: 'eyes' }],
			['slack_get_permalink', { channel: 'C0GENERAL01', message_ts: '1.1' }],
		]
		for (const [name, args] of calls) {
			await expect(registered[name].handler(args, {})).rejects.toThrow(/not a bot token/)
		}
		expect(fetchMock).not.toHaveBeenCalled()
	})

	it('registers the full Slack tool surface', () => {
		const server = createSlackMcpServer(ctx)
		const names = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools,
		).sort()
		expect(names).toEqual([
			'slack_add_reaction',
			'slack_get_permalink',
			'slack_join_channel',
			'slack_list_channels',
			'slack_list_users',
			'slack_send_message',
		])
	})

	describe('slack_list_channels', () => {
		it('lists channels with ids and membership — the lookup agents previously had no way to make', async () => {
			queueSlackResponses({ ok: true, channels: CHANNELS })
			const out = await callTool('slack_list_channels', {})

			const [url] = fetchMock.mock.calls[0] as [string]
			expect(url).toContain('conversations.list')
			expect(url).toContain('types=private_channel%2Cpublic_channel')
			expect(out.channels).toEqual([
				{ id: 'C075JBZ65RT', name: 'maskin-app', kind: 'public', is_member: false },
				{ id: 'C0GENERAL01', name: 'general', kind: 'public', is_member: true },
				{ id: 'C0PRIVATE01', name: 'founders', kind: 'private', is_member: true },
			])
		})

		it('filters by name, ignoring a leading #', async () => {
			queueSlackResponses({ ok: true, channels: CHANNELS })
			const out = await callTool('slack_list_channels', { query: '#MASKIN' })
			expect(out.channels).toHaveLength(1)
			expect(out.channels[0].id).toBe('C075JBZ65RT')
		})

		it('filters to joined channels when only_member is set', async () => {
			queueSlackResponses({ ok: true, channels: CHANNELS })
			const out = await callTool('slack_list_channels', { only_member: true })
			expect(out.channels.map((c: { name: string }) => c.name)).toEqual(['general', 'founders'])
		})

		it('reports truncation rather than silently capping', async () => {
			queueSlackResponses({ ok: true, channels: CHANNELS })
			const out = await callTool('slack_list_channels', { limit: 1 })
			expect(out).toMatchObject({ matched: 3, returned: 1, truncated: true })
		})

		it('rewrites missing_scope into a reconnect instruction', async () => {
			queueSlackResponses({ ok: false, error: 'missing_scope' })
			await expect(callTool('slack_list_channels', {})).rejects.toThrow(/Reconnect Slack/)
		})
	})

	describe('slack_list_users', () => {
		it('returns a ready-to-paste mention string and drops bots by default', async () => {
			queueSlackResponses({
				ok: true,
				members: [
					{ id: 'U1', name: 'alice', real_name: 'Alice Ng', is_bot: false },
					{ id: 'U2', name: 'buildbot', real_name: 'Build Bot', is_bot: true },
				],
			})
			const out = await callTool('slack_list_users', {})
			expect(out.users).toEqual([
				{ id: 'U1', name: 'alice', real_name: 'Alice Ng', is_bot: false, mention: '<@U1>' },
			])
		})

		it('matches on real name and honours include_bots', async () => {
			queueSlackResponses({
				ok: true,
				members: [
					{ id: 'U1', name: 'alice', real_name: 'Alice Ng', is_bot: false },
					{ id: 'U2', name: 'buildbot', real_name: 'Build Bot', is_bot: true },
				],
			})
			const out = await callTool('slack_list_users', { query: 'bot', include_bots: true })
			expect(out.users.map((u: { id: string }) => u.id)).toEqual(['U2'])
		})
	})

	describe('slack_join_channel', () => {
		it('resolves a #name to an id before joining', async () => {
			queueSlackResponses({ ok: true, channels: CHANNELS }, { ok: true })
			const out = await callTool('slack_join_channel', { channel: '#maskin-app' })

			expect(out).toEqual({ ok: true, channel: 'C075JBZ65RT' })
			const [joinUrl, joinInit] = fetchMock.mock.calls[1] as [string, RequestInit]
			expect(joinUrl).toBe('https://slack.com/api/conversations.join')
			expect(JSON.parse(joinInit.body as string)).toEqual({ channel: 'C075JBZ65RT' })
		})

		it('passes a channel id straight through without a lookup', async () => {
			queueSlackResponses({ ok: true })
			await callTool('slack_join_channel', { channel: 'C075JBZ65RT' })
			expect(fetchMock).toHaveBeenCalledOnce()
			expect(fetchMock.mock.calls[0][0]).toBe('https://slack.com/api/conversations.join')
		})

		it('explains how to find the channel when the name is not visible', async () => {
			queueSlackResponses({ ok: true, channels: CHANNELS })
			await expect(callTool('slack_join_channel', { channel: '#nope' })).rejects.toThrow(
				/slack_list_channels/,
			)
		})
	})

	describe('slack_add_reaction', () => {
		it('strips colons and posts to reactions.add', async () => {
			queueSlackResponses({ ok: true })
			const out = await callTool('slack_add_reaction', {
				channel: 'C0GENERAL01',
				timestamp: '1717000000.000100',
				emoji: ':eyes:',
			})

			expect(out).toMatchObject({ ok: true, emoji: 'eyes', already_reacted: false })
			const [, init] = fetchMock.mock.calls[0] as [string, RequestInit]
			expect(JSON.parse(init.body as string)).toEqual({
				channel: 'C0GENERAL01',
				timestamp: '1717000000.000100',
				name: 'eyes',
			})
		})

		it('treats already_reacted as success so a retry is not a failure', async () => {
			queueSlackResponses({ ok: false, error: 'already_reacted' })
			const out = await callTool('slack_add_reaction', {
				channel: 'C0GENERAL01',
				timestamp: '1717000000.000100',
				emoji: 'eyes',
			})
			expect(out).toMatchObject({ ok: true, already_reacted: true })
		})

		it('rejects an emoji shortcode that is not a valid Slack name', async () => {
			await expect(
				callTool('slack_add_reaction', {
					channel: 'C0GENERAL01',
					timestamp: '1717000000.000100',
					emoji: 'not an emoji!',
				}),
			).rejects.toThrow(/Invalid emoji shortcode/)
			expect(fetchMock).not.toHaveBeenCalled()
		})
	})

	describe('slack_get_permalink', () => {
		it('returns the permalink for a message', async () => {
			queueSlackResponses({ ok: true, permalink: 'https://acme.slack.com/archives/C1/p1717' })
			const out = await callTool('slack_get_permalink', {
				channel: 'C0GENERAL01',
				message_ts: '1717000000.000100',
			})

			expect(out.permalink).toBe('https://acme.slack.com/archives/C1/p1717')
			const [url] = fetchMock.mock.calls[0] as [string]
			expect(url).toContain('chat.getPermalink')
			expect(url).toContain('message_ts=1717000000.000100')
		})
	})
})
