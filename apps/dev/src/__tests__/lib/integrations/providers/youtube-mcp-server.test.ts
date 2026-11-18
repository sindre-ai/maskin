import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const youtubeRead = vi.fn()
vi.mock('../../../../lib/integrations/providers/youtube/client', () => ({
	youtubeRead: (...args: unknown[]) => youtubeRead(...args),
}))

const trackYoutubeToolCalled = vi.fn()
vi.mock('../../../../lib/analytics/youtube-events', () => ({
	trackYoutubeToolCalled: (...args: unknown[]) => trackYoutubeToolCalled(...args),
}))

import { YoutubeError } from '../../../../lib/integrations/providers/youtube/errors'
import { createYoutubeMcpServer } from '../../../../lib/integrations/providers/youtube/mcp-server'
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

async function connect() {
	const ctx = { db: {} as Database, workspaceId: 'ws-1', actorId: 'agent-1' }
	const server = createYoutubeMcpServer(ctx)
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return { client, ctx }
}

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
	JSON.parse((result.content as Array<{ text: string }>)[0].text)

describe('maskin-youtube tool server', () => {
	beforeEach(() => {
		youtubeRead.mockReset()
		trackYoutubeToolCalled.mockReset()
	})

	it('lists exactly youtube__get_channel', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name)).toEqual(['youtube__get_channel'])
	})

	it('get_channel reads channels.list mine=true with the three parts, 1 unit', async () => {
		youtubeRead.mockResolvedValueOnce({ items: [{ id: 'UC1' }] })
		const { client, ctx } = await connect()

		const result = await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(text(result)).toEqual({ items: [{ id: 'UC1' }] })
		expect(youtubeRead).toHaveBeenCalledWith(ctx, {
			tool: 'youtube__get_channel',
			path: 'channels',
			params: { part: 'snippet,statistics,contentDetails', mine: 'true' },
			units: 1,
		})
	})

	it('returns a client error as a normalized tool error', async () => {
		youtubeRead.mockRejectedValueOnce(
			new YoutubeError({
				code: 'RECONSENT_REQUIRED',
				message: 'reconnect',
				provider_status: 401,
				integration_id: 'int-1',
			}),
		)
		const { client } = await connect()

		const result = await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(result.isError).toBe(true)
		expect(text(result)).toEqual({
			error: {
				code: 'RECONSENT_REQUIRED',
				message: 'reconnect',
				provider_status: 401,
				integration_id: 'int-1',
			},
		})
	})

	it('hides the text of an unexpected error', async () => {
		youtubeRead.mockRejectedValueOnce(new Error('response body with Secret channel title'))
		const { client } = await connect()

		const result = await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(result.isError).toBe(true)
		expect(JSON.stringify(text(result))).not.toContain('Secret channel title')
		expect(text(result).error.code).toBe('PROVIDER_ERROR')
	})
})

describe('youtube_tool_called event', () => {
	beforeEach(() => {
		youtubeRead.mockReset()
		trackYoutubeToolCalled.mockReset()
	})

	it('emits one event per call with the short tool name and no content', async () => {
		youtubeRead.mockResolvedValueOnce({ items: [{ snippet: { title: 'Secret channel title' } }] })
		const { client } = await connect()

		await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			agentId: 'agent-1',
			sessionId: null,
			tool: 'get_channel',
			outcome: 'ok',
			viaLoop: false,
		})
		expect(JSON.stringify(trackYoutubeToolCalled.mock.calls)).not.toContain('Secret channel title')
	})

	it.each([
		['QUOTA_EXHAUSTED', 'quota_blocked'],
		['WORKSPACE_QUOTA_EXHAUSTED', 'quota_blocked'],
		['NOT_CONNECTED', 'not_connected'],
		['RECONSENT_REQUIRED', 'not_connected'],
		['PROVIDER_ERROR', 'upstream_error'],
		['RATE_LIMITED', 'upstream_error'],
	] as const)('reports %s as outcome %s', async (code, outcome) => {
		youtubeRead.mockRejectedValueOnce(new YoutubeError({ code, message: 'x' }))
		const { client } = await connect()

		await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(expect.objectContaining({ outcome }))
	})

	it('reports an unexpected error as upstream_error', async () => {
		youtubeRead.mockRejectedValueOnce(new Error('boom'))
		const { client } = await connect()
		await client.callTool({ name: 'youtube__get_channel', arguments: {} })
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'upstream_error' }),
		)
	})

	it('marks via_loop when a trigger started the calling session', async () => {
		youtubeRead.mockResolvedValueOnce({})
		const rows = [{ triggerId: 'trigger-1' }]
		const chain: Record<string, unknown> = {}
		for (const m of ['select', 'from', 'where']) chain[m] = () => chain
		chain.limit = async () => rows
		const server = createYoutubeMcpServer({
			db: chain as unknown as Database,
			workspaceId: 'ws-1',
			actorId: 'agent-1',
			sessionId: 'session-1',
		})
		const client = new Client({ name: 'c', version: '0.0.0' })
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([server.connect(a), client.connect(b)])

		await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ sessionId: 'session-1', viaLoop: true }),
		)
	})

	it('still answers when the session lookup fails', async () => {
		youtubeRead.mockResolvedValueOnce({ ok: true })
		const server = createYoutubeMcpServer({
			db: {
				select: () => {
					throw new Error('db down')
				},
			} as unknown as Database,
			workspaceId: 'ws-1',
			actorId: 'agent-1',
			sessionId: 'session-1',
		})
		const client = new Client({ name: 'c', version: '0.0.0' })
		const [a, b] = InMemoryTransport.createLinkedPair()
		await Promise.all([server.connect(a), client.connect(b)])

		const result = await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(result.isError).toBeUndefined()
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(expect.objectContaining({ viaLoop: false }))
	})
})

describe('youtube tool kinds', () => {
	it('classifies get_channel as a read, so a read-only agent may call it', () => {
		expect(classifyTool('youtube', 'youtube__get_channel')).toBe('read')
	})

	it('treats a youtube tool nobody classified as a write', () => {
		expect(classifyTool('youtube', 'youtube__upload_video')).toBe('write')
	})
})
