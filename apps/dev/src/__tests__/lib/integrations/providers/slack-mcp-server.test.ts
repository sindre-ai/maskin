import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { logger } from '../../../../lib/logger'
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
		agentTitle: 'Synthesizer',
		workspaceName: 'mesh-firm',
		machineIconUrl: 'https://maskin.example.com/machine.png',
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

	it('posts to chat.postMessage with the bot token, constant Machine username, and a context-block subscript', async () => {
		await callSendMessage({ channel: 'C123', text: 'hello' })

		expect(fetchMock).toHaveBeenCalledOnce()
		const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit]
		expect(url).toBe('https://slack.com/api/chat.postMessage')
		expect((init.headers as Record<string, string>).Authorization).toBe('Bearer xoxb-test-token')

		const body = JSON.parse(init.body as string)
		expect(body).toEqual({
			channel: 'C123',
			text: 'hello',
			username: 'Machine',
			icon_url: 'https://maskin.example.com/machine.png',
			blocks: [
				{ type: 'section', text: { type: 'mrkdwn', text: 'hello' } },
				{
					type: 'context',
					elements: [{ type: 'mrkdwn', text: '*Synthesizer* · in mesh-firm' }],
				},
			],
		})
	})

	it('sends the constant Machine username on every post regardless of agent', async () => {
		const server = createSlackMcpServer({ ...ctx, agentTitle: 'Curator', workspaceName: 'acme' })
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
		expect(body.username).toBe('Machine')
		expect(body.blocks).toContainEqual({
			type: 'context',
			elements: [{ type: 'mrkdwn', text: '*Curator* · in acme' }],
		})
	})

	it('omits the context block (and error-logs) when agentTitle is blank — no fallback per T2 spec', async () => {
		const loggerErrorSpy = vi.spyOn(logger, 'error').mockImplementation(() => undefined)
		const server = createSlackMcpServer({ ...ctx, agentTitle: '   ' })
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
		expect(body.username).toBe('Machine')
		expect(body.blocks).toEqual([{ type: 'section', text: { type: 'mrkdwn', text: 'hi' } }])
		expect(loggerErrorSpy).toHaveBeenCalledWith(
			'Slack post missing agent title — context block will be omitted',
			expect.objectContaining({ workspaceId: 'ws-1', actorId: 'actor-1' }),
		)
		loggerErrorSpy.mockRestore()
	})

	it('forwards thread_ts when provided', async () => {
		await callSendMessage({ channel: 'C123', text: 'reply', thread_ts: '1717000000.000050' })
		const init = fetchMock.mock.calls[0]?.[1] as RequestInit
		const body = JSON.parse(init.body as string)
		expect(body.thread_ts).toBe('1717000000.000050')
	})

	it('omits icon_url when no machineIconUrl is configured', async () => {
		const server = createSlackMcpServer({ ...ctx, machineIconUrl: undefined })
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
		expect(body.username).toBe('Machine')
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
