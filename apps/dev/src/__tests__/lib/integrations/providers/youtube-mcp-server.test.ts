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
	beforeEach(() => youtubeRead.mockReset())

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

describe('youtube tool kinds', () => {
	it('classifies get_channel as a read, so a read-only agent may call it', () => {
		expect(classifyTool('youtube', 'youtube__get_channel')).toBe('read')
	})

	it('treats a youtube tool nobody classified as a write', () => {
		expect(classifyTool('youtube', 'youtube__upload_video')).toBe('write')
	})
})
