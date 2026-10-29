import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import downloadCassette from './cassettes/get-file-bytes.json'
import { replayDownloadCassette } from './download-cassette'

vi.mock('../../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const getToken = vi.fn()
vi.mock('../../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

const capturePosthog = vi.fn()
vi.mock('../../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthog(...args),
}))

const captureTrace = vi.fn()
vi.mock('../../../../../lib/analytics/mcp-tool-calls', async (orig) => ({
	...(await orig<typeof import('../../../../../lib/analytics/mcp-tool-calls')>()),
	captureMcpToolCall: (...args: unknown[]) => captureTrace(...args),
}))

import { createGoogleDriveMcpServer } from '../../../../../lib/integrations/providers/google-drive/mcp-server'
import {
	LARGE_FILE_THRESHOLD_BYTES,
	downloadStorageKey,
	getFileBytes,
} from '../../../../../lib/integrations/providers/google-drive/tools/get-file-bytes'

/** Storage double that drains the stream like Upload does and keeps only a digest of what it saw. */
function drainingStorage() {
	const seen = { key: '', isStream: false, bytes: 0, sha256: '' }
	const put = vi.fn(async (key: string, data: unknown) => {
		seen.key = key
		seen.isStream = data instanceof Readable
		const hash = createHash('sha256')
		for await (const chunk of data as Readable) {
			seen.bytes += chunk.length
			hash.update(chunk)
		}
		seen.sha256 = hash.digest('hex')
	})
	return { storage: { put } as never, put, seen }
}

const MB = 1024 * 1024
const ctxBase = { db: {} as never, workspaceId: 'ws-1', actorId: 'actor-1' }
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex')

function streamOf(totalBytes: number, chunkBytes = MB): ReadableStream<Uint8Array> {
	let sent = 0
	return new ReadableStream<Uint8Array>({
		pull(controller) {
			if (sent >= totalBytes) return controller.close()
			const n = Math.min(chunkBytes, totalBytes - sent)
			sent += n
			controller.enqueue(new Uint8Array(n).fill(7))
		},
	})
}

beforeEach(() => {
	getToken.mockReset().mockResolvedValue({ accessToken: 'tok', integrationId: 'int-1' })
	capturePosthog.mockReset()
	captureTrace.mockReset()
})
afterEach(() => vi.restoreAllMocks())

