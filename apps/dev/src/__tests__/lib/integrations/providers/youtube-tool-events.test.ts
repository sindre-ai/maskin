import type { Database } from '@maskin/db'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getIntegrationCredential = vi.fn()
const getCredential = vi.fn()
const listYoutubeConnections = vi.fn()
const getValidToken = vi.fn()
const chargeYoutubeQuota = vi.fn()
const trackYoutubeToolCalled = vi.fn()

vi.mock('../../../../lib/integrations/lookup', () => ({
	getIntegrationCredential: (...args: unknown[]) => getIntegrationCredential(...args),
	getCredential: (...args: unknown[]) => getCredential(...args),
}))
vi.mock('../../../../lib/integrations/providers/youtube/connections', () => ({
	YOUTUBE_PROVIDER: 'youtube',
	listYoutubeConnections: (...args: unknown[]) => listYoutubeConnections(...args),
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
import { YoutubeError } from '../../../../lib/integrations/providers/youtube/errors'
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

const call = (client: Client) => client.callTool({ name: 'youtube__get_channel', arguments: {} })

describe('get_channel emits one youtube_tool_called per call', () => {
	beforeEach(() => {
		clearYoutubeCache()
		getIntegrationCredential.mockReset().mockResolvedValue({ id: 'int-1' })
		getCredential.mockReset()
		listYoutubeConnections
			.mockReset()
			.mockResolvedValue([{ integration_id: 'int-1', account: 'a@example.com' }])
		getValidToken.mockReset().mockResolvedValue('ya29.token')
		chargeYoutubeQuota.mockReset().mockResolvedValue(undefined)
		trackYoutubeToolCalled.mockReset()
	})
	afterEach(() => vi.restoreAllMocks())

	it('on a fresh read', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ items: [{ id: 'UC1' }] }), { status: 200 }),
		)
		const client = await connect()

		await call(client)

		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'get_channel', outcome: 'ok' }),
		)
	})

	it('on a cache hit, which costs no quota', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify({ items: [] }), { status: 200 }))
		const client = await connect()

		await call(client)
		await call(client)

		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(2)
		expect(trackYoutubeToolCalled).toHaveBeenLastCalledWith(
			expect.objectContaining({ outcome: 'ok' }),
		)
	})

	it('on a quota refusal', async () => {
		chargeYoutubeQuota.mockRejectedValueOnce(
			new YoutubeError({ code: 'WORKSPACE_QUOTA_EXHAUSTED', message: 'used up' }),
		)
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const client = await connect()

		const result = await call(client)

		expect(result.isError).toBe(true)
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'quota_blocked' }),
		)
	})

	it('when YouTube is not connected', async () => {
		getIntegrationCredential.mockResolvedValue(null)
		const client = await connect()

		await call(client)

		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'not_connected' }),
		)
	})
})
