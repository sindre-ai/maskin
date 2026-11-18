import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const getIntegrationCredential = vi.fn()
const getValidToken = vi.fn()
const chargeYoutubeQuota = vi.fn()

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
vi.mock('../../../../lib/analytics/youtube-events', () => ({
	trackYoutubeToolCalled: vi.fn(),
}))
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

import { clearYoutubeCache } from '../../../../lib/integrations/providers/youtube/cache'
import { createYoutubeMcpServer } from '../../../../lib/integrations/providers/youtube/mcp-server'

const CHANNEL = { items: [{ id: 'UC1', contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }
const PLAYLIST = { items: [{ contentDetails: { videoId: 'v1' } }] }

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), { status: 200 })
}

async function connect() {
	const server = createYoutubeMcpServer({
		db: {} as never,
		workspaceId: 'ws-1',
		actorId: 'agent-1',
	})
	const client = new Client({ name: 'c', version: '0.0.0' })
	const [a, b] = InMemoryTransport.createLinkedPair()
	await Promise.all([server.connect(a), client.connect(b)])
	return client
}

const call = (client: Client, args: Record<string, unknown> = {}) =>
	client.callTool({ name: 'youtube__list_recent_videos', arguments: args })

describe('youtube__list_recent_videos through the real client', () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		clearYoutubeCache()
		getIntegrationCredential.mockReset().mockResolvedValue({ id: 'int-1' })
		getValidToken.mockReset().mockResolvedValue('ya29.token')
		chargeYoutubeQuota.mockReset().mockResolvedValue(undefined)
		fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockImplementation(async (url) =>
				jsonResponse(String(url).includes('/channels?') ? CHANNEL : PLAYLIST),
			)
	})
	afterEach(() => vi.restoreAllMocks())

	it('looks up the uploads playlist, then reads it with the page size capped at 50', async () => {
		const client = await connect()

		await call(client)

		const urls = fetchSpy.mock.calls.map(([u]) => String(u))
		expect(urls[0]).toContain('/youtube/v3/channels?')
		expect(urls[1]).toBe(
			'https://www.googleapis.com/youtube/v3/playlistItems?part=snippet%2CcontentDetails&playlistId=UU1&maxResults=50',
		)
	})

	it('charges 1 unit for the playlist read and 1 for the uncached channel lookup', async () => {
		const client = await connect()

		await call(client)

		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1, 1])
	})

	it('costs zero units when the same call repeats inside the cache window', async () => {
		const client = await connect()
		await call(client)
		chargeYoutubeQuota.mockClear()
		fetchSpy.mockClear()

		await call(client)

		expect(chargeYoutubeQuota).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('shares the channel cache with get_channel, so only the playlist read is charged', async () => {
		const client = await connect()
		await client.callTool({ name: 'youtube__get_channel', arguments: {} })
		chargeYoutubeQuota.mockClear()

		await call(client)

		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1])
	})

	it('treats a different page token as a different read', async () => {
		const client = await connect()
		await call(client)
		chargeYoutubeQuota.mockClear()

		await call(client, { page_token: 'tok2' })

		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1])
	})
})