describe('getFileBytes (cassette)', () => {
	it('streams a binary file to the downloads key and returns a handle with the sha256, never bytes', async () => {
		const fetchSpy = replayDownloadCassette(downloadCassette)
		const { storage, put, seen } = drainingStorage()

		const out = await getFileBytes({ ...ctxBase, storage }, { fileId: '1PdF' })

		const expected = Buffer.from('JVBERi0xLjQKJSVFT0YK', 'base64')
		expect(out).toEqual({
			fileId: '1PdF',
			name: 'Q3 board pack.pdf',
			mimeType: 'application/pdf',
			sizeBytes: expected.length,
			storageUrl: 'workspaces/ws-1/integrations/google-drive/downloads/1PdF',
			sha256: sha(expected),
		})
		expect(put).toHaveBeenCalledTimes(1)
		expect(seen.key).toBe(downloadStorageKey('ws-1', '1PdF'))
		expect(seen.isStream).toBe(true)
		expect(seen.sha256).toBe(out.sha256)
		const media = new URL(String(fetchSpy.mock.calls[1]?.[0]))
		expect(media.pathname).toBe('/drive/v3/files/1PdF')
		expect(media.searchParams.get('alt')).toBe('media')
		expect(capturePosthog).toHaveBeenCalledWith(
			'drive_file_downloaded',
			'actor-1',
			expect.objectContaining({
				provider: 'google-drive',
				workspace_id: 'ws-1',
				size_bytes: expected.length,
				exported: false,
				large_file: false,
			}),
		)
	})

	it('ignores exportMimeType for a binary file', async () => {
		const fetchSpy = replayDownloadCassette(downloadCassette)
		const { storage } = drainingStorage()
		await getFileBytes({ ...ctxBase, storage }, { fileId: '1PdF', exportMimeType: 'text/plain' })
		const media = new URL(String(fetchSpy.mock.calls[1]?.[0]))
		expect(media.pathname).toBe('/drive/v3/files/1PdF')
		expect(media.searchParams.get('alt')).toBe('media')
	})

	it('exports a Google Doc as application/pdf by default', async () => {
		const fetchSpy = replayDownloadCassette(downloadCassette)
		const { storage, seen } = drainingStorage()

		const out = await getFileBytes({ ...ctxBase, storage }, { fileId: '1DoC' })

		const expected = Buffer.from('JVBERi0xLjQKZXhwb3J0Cg==', 'base64')
		expect(out.mimeType).toBe('application/pdf')
		expect(out.sha256).toBe(sha(expected))
		expect(out.sizeBytes).toBe(expected.length)
		expect(seen.key).toBe('workspaces/ws-1/integrations/google-drive/downloads/1DoC')
		const exportUrl = new URL(String(fetchSpy.mock.calls[1]?.[0]))
		expect(exportUrl.pathname).toBe('/drive/v3/files/1DoC/export')
		expect(exportUrl.searchParams.get('mimeType')).toBe('application/pdf')
		expect(capturePosthog).toHaveBeenCalledWith(
			'drive_file_downloaded',
			'actor-1',
			expect.objectContaining({ exported: true }),
		)
	})

	it('exports a Google Sheet as text/csv by default', async () => {
		const fetchSpy = replayDownloadCassette(downloadCassette)
		const { storage } = drainingStorage()

		const out = await getFileBytes({ ...ctxBase, storage }, { fileId: '1ShT' })

		expect(out.mimeType).toBe('text/csv')
		const exportUrl = new URL(String(fetchSpy.mock.calls[1]?.[0]))
		expect(exportUrl.pathname).toBe('/drive/v3/files/1ShT/export')
		expect(exportUrl.searchParams.get('mimeType')).toBe('text/csv')
	})

	it('maps a Google 400 on export to EXPORT_FORMAT_UNSUPPORTED and stores nothing', async () => {
		replayDownloadCassette(downloadCassette)
		const { storage, put } = drainingStorage()
		await expect(
			getFileBytes({ ...ctxBase, storage }, { fileId: '1DoC', exportMimeType: 'image/png' }),
		).rejects.toMatchObject({ code: 'EXPORT_FORMAT_UNSUPPORTED', providerStatus: 400 })
		expect(put).not.toHaveBeenCalled()
	})
})

