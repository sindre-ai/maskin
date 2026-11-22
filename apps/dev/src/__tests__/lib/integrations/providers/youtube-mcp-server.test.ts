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

const proposeYoutubeWrite = vi.fn()
vi.mock('../../../../lib/youtube/propose', () => ({
	proposeYoutubeWrite: (...args: unknown[]) => proposeYoutubeWrite(...args),
}))

const prepareUpload = vi.fn()
const prepareVisibilityChange = vi.fn()
const readUploadStatus = vi.fn()
vi.mock('../../../../lib/integrations/providers/youtube/upload-tools', async (importOriginal) => ({
	...(await importOriginal<
		typeof import('../../../../lib/integrations/providers/youtube/upload-tools')
	>()),
	prepareUpload: (...args: unknown[]) => prepareUpload(...args),
	prepareVisibilityChange: (...args: unknown[]) => prepareVisibilityChange(...args),
	readUploadStatus: (...args: unknown[]) => readUploadStatus(...args),
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
		prepareUpload.mockReset()
		prepareVisibilityChange.mockReset()
		readUploadStatus.mockReset()
		trackYoutubeToolCalled.mockReset()
	})

	it('lists the read tools, the seven write tools and the three upload tools', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		expect(tools.map((t) => t.name).sort()).toEqual([
			'youtube__add_to_playlist',
			'youtube__create_playlist',
			'youtube__get_analytics',
			'youtube__get_channel',
			'youtube__get_own_captions',
			'youtube__get_public_channel',
			'youtube__get_public_videos',
			'youtube__get_upload_status',
			'youtube__get_video_stats',
			'youtube__like',
			'youtube__list_comments',
			'youtube__list_recent_videos',
			'youtube__post_comment',
			'youtube__publish_video',
			'youtube__reply_to_comment',
			'youtube__search',
			'youtube__set_thumbnail',
			'youtube__update_video_metadata',
			'youtube__upload_video',
		])
	})

	it('treats upload and publish as writes and the status read as a read', () => {
		expect(classifyTool('youtube', 'youtube__upload_video')).toBe('write')
		expect(classifyTool('youtube', 'youtube__publish_video')).toBe('write')
		expect(classifyTool('youtube', 'youtube__get_upload_status')).toBe('read')
	})

	describe('upload_video and publish_video', () => {
		const FILE_ID = '00000000-0000-4000-8000-000000000001'
		const OBJECT_ID = '00000000-0000-4000-8000-000000000002'

		it('holds the request, returns the pending result and reports pending_approval', async () => {
			prepareUpload.mockResolvedValue({ status: 'pending_approval', action_id: 'a1' })
			const { client } = await connect()
			const result = await client.callTool({
				name: 'youtube__upload_video',
				arguments: { file_id: FILE_ID, object_id: OBJECT_ID, title: 'Launch', ai_generated: true },
			})
			expect(text(result)).toEqual({ status: 'pending_approval', action_id: 'a1' })
			expect(prepareUpload.mock.calls[0]?.[1]).toMatchObject({
				title: 'Launch',
				ai_generated: true,
			})
			expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
				expect.objectContaining({ tool: 'upload_video', outcome: 'pending_approval' }),
			)
		})

		it('has no input that could set the privacy of an upload', async () => {
			const { client } = await connect()
			const { tools } = await client.listTools()
			const upload = tools.find((t) => t.name === 'youtube__upload_video')
			const properties = Object.keys(upload?.inputSchema.properties ?? {})
			for (const name of ['privacy_status', 'privacyStatus', 'visibility', 'publish_at']) {
				expect(properties).not.toContain(name)
			}
		})

		it('rejects a call with a bad file id before any code runs', async () => {
			const { client } = await connect()
			const result = await client.callTool({
				name: 'youtube__upload_video',
				arguments: { file_id: 'not-a-uuid', object_id: OBJECT_ID, title: 'T' },
			})
			expect(result.isError).toBe(true)
			expect(prepareUpload).not.toHaveBeenCalled()
		})

		it('turns a refused request into an invalid_input error the agent can act on', async () => {
			prepareVisibilityChange.mockRejectedValue(
				new YoutubeError({ code: 'INVALID_INPUT', message: 'That time has passed.' }),
			)
			const { client } = await connect()
			const result = await client.callTool({
				name: 'youtube__publish_video',
				arguments: {
					video_id: 'abcDEF12345',
					object_id: OBJECT_ID,
					visibility: 'public',
					publish_at: '2020-01-01T00:00:00Z',
				},
			})
			expect(result.isError).toBe(true)
			expect(text(result).error).toMatchObject({
				code: 'INVALID_INPUT',
				message: 'That time has passed.',
			})
			expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
				expect.objectContaining({ tool: 'publish_video', outcome: 'invalid_input' }),
			)
		})

		it('reads the status without the request', async () => {
			readUploadStatus.mockResolvedValue({ action_id: 'a1', status: 'executed', video_id: 'vid' })
			const { client } = await connect()
			const result = await client.callTool({
				name: 'youtube__get_upload_status',
				arguments: { action_id: FILE_ID },
			})
			expect(text(result)).toMatchObject({ status: 'executed', video_id: 'vid' })
		})
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

	it('search reads search.list in the search bucket for 1 unit, 10 results by default', async () => {
		youtubeRead.mockResolvedValueOnce({ items: [{ id: { videoId: 'abcdefghijk' } }] })
		const { client, ctx } = await connect()

		const result = await client.callTool({
			name: 'youtube__search',
			arguments: { q: 'ai agents' },
		})

		expect(text(result)).toEqual({ items: [{ id: { videoId: 'abcdefghijk' } }] })
		expect(youtubeRead).toHaveBeenCalledWith(ctx, {
			tool: 'youtube__search',
			path: 'search',
			params: { part: 'snippet', q: 'ai agents', type: 'video', maxResults: '10' },
			units: 1,
			bucket: 'search',
		})
	})

	it('search passes the type and a smaller result count through', async () => {
		youtubeRead.mockResolvedValueOnce({ items: [] })
		const { client } = await connect()

		await client.callTool({
			name: 'youtube__search',
			arguments: { q: 'maskin', type: 'channel', max_results: 3 },
		})

		expect(youtubeRead.mock.calls[0][1].params).toEqual({
			part: 'snippet',
			q: 'maskin',
			type: 'channel',
			maxResults: '3',
		})
	})

	it.each([
		['more than 10 results', { q: 'x', max_results: 11 }],
		['an empty query', { q: '   ' }],
		['a type other than video or channel', { q: 'x', type: 'playlist' }],
	])('search refuses %s before any YouTube call', async (_name, args) => {
		const { client } = await connect()

		const result = await client.callTool({ name: 'youtube__search', arguments: args })

		expect(result.isError).toBe(true)
		expect(youtubeRead).not.toHaveBeenCalled()
	})

	it.each([
		['a channel id', 'UCabcdefghijklmnopqrstuv', { id: 'UCabcdefghijklmnopqrstuv' }],
		['a handle', '@maskin', { forHandle: '@maskin' }],
		['a channel URL', 'https://www.youtube.com/@maskin', { forHandle: '@maskin' }],
	])(
		'get_public_channel resolves %s with channels.list, 1 data unit',
		async (_n, channel, lookup) => {
			youtubeRead.mockResolvedValueOnce({ items: [{ id: 'UC1' }] })
			const { client, ctx } = await connect()

			const result = await client.callTool({
				name: 'youtube__get_public_channel',
				arguments: { channel },
			})

			expect(text(result)).toEqual({ items: [{ id: 'UC1' }] })
			expect(youtubeRead).toHaveBeenCalledWith(ctx, {
				tool: 'youtube__get_public_channel',
				path: 'channels',
				params: { part: 'snippet,statistics', ...lookup },
				units: 1,
			})
		},
	)

	it('get_public_channel refuses a custom URL as INVALID_INPUT and reports it as invalid_input', async () => {
		const { client } = await connect()

		const result = await client.callTool({
			name: 'youtube__get_public_channel',
			arguments: { channel: 'https://www.youtube.com/c/maskin' },
		})

		expect(result.isError).toBe(true)
		expect(text(result).error.code).toBe('INVALID_INPUT')
		expect(youtubeRead).not.toHaveBeenCalled()
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'get_public_channel', outcome: 'invalid_input' }),
		)
	})

	it('get_public_videos reads videos.list for the ids, sorted and de-duplicated, 1 unit', async () => {
		youtubeRead.mockResolvedValueOnce({ items: [] })
		const { client, ctx } = await connect()

		await client.callTool({
			name: 'youtube__get_public_videos',
			arguments: { ids: ['bbbbbbbbbbb', 'aaaaaaaaaaa', 'bbbbbbbbbbb'] },
		})

		expect(youtubeRead).toHaveBeenCalledWith(ctx, {
			tool: 'youtube__get_public_videos',
			path: 'videos',
			params: { part: 'snippet,statistics', id: 'aaaaaaaaaaa,bbbbbbbbbbb' },
			units: 1,
		})
	})

	it('get_public_videos accepts 50 ids and refuses 51, an empty list and a URL', async () => {
		youtubeRead.mockResolvedValue({ items: [] })
		const { client } = await connect()
		const ids = (n: number) =>
			Array.from({ length: n }, (_, i) => `id${String(i).padStart(9, '0')}`)

		const fifty = await client.callTool({
			name: 'youtube__get_public_videos',
			arguments: { ids: ids(50) },
		})
		expect(fifty.isError).toBeUndefined()
		expect(youtubeRead).toHaveBeenCalledTimes(1)

		for (const bad of [ids(51), [], ['https://www.youtube.com/watch?v=dQw4w9WgXcQ']]) {
			const result = await client.callTool({
				name: 'youtube__get_public_videos',
				arguments: { ids: bad },
			})
			expect(result.isError).toBe(true)
		}
		expect(youtubeRead).toHaveBeenCalledTimes(1)
	})

	it('reports one event per new tool with its short name and never the query or ids', async () => {
		youtubeRead.mockResolvedValue({ items: [] })
		const { client } = await connect()

		await client.callTool({ name: 'youtube__search', arguments: { q: 'secret topic' } })
		await client.callTool({
			name: 'youtube__get_public_videos',
			arguments: { ids: ['aaaaaaaaaaa'] },
		})

		expect(trackYoutubeToolCalled.mock.calls.map(([e]) => e.tool)).toEqual([
			'search',
			'get_public_videos',
		])
		expect(JSON.stringify(trackYoutubeToolCalled.mock.calls)).not.toContain('secret topic')
		expect(JSON.stringify(trackYoutubeToolCalled.mock.calls)).not.toContain('aaaaaaaaaaa')
	})

	it('gives every tool an optional integration_id and passes it to the read', async () => {
		youtubeRead.mockResolvedValue({ items: [] })
		const { client, ctx } = await connect()
		const { tools } = await client.listTools()
		for (const tool of tools) {
			const schema = tool.inputSchema as {
				properties?: Record<string, unknown>
				required?: string[]
			}
			expect(schema.properties).toHaveProperty('integration_id')
			expect(schema.required ?? []).not.toContain('integration_id')
		}
		const id = '3f0c2c1e-8a3e-4c0e-9d0e-0a1b2c3d4e5f'

		await client.callTool({ name: 'youtube__get_channel', arguments: { integration_id: id } })

		expect(youtubeRead).toHaveBeenCalledWith(
			expect.objectContaining({ ...ctx, integrationId: id }),
			expect.objectContaining({ tool: 'youtube__get_channel' }),
		)
	})

	it('returns the connection list as a tool error when the read asks which account', async () => {
		const connections = [
			{ integration_id: 'int-1', account: 'a@example.com' },
			{ integration_id: 'int-2', account: 'b@example.com' },
		]
		youtubeRead.mockRejectedValueOnce(
			new YoutubeError({ code: 'INTEGRATION_REQUIRED', message: 'which one', connections }),
		)
		const { client } = await connect()

		const result = await client.callTool({ name: 'youtube__get_channel', arguments: {} })

		expect(result.isError).toBe(true)
		expect(text(result).error).toMatchObject({ code: 'INTEGRATION_REQUIRED', connections })
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ outcome: 'invalid_input' }),
		)
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

