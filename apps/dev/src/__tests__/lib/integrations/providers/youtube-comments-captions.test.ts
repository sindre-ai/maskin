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
import { classifyTool } from '../../../../lib/integrations/tool-kinds'

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

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const payload = (result: Awaited<ReturnType<Client['callTool']>>) =>
	JSON.parse((result.content as Array<{ text: string }>)[0].text)
const urlOf = (call: unknown[]) => new URL(String(call[0]))

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

describe('youtube__list_comments', () => {
	const call = (client: Client, args: Record<string, unknown> = {}) =>
		client.callTool({ name: 'youtube__list_comments', arguments: { video_id: 'vid1', ...args } })

	it('reads one page of commentThreads for the video, 1 unit', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(json({ items: [{ id: 't1' }, { id: 't2' }] }))
		const client = await connect()

		const result = await call(client)

		expect(payload(result)).toEqual({
			items: [{ id: 't1' }, { id: 't2' }],
			pages_read: 1,
			next_page_token: null,
		})
		const url = urlOf(fetchSpy.mock.calls[0])
		expect(url.pathname).toBe('/youtube/v3/commentThreads')
		expect(Object.fromEntries(url.searchParams)).toEqual({
			part: 'snippet,replies',
			videoId: 'vid1',
			maxResults: '100',
			order: 'time',
			textFormat: 'plainText',
		})
		expect(chargeYoutubeQuota).toHaveBeenCalledWith(expect.anything(), 'ws-1', 1, 'data')
	})

	it('follows next page tokens up to the requested pages and hands back the rest', async () => {
		const fetchSpy = vi
			.spyOn(globalThis, 'fetch')
			.mockResolvedValueOnce(json({ items: [{ id: 'a' }], nextPageToken: 'p2' }))
			.mockResolvedValueOnce(json({ items: [{ id: 'b' }], nextPageToken: 'p3' }))
			.mockResolvedValueOnce(json({ items: [{ id: 'c' }], nextPageToken: 'p4' }))
		const client = await connect()

		const result = await call(client, { pages: 3, max_results: 50, order: 'relevance' })

		expect(payload(result)).toEqual({
			items: [{ id: 'a' }, { id: 'b' }, { id: 'c' }],
			pages_read: 3,
			next_page_token: 'p4',
		})
		expect(fetchSpy).toHaveBeenCalledTimes(3)
		expect(urlOf(fetchSpy.mock.calls[0]).searchParams.has('pageToken')).toBe(false)
		expect(urlOf(fetchSpy.mock.calls[1]).searchParams.get('pageToken')).toBe('p2')
		expect(urlOf(fetchSpy.mock.calls[2]).searchParams.get('pageToken')).toBe('p3')
		expect(urlOf(fetchSpy.mock.calls[2]).searchParams.get('maxResults')).toBe('50')
		expect(urlOf(fetchSpy.mock.calls[2]).searchParams.get('order')).toBe('relevance')
		expect(chargeYoutubeQuota).toHaveBeenCalledTimes(3)
	})

	it('stops early when there is no next page', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ items: [] }))
		const client = await connect()

		const result = await call(client, { pages: 3 })

		expect(payload(result).pages_read).toBe(1)
		expect(fetchSpy).toHaveBeenCalledTimes(1)
	})

	it('continues from a page_token', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(json({ items: [] }))
		const client = await connect()

		await call(client, { page_token: 'p4' })

		expect(urlOf(fetchSpy.mock.calls[0]).searchParams.get('pageToken')).toBe('p4')
	})

	it.each([{ pages: 4 }, { max_results: 101 }, { pages: 0 }])(
		'refuses %o without calling Google',
		async (args) => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch')
			const client = await connect()

			const result = await call(client, args)

			expect(result.isError).toBe(true)
			expect(fetchSpy).not.toHaveBeenCalled()
		},
	)

	it('returns comments-disabled as a normalized error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			json({ error: { errors: [{ reason: 'commentsDisabled' }] } }, 403),
		)
		const client = await connect()

		const result = await call(client)

		expect(result.isError).toBe(true)
		expect(payload(result).error).toMatchObject({
			code: 'PERMISSION_DENIED',
			reason: 'commentsDisabled',
		})
	})

	it('emits one youtube_tool_called for part 2 with no comment text', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(
			json({
				items: [{ snippet: { topLevelComment: { snippet: { textDisplay: 'Secret text' } } } }],
			}),
		)
		const client = await connect()

		await call(client)

		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'list_comments', outcome: 'ok' }),
		)
		expect(JSON.stringify(trackYoutubeToolCalled.mock.calls)).not.toContain('Secret text')
	})
})

