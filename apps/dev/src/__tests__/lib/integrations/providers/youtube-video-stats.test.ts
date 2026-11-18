import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getIntegrationCredential = vi.fn()
const getValidToken = vi.fn()
const chargeYoutubeQuota = vi.fn()
const trackYoutubeToolCalled = vi.fn()

vi.mock('../../../../lib/integrations/lookup', () => ({
	getIntegrationCredential: (...args: unknown[]) => getIntegrationCredential(...args),
}))
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidToken
		markRevoked = vi.fn()
	},
}))
vi.mock('../../../../lib/integrations/providers/youtube/quota', () => ({
	chargeYoutubeQuota: (...args: unknown[]) => chargeYoutubeQuota(...args),
}))
vi.mock('../../../../lib/analytics/youtube-events', () => ({
	trackYoutubeToolCalled: (...args: unknown[]) => trackYoutubeToolCalled(...args),
}))

import { clearYoutubeCache } from '../../../../lib/integrations/providers/youtube/cache'
import { createYoutubeMcpServer } from '../../../../lib/integrations/providers/youtube/mcp-server'

// The real tool server and the real client: only the credential lookup, the token, the quota
// table, Google and the analytics sink are stubbed.
async function connect() {
	const server = createYoutubeMcpServer({
		db: {} as Database,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
	})
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return client
}

const callStats = (client: Client, video_ids: string[]) =>
	client.callTool({ name: 'youtube__get_video_stats', arguments: { video_ids } })

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
	JSON.parse((result.content as Array<{ text: string }>)[0].text)

// Google's own shape, including a field no Maskin code knows about, to prove nothing is dropped or added.
const GOOGLE_BODY = {
	kind: 'youtube#videoListResponse',
	etag: 'abc',
	items: [
		{
			id: 'vid1',
			snippet: { title: 'Secret video title', publishedAt: '2026-11-01T10:00:00Z' },
			statistics: { viewCount: '1200', likeCount: '34', commentCount: '5' },
			contentDetails: { duration: 'PT4M13S' },
			someFutureGoogleField: { nested: true },
		},
	],
	pageInfo: { totalResults: 1, resultsPerPage: 1 },
}

const ids = (n: number) => Array.from({ length: n }, (_, i) => `vid${i}`)

describe('youtube__get_video_stats', () => {
	beforeEach(() => {
		clearYoutubeCache()
		getIntegrationCredential.mockReset().mockResolvedValue({ id: 'int-1' })
		getValidToken.mockReset().mockResolvedValue('ya29.token')
		chargeYoutubeQuota.mockReset().mockResolvedValue(undefined)
		trackYoutubeToolCalled.mockReset()
	})
	afterEach(() => vi.restoreAllMocks())

	it('calls videos.list with the three parts and the ids, and returns Google fields unchanged', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(GOOGLE_BODY), { status: 200 }))
		const client = await connect()

		const result = await callStats(client, ['vid1', 'vid2'])

		expect(result.isError).toBeUndefined()
		expect(text(result)).toEqual(GOOGLE_BODY)
		const url = new URL(String(fetchSpy.mock.calls[0][0]))
		expect(url.pathname).toBe('/youtube/v3/videos')
		expect(url.searchParams.get('part')).toBe('snippet,statistics,contentDetails')
		expect(url.searchParams.get('id')).toBe('vid1,vid2')
		expect(chargeYoutubeQuota).toHaveBeenCalledWith(expect.anything(), 'ws-1', 1)
	})

	it('accepts exactly 50 ids and charges one unit', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify(GOOGLE_BODY), { status: 200 }),
		)
		const client = await connect()

		const result = await callStats(client, ids(50))

		expect(result.isError).toBeUndefined()
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(1)
	})

	it('rejects more than 50 ids with an input error before any quota or Google call', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const client = await connect()

		const result = await callStats(client, ids(51))

		expect(result.isError).toBe(true)
		expect(text(result).error.code).toBe('INVALID_INPUT')
		expect(text(result).error.message).toContain('51')
		expect(getIntegrationCredential).not.toHaveBeenCalled()
		expect(chargeYoutubeQuota).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'get_video_stats', outcome: 'invalid_input' }),
		)
	})

	it('rejects an empty list and blank ids the same way', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const client = await connect()

		for (const list of [[], ['vid1', '  ']]) {
			const result = await callStats(client, list)
			expect(result.isError).toBe(true)
			expect(text(result).error.code).toBe('INVALID_INPUT')
		}
		expect(chargeYoutubeQuota).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('serves a repeat call with the same ids from the cache at zero units', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(GOOGLE_BODY), { status: 200 }))
		const client = await connect()

		await callStats(client, ['vid1', 'vid2'])
		const second = await callStats(client, ['vid1', 'vid2'])

		expect(text(second)).toEqual(GOOGLE_BODY)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(2)
	})

	it('charges again for a different set of ids', async () => {
		vi.spyOn(globalThis, 'fetch').mockImplementation(
			async () => new Response(JSON.stringify(GOOGLE_BODY), { status: 200 }),
		)
		const client = await connect()

		await callStats(client, ['vid1'])
		await callStats(client, ['vid1', 'vid2'])

		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(2)
	})

	it('puts no response content in an error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { message: 'Secret video title', errors: [] } }), {
				status: 500,
			}),
		)
		const client = await connect()

		const result = await callStats(client, ['vid1'])

		expect(result.isError).toBe(true)
		expect(JSON.stringify(text(result))).not.toContain('Secret video title')
		expect(text(result).error.integration_id).toBe('int-1')
	})

	it('is classified as a read tool', async () => {
		const { classifyTool } = await import('../../../../lib/integrations/tool-kinds')
		expect(classifyTool('youtube', 'youtube__get_video_stats')).toBe('read')
	})
})