describe('youtube__list_recent_videos', () => {
	const CHANNEL = { items: [{ contentDetails: { relatedPlaylists: { uploads: 'UU1' } } }] }
	const PLAYLIST = { items: [{ contentDetails: { videoId: 'v1' } }], nextPageToken: 'tok2' }

	beforeEach(() => {
		youtubeRead.mockReset()
		trackYoutubeToolCalled.mockReset()
	})

	it('resolves the uploads playlist from the channel and reads playlistItems, 1 unit', async () => {
		youtubeRead.mockResolvedValueOnce(CHANNEL).mockResolvedValueOnce(PLAYLIST)
		const { client, ctx } = await connect()

		const result = await client.callTool({ name: 'youtube__list_recent_videos', arguments: {} })

		expect(text(result)).toEqual(PLAYLIST)
		expect(youtubeRead).toHaveBeenNthCalledWith(1, ctx, {
			tool: 'youtube__get_channel',
			path: 'channels',
			params: { part: 'snippet,statistics,contentDetails', mine: 'true' },
			units: 1,
		})
		expect(youtubeRead).toHaveBeenNthCalledWith(2, ctx, {
			tool: 'youtube__list_recent_videos',
			path: 'playlistItems',
			params: { part: 'snippet,contentDetails', playlistId: 'UU1', maxResults: '50' },
			units: 1,
		})
	})

	it('passes the page size and page token through', async () => {
		youtubeRead.mockResolvedValueOnce(CHANNEL).mockResolvedValueOnce(PLAYLIST)
		const { client } = await connect()

		await client.callTool({
			name: 'youtube__list_recent_videos',
			arguments: { max_results: 10, page_token: 'tok1' },
		})

		expect(youtubeRead).toHaveBeenLastCalledWith(
			expect.anything(),
			expect.objectContaining({
				params: {
					part: 'snippet,contentDetails',
					playlistId: 'UU1',
					maxResults: '10',
					pageToken: 'tok1',
				},
			}),
		)
	})

	it.each([0, 51])('refuses a page size of %i without calling YouTube', async (max_results) => {
		const { client } = await connect()

		const result = await client.callTool({
			name: 'youtube__list_recent_videos',
			arguments: { max_results },
		})

		expect(result.isError).toBe(true)
		expect(youtubeRead).not.toHaveBeenCalled()
	})

	it('returns a normalized error when the channel has no uploads playlist', async () => {
		youtubeRead.mockResolvedValueOnce({ items: [] })
		const { client } = await connect()

		const result = await client.callTool({ name: 'youtube__list_recent_videos', arguments: {} })

		expect(result.isError).toBe(true)
		expect(text(result).error.code).toBe('PROVIDER_ERROR')
		expect(youtubeRead).toHaveBeenCalledTimes(1)
	})

	it('emits the tool-called event under its short name', async () => {
		youtubeRead.mockResolvedValueOnce(CHANNEL).mockResolvedValueOnce(PLAYLIST)
		const { client } = await connect()

		await client.callTool({ name: 'youtube__list_recent_videos', arguments: {} })

		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool: 'list_recent_videos', outcome: 'ok' }),
		)
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
	it.each([
		'youtube__get_channel',
		'youtube__search',
		'youtube__get_public_channel',
		'youtube__get_public_videos',
	])('classifies %s as a read, so a read-only agent may call it', (tool) => {
		expect(classifyTool('youtube', tool)).toBe('read')
	})

	it('classifies list_recent_videos as a read', () => {
		expect(classifyTool('youtube', 'youtube__list_recent_videos')).toBe('read')
	})

	it('treats a youtube tool nobody classified as a write', () => {
		expect(classifyTool('youtube', 'youtube__upload_video')).toBe('write')
	})
})