describe('youtube__get_own_captions', () => {
	const call = (client: Client, args: Record<string, unknown> = {}) =>
		client.callTool({ name: 'youtube__get_own_captions', arguments: { video_id: 'vid1', ...args } })

	const OWN = { items: [{ id: 'UCown' }] }
	const OWN_VIDEO = { items: [{ snippet: { channelId: 'UCown' } }] }
	const TRACKS = {
		items: [
			{ id: 'asr-en', snippet: { language: 'en', trackKind: 'asr' } },
			{ id: 'std-en', snippet: { language: 'en', trackKind: 'standard' } },
			{ id: 'std-da', snippet: { language: 'da', trackKind: 'standard' } },
		],
	}
	const SRT = '1\n00:00:00,000 --> 00:00:02,000\nHello\n'

	function stubGoogle(overrides: { video?: unknown; tracks?: Response; download?: Response } = {}) {
		return vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
			const url = new URL(String(input))
			if (url.pathname === '/youtube/v3/channels') return json(OWN)
			if (url.pathname === '/youtube/v3/videos') return json(overrides.video ?? OWN_VIDEO)
			if (url.pathname === '/youtube/v3/captions') return overrides.tracks ?? json(TRACKS)
			if (url.pathname.startsWith('/youtube/v3/captions/')) {
				return overrides.download ?? new Response(SRT, { status: 200 })
			}
			throw new Error(`unexpected ${url.pathname}`)
		})
	}

	it('returns the standard track as SRT text and charges 1 + 1 + 50 + 200 units', async () => {
		const fetchSpy = stubGoogle()
		const client = await connect()

		const result = await call(client)

		expect(payload(result)).toEqual({
			video_id: 'vid1',
			track: { id: 'std-en', language: 'en', kind: 'standard' },
			format: 'srt',
			text: SRT,
		})
		const download = urlOf(fetchSpy.mock.calls[3])
		expect(download.pathname).toBe('/youtube/v3/captions/std-en')
		expect(download.searchParams.get('tfmt')).toBe('srt')
		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1, 1, 50, 200])
	})

	it('picks the requested language and format', async () => {
		const fetchSpy = stubGoogle()
		const client = await connect()

		const result = await call(client, { language: 'da', format: 'vtt' })

		expect(payload(result).track.id).toBe('std-da')
		const download = urlOf(fetchSpy.mock.calls[3])
		expect(download.pathname).toBe('/youtube/v3/captions/std-da')
		expect(download.searchParams.get('tfmt')).toBe('vtt')
	})

	it('names the available languages when the requested one is missing', async () => {
		stubGoogle()
		const client = await connect()

		const result = await call(client, { language: 'fr' })

		expect(result.isError).toBe(true)
		expect(payload(result).error).toMatchObject({
			code: 'NOT_FOUND',
			hint: 'Available languages: en, da.',
		})
		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1, 1, 50])
	})

	it('refuses a video on another channel before any caption call, and charges no caption units', async () => {
		const fetchSpy = stubGoogle({ video: { items: [{ snippet: { channelId: 'UCother' } }] } })
		const client = await connect()

		const result = await call(client)

		expect(result.isError).toBe(true)
		expect(payload(result).error).toMatchObject({
			code: 'PERMISSION_DENIED',
			message: 'This video is not on the connected channel.',
		})
		const paths = fetchSpy.mock.calls.map((c) => urlOf(c).pathname)
		expect(paths).toEqual(['/youtube/v3/channels', '/youtube/v3/videos'])
		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1, 1])
	})

	it('reports an unknown video as not found', async () => {
		const fetchSpy = stubGoogle({ video: { items: [] } })
		const client = await connect()

		const result = await call(client)

		expect(payload(result).error.code).toBe('NOT_FOUND')
		expect(fetchSpy.mock.calls.map((c) => urlOf(c).pathname)).not.toContain('/youtube/v3/captions')
	})

	it('reports a video with no caption tracks', async () => {
		stubGoogle({ tracks: json({ items: [] }) })
		const client = await connect()

		const result = await call(client)

		expect(payload(result).error).toMatchObject({
			code: 'NOT_FOUND',
			message: 'This video has no caption tracks.',
		})
	})

	it('does not cache the caption calls: a repeat read downloads again', async () => {
		const fetchSpy = stubGoogle()
		const client = await connect()

		await call(client)
		await call(client)

		const paths = fetchSpy.mock.calls.map((c) => urlOf(c).pathname)
		expect(paths.filter((p) => p === '/youtube/v3/captions')).toHaveLength(2)
		expect(paths.filter((p) => p === '/youtube/v3/captions/std-en')).toHaveLength(2)
		// The two ownership reads are cached and are not charged twice.
		expect(chargeYoutubeQuota.mock.calls.map((c) => c[2])).toEqual([1, 1, 50, 200, 50, 200])
	})

	it('asks for a reconnect when the grant has no caption scope', async () => {
		stubGoogle({
			tracks: json({ error: { errors: [{ reason: 'insufficientPermissions' }] } }, 403),
		})
		const client = await connect()

		const result = await call(client)

		expect(result.isError).toBe(true)
		expect(payload(result).error).toMatchObject({
			code: 'RECONSENT_REQUIRED',
			reason: 'insufficientPermissions',
		})
	})

	it('emits one youtube_tool_called for part 2 and never the caption text', async () => {
		stubGoogle()
		const client = await connect()

		await call(client)

		expect(trackYoutubeToolCalled).toHaveBeenCalledTimes(1)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'get_own_captions', outcome: 'ok' }),
		)
		expect(JSON.stringify(trackYoutubeToolCalled.mock.calls)).not.toContain('Hello')
	})
})

describe('tool kinds', () => {
	it('both tools are reads', () => {
		for (const tool of ['youtube__list_comments', 'youtube__get_own_captions']) {
			expect(classifyTool('youtube', tool)).toBe('read')
		}
	})
})