describe('getFileBytes (rules)', () => {
	const client = (meta: object, body: ReadableStream<Uint8Array> = streamOf(10)) => ({
		getFileMetadata: vi.fn(async () => ({ id: 'f1', name: 'n', mimeType: 'video/mp4', ...meta })),
		openContent: vi.fn(async () => body),
	})

	it('uses an explicit exportMimeType over the default', async () => {
		const c = client({ mimeType: 'application/vnd.google-apps.document' })
		const { storage } = drainingStorage()
		const out = await getFileBytes(
			{ ...ctxBase, storage, downloadClient: c },
			{ fileId: 'f1', exportMimeType: 'text/plain' },
		)
		expect(c.openContent).toHaveBeenCalledWith('tok', 'f1', { exportMimeType: 'text/plain' })
		expect(out.mimeType).toBe('text/plain')
	})

	it('exports a Google Slides deck as application/pdf by default', async () => {
		const c = client({ mimeType: 'application/vnd.google-apps.presentation' })
		const { storage } = drainingStorage()
		await getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'f1' })
		expect(c.openContent).toHaveBeenCalledWith('tok', 'f1', { exportMimeType: 'application/pdf' })
	})

	it('rejects a native type with no default (Drawing) as EXPORT_FORMAT_UNSUPPORTED without opening content', async () => {
		const c = client({ mimeType: 'application/vnd.google-apps.drawing' })
		const { storage, put } = drainingStorage()
		await expect(
			getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'f1' }),
		).rejects.toMatchObject({ code: 'EXPORT_FORMAT_UNSUPPORTED' })
		expect(c.openContent).not.toHaveBeenCalled()
		expect(put).not.toHaveBeenCalled()
	})

	it('rejects a trashed file as FILE_TRASHED', async () => {
		const c = client({ trashed: true })
		const { storage } = drainingStorage()
		await expect(
			getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'f1' }),
		).rejects.toMatchObject({ code: 'FILE_TRASHED' })
		expect(c.openContent).not.toHaveBeenCalled()
	})

	it.each([
		['folder', 'application/vnd.google-apps.folder'],
		['shortcut', 'application/vnd.google-apps.shortcut'],
	])('rejects a %s as INVALID_INPUT', async (_label, mimeType) => {
		const c = client({ mimeType })
		const { storage } = drainingStorage()
		await expect(
			getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'f1' }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(c.openContent).not.toHaveBeenCalled()
	})

	it.each(['../other', 'a/b', 'a b', ''])(
		'rejects fileId %j before any token or Drive call',
		async (fileId) => {
			const fetchSpy = vi.spyOn(globalThis, 'fetch')
			const { storage } = drainingStorage()
			await expect(getFileBytes({ ...ctxBase, storage }, { fileId })).rejects.toMatchObject({
				code: 'INVALID_INPUT',
			})
			expect(getToken).not.toHaveBeenCalled()
			expect(fetchSpy).not.toHaveBeenCalled()
		},
	)

	it('answers with a clean error when no storage is wired', async () => {
		await expect(getFileBytes(ctxBase, { fileId: 'f1' })).rejects.toMatchObject({
			code: 'PROVIDER_ERROR',
		})
		expect(getToken).not.toHaveBeenCalled()
	})

	it('maps a Drive 404 to FILE_NOT_FOUND and stores nothing', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValue(
			new Response(JSON.stringify({ error: { errors: [{ reason: 'notFound' }] } }), {
				status: 404,
			}),
		)
		const { storage, put } = drainingStorage()
		await expect(getFileBytes({ ...ctxBase, storage }, { fileId: 'gone' })).rejects.toMatchObject({
			code: 'FILE_NOT_FOUND',
		})
		expect(put).not.toHaveBeenCalled()
	})

	it('reports UPLOAD_FAILED, with no handle, when the stream dies mid-download', async () => {
		let sent = 0
		const dying = new ReadableStream<Uint8Array>({
			pull(controller) {
				if (sent++ < 3) controller.enqueue(new Uint8Array(1024))
				else controller.error(new Error('socket hang up'))
			},
		})
		const { storage } = drainingStorage()
		await expect(
			getFileBytes({ ...ctxBase, storage, downloadClient: client({}, dying) }, { fileId: 'f1' }),
		).rejects.toMatchObject({ code: 'UPLOAD_FAILED' })
		expect(capturePosthog).not.toHaveBeenCalled()
	})

	it('tags a file at the large-file threshold with LARGE_FILE_STREAMED_TO_STORAGE as a success', async () => {
		const c = client({}, streamOf(LARGE_FILE_THRESHOLD_BYTES))
		const { storage } = drainingStorage()
		const out = await getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'f1' })
		expect(out.sizeBytes).toBe(LARGE_FILE_THRESHOLD_BYTES)
		expect(out.tag).toBe('LARGE_FILE_STREAMED_TO_STORAGE')
		expect(capturePosthog).toHaveBeenCalledWith(
			'drive_file_downloaded',
			'actor-1',
			expect.objectContaining({ large_file: true }),
		)
	})

	it('does not tag a file just under the threshold', async () => {
		const c = client({}, streamOf(LARGE_FILE_THRESHOLD_BYTES - 1))
		const { storage } = drainingStorage()
		const out = await getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'f1' })
		expect(out.tag).toBeUndefined()
	})
})

