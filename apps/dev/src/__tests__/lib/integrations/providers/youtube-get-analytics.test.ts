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

const callReport = (client: Client, args: Record<string, unknown>) =>
	client.callTool({ name: 'youtube__get_analytics', arguments: args })

const text = (result: Awaited<ReturnType<Client['callTool']>>) =>
	JSON.parse((result.content as Array<{ text: string }>)[0].text)

const REPORT = {
	kind: 'youtubeAnalytics#resultTable',
	columnHeaders: [{ name: 'day', columnType: 'DIMENSION', dataType: 'STRING' }],
	rows: [['2026-10-01', 12]],
	someFutureGoogleField: { nested: true },
}

const base = { start_date: '2026-10-01', end_date: '2026-10-31', metrics: ['views'] }

describe('youtube__get_analytics', () => {
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

	it('calls reports.query for the own channel, charges the analytics bucket and returns the body unchanged', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(REPORT), { status: 200 }))
		const client = await connect()

		const result = await callReport(client, { ...base, dimensions: ['day'] })

		expect(result.isError).toBeUndefined()
		expect(text(result)).toEqual(REPORT)
		const url = new URL(String(fetchSpy.mock.calls[0][0]))
		expect(url.origin + url.pathname).toBe('https://youtubeanalytics.googleapis.com/v2/reports')
		expect(url.searchParams.get('ids')).toBe('channel==MINE')
		expect(url.searchParams.get('startDate')).toBe('2026-10-01')
		expect(url.searchParams.get('endDate')).toBe('2026-10-31')
		expect(url.searchParams.get('metrics')).toBe('views')
		expect(url.searchParams.get('dimensions')).toBe('day')
		expect(url.searchParams.get('maxResults')).toBe('200')
		expect(chargeYoutubeQuota).toHaveBeenCalledWith(expect.anything(), 'ws-1', 1, 'analytics')
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'get_analytics', outcome: 'ok' }),
		)
	})

	it('runs a retention report for one video', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(new Response(JSON.stringify(REPORT), { status: 200 }))
		const client = await connect()

		await callReport(client, {
			...base,
			metrics: ['audienceWatchRatio'],
			dimensions: ['elapsedVideoTimeRatio'],
			video_id: 'dQw4w9WgXcQ',
		})

		const url = new URL(String(fetchSpy.mock.calls[0][0]))
		expect(url.searchParams.get('filters')).toBe('video==dQw4w9WgXcQ')
		expect(url.searchParams.get('dimensions')).toBe('elapsedVideoTimeRatio')
	})

	it('refuses what is outside the rules before any credential, quota or Google call', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const client = await connect()

		const refused = [
			{ ...base, metrics: ['estimatedRevenue'] },
			{ ...base, dimensions: ['country'] },
			{ ...base, end_date: '2027-03-01' },
			{ ...base, max_results: 201 },
			{ ...base, dimensions: ['elapsedVideoTimeRatio'] },
		]
		for (const args of refused) {
			const result = await callReport(client, args)
			expect(result.isError).toBe(true)
			expect(text(result).error.code).toBe('INVALID_INPUT')
		}
		expect(getIntegrationCredential).not.toHaveBeenCalled()
		expect(chargeYoutubeQuota).not.toHaveBeenCalled()
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(refused.length)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'get_analytics', outcome: 'invalid_input' }),
		)
	})

	it('serves a repeat report from the cache at zero units', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValue(new Response(JSON.stringify(REPORT), { status: 200 }))
		const client = await connect()

		await callReport(client, base)
		const second = await callReport(client, base)

		expect(text(second)).toEqual(REPORT)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(1)
	})

	it('reports a quota refusal as quota_blocked without calling Google', async () => {
		const { YoutubeError } = await import('../../../../lib/integrations/providers/youtube/errors')
		chargeYoutubeQuota.mockRejectedValueOnce(
			new YoutubeError({
				code: 'QUOTA_EXHAUSTED',
				message: 'The YouTube Analytics daily quota is used up.',
			}),
		)
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const client = await connect()

		const result = await callReport(client, base)

		expect(text(result).error.code).toBe('QUOTA_EXHAUSTED')
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'quota_blocked' }),
		)
	})

	it('asks for a reconnect when the grant has no Analytics scope', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(
				JSON.stringify({
					error: { message: 'Secret', errors: [{ reason: 'insufficientPermissions' }] },
				}),
				{ status: 403 },
			),
		)
		const client = await connect()

		const result = await callReport(client, base)

		expect(result.isError).toBe(true)
		expect(text(result).error.code).toBe('RECONSENT_REQUIRED')
		expect(JSON.stringify(text(result))).not.toContain('Secret')
	})

	it('puts no response content in any other error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			new Response(JSON.stringify({ error: { message: 'Secret channel title', errors: [] } }), {
				status: 500,
			}),
		)
		const client = await connect()

		const result = await callReport(client, base)

		expect(result.isError).toBe(true)
		expect(JSON.stringify(text(result))).not.toContain('Secret channel title')
	})

	it('is classified as a read tool', async () => {
		const { classifyTool } = await import('../../../../lib/integrations/tool-kinds')
		expect(classifyTool('youtube', 'youtube__get_analytics')).toBe('read')
	})
})