describe('youtube write tools', () => {
	const OBJECT_ID = '11111111-1111-4111-8111-111111111111'
	const HELD = {
		action_id: 'action-1',
		status: 'pending',
		expires_at: '2026-11-25T00:00:00.000Z',
		message: 'Held for a person to approve.',
	}

	beforeEach(() => {
		youtubeRead.mockReset()
		proposeYoutubeWrite.mockReset()
		trackYoutubeToolCalled.mockReset()
	})

	it.each([
		['update_video_metadata', { video_id: 'v1', title: 'New' }],
		['set_thumbnail', { video_id: 'v1', file_id: '22222222-2222-4222-8222-222222222222' }],
		['create_playlist', { title: 'Best of', privacy_status: 'private' }],
		['add_to_playlist', { playlist_id: 'PL1', video_id: 'v1' }],
		['post_comment', { video_id: 'v1', text: 'Nice one' }],
		['reply_to_comment', { video_id: 'v1', comment_id: 'c1', text: 'Thanks' }],
		['like', { video_id: 'v1' }],
	] as const)('%s holds the change and returns the action id', async (tool, args) => {
		proposeYoutubeWrite.mockResolvedValueOnce(HELD)
		const { client, ctx } = await connect()

		const result = await client.callTool({
			name: `youtube__${tool}`,
			arguments: { object_id: OBJECT_ID, note: 'why', ...args },
		})

		expect(result.isError).toBeUndefined()
		expect(text(result)).toEqual(HELD)
		expect(proposeYoutubeWrite).toHaveBeenCalledWith(
			ctx,
			{ object_id: OBJECT_ID, note: 'why' },
			{ tool, args },
		)
		// A write tool never reads through the Google client itself.
		expect(youtubeRead).not.toHaveBeenCalled()
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(
			expect.objectContaining({ tool, outcome: 'pending_approval' }),
		)
	})

	it('passes integration_id on to a held write and to an upload, not only to reads', async () => {
		proposeYoutubeWrite.mockResolvedValueOnce(HELD)
		prepareUpload.mockResolvedValueOnce({ status: 'pending_approval', action_id: 'a1' })
		const { client, ctx } = await connect()
		const id = '3f0c2c1e-8a3e-4c0e-9d0e-0a1b2c3d4e5f'

		await client.callTool({
			name: 'youtube__like',
			arguments: { object_id: OBJECT_ID, video_id: 'v1', integration_id: id },
		})
		await client.callTool({
			name: 'youtube__upload_video',
			arguments: {
				file_id: '22222222-2222-4222-8222-222222222222',
				object_id: OBJECT_ID,
				title: 'Launch',
				ai_generated: true,
				integration_id: id,
			},
		})

		expect(proposeYoutubeWrite).toHaveBeenCalledWith(
			expect.objectContaining({ ...ctx, integrationId: id }),
			{ object_id: OBJECT_ID, note: undefined },
			{ tool: 'like', args: { video_id: 'v1' } },
		)
		expect(prepareUpload.mock.calls.at(-1)?.[0]).toMatchObject({ ...ctx, integrationId: id })
	})

	it('marks the write tools as not read-only and the read tools as read-only', async () => {
		const { client } = await connect()
		const { tools } = await client.listTools()
		const byName = new Map(tools.map((t) => [t.name, t]))
		const reads = [
			'youtube__get_channel',
			'youtube__get_own_captions',
			'youtube__get_public_channel',
			'youtube__get_public_videos',
			'youtube__get_upload_status',
			'youtube__list_comments',
			'youtube__search',
		]
		for (const [name, tool] of byName) {
			expect(tool.annotations?.readOnlyHint).toBe(reads.includes(name))
		}
	})

	it('defaults a new playlist to private', async () => {
		proposeYoutubeWrite.mockResolvedValueOnce(HELD)
		const { client } = await connect()
		await client.callTool({
			name: 'youtube__create_playlist',
			arguments: { object_id: OBJECT_ID, title: 'Best of' },
		})
		expect(proposeYoutubeWrite).toHaveBeenCalledWith(expect.anything(), expect.anything(), {
			tool: 'create_playlist',
			args: { title: 'Best of', privacy_status: 'private' },
		})
	})

	it('refuses a call with no object to put the card on', async () => {
		const { client } = await connect()
		const result = await client.callTool({
			name: 'youtube__like',
			arguments: { video_id: 'v1' },
		})
		expect(result.isError).toBe(true)
		expect(proposeYoutubeWrite).not.toHaveBeenCalled()
	})

	it.each([
		['CAP_REACHED', 'quota_blocked'],
		['INVALID_INPUT', 'invalid_input'],
		['NOT_CONNECTED', 'not_connected'],
	] as const)('reports %s as outcome %s', async (code, outcome) => {
		proposeYoutubeWrite.mockRejectedValueOnce(new YoutubeError({ code, message: 'x' }))
		const { client } = await connect()
		const result = await client.callTool({
			name: 'youtube__like',
			arguments: { object_id: OBJECT_ID, video_id: 'v1' },
		})
		expect(result.isError).toBe(true)
		expect(text(result).error.code).toBe(code)
		expect(trackYoutubeToolCalled).toHaveBeenCalledWith(expect.objectContaining({ outcome }))
	})

	it('classifies every write tool as a write, so a read-only agent cannot call it', () => {
		for (const tool of [
			'update_video_metadata',
			'set_thumbnail',
			'create_playlist',
			'add_to_playlist',
			'post_comment',
			'reply_to_comment',
			'like',
		]) {
			expect(classifyTool('youtube', `youtube__${tool}`)).toBe('write')
		}
	})
})