describe('getFileBytes (S14 memory bound, synthetic 2 GB source)', () => {
	it('moves 2 GB through the tool with RSS growth under 200 MB', async () => {
		const TOTAL = 2 * 1024 * MB
		const c = {
			getFileMetadata: vi.fn(async () => ({ id: 'big', name: 'rec.mp4', mimeType: 'video/mp4' })),
			openContent: vi.fn(async () => streamOf(TOTAL)),
		}
		const { storage } = drainingStorage()

		global.gc?.()
		const baseline = process.memoryUsage().rss
		let peak = baseline
		const sampler = setInterval(() => {
			peak = Math.max(peak, process.memoryUsage().rss)
		}, 20)
		let out: Awaited<ReturnType<typeof getFileBytes>>
		try {
			out = await getFileBytes({ ...ctxBase, storage, downloadClient: c }, { fileId: 'big' })
		} finally {
			clearInterval(sampler)
			peak = Math.max(peak, process.memoryUsage().rss)
		}

		expect(out.sizeBytes).toBe(TOTAL)
		expect(out.tag).toBe('LARGE_FILE_STREAMED_TO_STORAGE')
		expect(peak - baseline).toBeLessThan(200 * MB)
	}, 300_000)
})

describe('google_drive__get_file_bytes over MCP', () => {
	async function connect(storage?: unknown) {
		const server = createGoogleDriveMcpServer({
			db: {} as never,
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			sessionId: 'sess-1',
			storage: storage as never,
		})
		const [clientT, serverT] = InMemoryTransport.createLinkedPair()
		const client = new Client({ name: 'test', version: '0.0.0' })
		await Promise.all([server.connect(serverT), client.connect(clientT)])
		return client
	}
	const textOf = (res: unknown) =>
		JSON.parse((res as { content: Array<{ text: string }> }).content[0]?.text ?? 'null')

	it('schema: fileId required, exportMimeType optional', async () => {
		const client = await connect()
		const tool = (await client.listTools()).tools.find(
			(t) => t.name === 'google_drive__get_file_bytes',
		)
		const schema = tool?.inputSchema as { required?: string[]; properties: Record<string, unknown> }
		expect(schema.required).toEqual(['fileId'])
		expect(Object.keys(schema.properties).sort()).toEqual(['exportMimeType', 'fileId'])
		expect(tool?.description).toContain('never the bytes')
	})

	it('rejects an empty fileId at the Zod layer without touching Drive or the token', async () => {
		const client = await connect(drainingStorage().storage)
		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const res = await client.callTool({
			name: 'google_drive__get_file_bytes',
			arguments: { fileId: '' },
		})
		expect(res.isError).toBe(true)
		expect(fetchSpy).not.toHaveBeenCalled()
		expect(getToken).not.toHaveBeenCalled()
	})

	it('returns the handle as JSON and records one trace with argument key names only', async () => {
		replayDownloadCassette(downloadCassette)
		const { storage } = drainingStorage()
		const client = await connect(storage)

		const res = await client.callTool({
			name: 'google_drive__get_file_bytes',
			arguments: { fileId: '1PdF' },
		})

		expect(res.isError).toBeFalsy()
		const body = textOf(res)
		expect(Object.keys(body).sort()).toEqual([
			'fileId',
			'mimeType',
			'name',
			'sha256',
			'sizeBytes',
			'storageUrl',
		])
		expect(captureTrace).toHaveBeenCalledTimes(1)
		const trace = (captureTrace.mock.calls[0] as unknown[])[1] as Record<string, unknown>
		expect(trace).toMatchObject({
			toolName: 'google_drive__get_file_bytes',
			argKeys: ['fileId'],
			ok: true,
			errorClass: null,
			sessionSource: 'maskin-session',
		})
		expect(JSON.stringify(trace)).not.toContain('1PdF')
	})

	it('surfaces a failed download as an isError envelope and an ok:false trace', async () => {
		replayDownloadCassette(downloadCassette)
		const client = await connect(drainingStorage().storage)
		const res = await client.callTool({
			name: 'google_drive__get_file_bytes',
			arguments: { fileId: '1DoC', exportMimeType: 'image/png' },
		})
		expect(res.isError).toBe(true)
		expect(textOf(res).error.code).toBe('EXPORT_FORMAT_UNSUPPORTED')
		const trace = (captureTrace.mock.calls[0] as unknown[])[1] as Record<string, unknown>
		expect(trace).toMatchObject({ ok: false, errorClass: 'EXPORT_FORMAT_UNSUPPORTED' })
	})
})
