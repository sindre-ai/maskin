import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))
vi.mock('../../../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))
const { getTokenMock } = vi.hoisted(() => ({ getTokenMock: vi.fn() }))
vi.mock('../../../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getTokenMock(...args),
}))
const captureTrace = vi.fn()
vi.mock('../../../../lib/analytics/mcp-tool-calls', async (orig) => ({
	...(await orig<typeof import('../../../../lib/analytics/mcp-tool-calls')>()),
	captureMcpToolCall: (...args: unknown[]) => captureTrace(...args),
}))

import { DriveError } from '../../../../lib/integrations/providers/google-drive/errors'
import { createGoogleDriveMcpServer } from '../../../../lib/integrations/providers/google-drive/mcp-server'
import {
	commentInputShape,
	writeFileInputShape,
} from '../../../../lib/integrations/providers/google-drive/write-tools'
import { fakeResumableDrive, googleError, jsonResponse, sha256 } from './google-drive-fakes'

/** Boots the real Drive MCP server in memory; Google is whatever fetchImpl says. */
async function setup(fetchImpl: () => Promise<Response>, storage?: unknown) {
	vi.spyOn(globalThis, 'fetch').mockImplementation(fetchImpl as typeof fetch)
	const server = createGoogleDriveMcpServer({
		db: {} as never,
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		storage: storage as never,
	})
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test', version: '0.0.0' })
	await Promise.all([server.connect(serverT), client.connect(clientT)])
	return {
		client,
		call: async (name: string, args: Record<string, unknown>) => {
			const res = (await client.callTool({ name, arguments: args })) as {
				isError?: boolean
				content: Array<{ text: string }>
			}
			return { isError: res.isError, body: JSON.parse(res.content[0]?.text ?? 'null') }
		},
	}
}

beforeEach(() => {
	getTokenMock.mockReset().mockResolvedValue({ accessToken: 'ya29.test', integrationId: 'int-1' })
	capturePosthogEventMock.mockClear()
	captureTrace.mockClear()
})
afterEach(() => vi.restoreAllMocks())

describe('registration', () => {
	it('registers both write tools and documents the Doc and Sheet body shapes', async () => {
		const { client } = await setup(async () => jsonResponse({}))
		const { tools } = await client.listTools()
		const names = tools.map((t) => t.name)
		expect(names).toContain('google_drive__write_file')
		expect(names).toContain('google_drive__comment_on_document')
		const description = tools.find((t) => t.name === 'google_drive__write_file')?.description ?? ''
		expect(description).toContain('{type: "heading"')
		expect(description).toContain('{type: "table", cells: string[][]}')
		expect(description).toContain('{values: string[][]}')
		expect(description).toContain('{storageUrl')
	})
})

describe('input contracts', () => {
	const writeSchema = z.object(writeFileInputShape)
	const commentSchema = z.object(commentInputShape)

	it('write_file accepts the three content forms and a structured body', () => {
		expect(writeSchema.safeParse({ name: 'a', mimeType: 'text/plain', content: 'x' }).success).toBe(
			true,
		)
		expect(
			writeSchema.safeParse({
				name: 'a',
				mimeType: 'x/y',
				content: { encoding: 'base64', data: 'AA==' },
			}).success,
		).toBe(true)
		expect(
			writeSchema.safeParse({
				name: 'a',
				mimeType: 'x/y',
				content: { storageUrl: 'workspaces/w/f' },
			}).success,
		).toBe(true)
		expect(
			writeSchema.safeParse({
				name: 'a',
				mimeType: 'application/vnd.google-apps.document',
				docStructuredBody: [{ type: 'paragraph', text: 'x' }],
			}).success,
		).toBe(true)
		expect(writeSchema.safeParse({ name: '', mimeType: 'x/y', content: 'x' }).success).toBe(false)
		expect(
			writeSchema.safeParse({
				name: 'a',
				mimeType: 'x/y',
				content: { encoding: 'hex', data: 'AA' },
			}).success,
		).toBe(false)
	})

	it('comment_on_document accepts doc and sheet anchors only', () => {
		expect(commentSchema.safeParse({ fileId: 'f', content: 'c' }).success).toBe(true)
		expect(
			commentSchema.safeParse({
				fileId: 'f',
				content: 'c',
				anchor: { docStartIndex: 0, docEndIndex: 4 },
			}).success,
		).toBe(true)
		expect(
			commentSchema.safeParse({ fileId: 'f', content: 'c', anchor: { sheetRange: 'A1' } }).success,
		).toBe(true)
		expect(
			commentSchema.safeParse({
				fileId: 'f',
				content: 'c',
				anchor: { docStartIndex: 1.5, docEndIndex: 4 },
			}).success,
		).toBe(false)
		expect(commentSchema.safeParse({ fileId: 'f', content: '' }).success).toBe(false)
	})
})

describe('tool calls through the Drive MCP server', () => {
	it('write_file returns the output shape, emits drive_file_written and records a trace', async () => {
		const { call } = await setup(async () =>
			jsonResponse({
				id: 'f1',
				name: 'a.txt',
				mimeType: 'text/plain',
				webViewLink: 'https://x',
				version: '2',
			}),
		)
		const res = await call('google_drive__write_file', {
			name: 'a.txt',
			mimeType: 'text/plain',
			content: 'hi',
		})
		expect(res.isError).toBeFalsy()
		expect(res.body).toEqual({
			fileId: 'f1',
			name: 'a.txt',
			mimeType: 'text/plain',
			webViewLink: 'https://x',
			driveFileVersion: '2',
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith('drive_file_written', 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			mime_type: 'text/plain',
			path: 'multipart',
		})
		expect(captureTrace).toHaveBeenCalledTimes(1)
		expect(captureTrace.mock.calls[0]?.[1]).toMatchObject({
			toolName: 'google_drive__write_file',
			ok: true,
			errorClass: null,
			argKeys: ['content', 'mimeType', 'name'],
		})
	})

	it('write_file surfaces PERMISSION_DENIED as an error envelope and emits no event', async () => {
		const { call } = await setup(async () =>
			googleError(403, 'nope', 'insufficientFilePermissions'),
		)
		const res = await call('google_drive__write_file', {
			name: 'a.txt',
			mimeType: 'text/plain',
			content: 'hi',
		})
		expect(res.isError).toBe(true)
		expect(res.body.error).toMatchObject({ code: 'PERMISSION_DENIED', provider_status: 403 })
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
		expect(captureTrace.mock.calls[0]?.[1]).toMatchObject({
			ok: false,
			errorClass: 'PERMISSION_DENIED',
		})
	})

	it('write_file reports INTEGRATION_MISSING, not a network failure, when no Drive is connected', async () => {
		getTokenMock.mockRejectedValue(
			new DriveError({
				code: 'INTEGRATION_MISSING',
				message: 'No active Google Drive integration.',
			}),
		)
		const fetchSpy = vi.fn()
		const { call } = await setup(fetchSpy as never)
		const res = await call('google_drive__write_file', {
			name: 'a.txt',
			mimeType: 'text/plain',
			content: 'hi',
		})
		expect(res.isError).toBe(true)
		expect(res.body.error.code).toBe('INTEGRATION_MISSING')
		expect(fetchSpy).not.toHaveBeenCalled()
	})

	it('write_file with a storageUrl outside this workspace is INVALID_INPUT and never reads storage', async () => {
		const storage = { get: vi.fn() }
		const { call } = await setup(async () => jsonResponse({}), storage)
		const res = await call('google_drive__write_file', {
			name: 'a.bin',
			mimeType: 'application/octet-stream',
			content: { storageUrl: 'workspaces/ws-2/integrations/google-drive/downloads/x' },
		})
		expect(res.isError).toBe(true)
		expect(res.body.error.code).toBe('INVALID_INPUT')
		expect(storage.get).not.toHaveBeenCalled()
	})

	it('write_file reads a storageUrl through the storage provider and uploads it', async () => {
		const bytes = Buffer.from('from storage')
		const storage = { get: vi.fn(async () => bytes) }
		const drive = fakeResumableDrive()
		const { call } = await setup(drive.fetchImpl as never, storage)
		const res = await call('google_drive__write_file', {
			name: 'b.bin',
			mimeType: 'application/octet-stream',
			content: { storageUrl: 'workspaces/ws-1/integrations/google-drive/downloads/abc' },
		})
		expect(res.isError).toBeFalsy()
		expect(res.body.fileId).toBe('file-1')
		expect(storage.get).toHaveBeenCalledWith(
			'workspaces/ws-1/integrations/google-drive/downloads/abc',
		)
		expect(sha256(drive.received())).toBe(sha256(bytes))
	})

	it('comment_on_document returns the output shape and emits drive_comment_created', async () => {
		const { call } = await setup(async () =>
			jsonResponse({ id: 'c1', createdTime: '2026-10-05T10:00:00Z', htmlContent: '<p>x</p>' }),
		)
		const res = await call('google_drive__comment_on_document', { fileId: 'f', content: 'x' })
		expect(res.body).toEqual({
			commentId: 'c1',
			createdTime: '2026-10-05T10:00:00Z',
			htmlContent: '<p>x</p>',
		})
		expect(capturePosthogEventMock).toHaveBeenCalledWith('drive_comment_created', 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			anchor: 'none',
		})
	})

	it('comment_on_document returns SCOPE_INSUFFICIENT when the scope is missing', async () => {
		const { call } = await setup(async () =>
			googleError(
				403,
				'Request had insufficient authentication scopes.',
				'insufficientPermissions',
				{ details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }] },
			),
		)
		const res = await call('google_drive__comment_on_document', { fileId: 'f', content: 'x' })
		expect(res.isError).toBe(true)
		expect(res.body.error.code).toBe('SCOPE_INSUFFICIENT')
	})

	it('does not leak unexpected exceptions', async () => {
		const { client } = await setup(async () => {
			throw new Error('socket secret=abc')
		})
		const res = (await client.callTool({
			name: 'google_drive__comment_on_document',
			arguments: { fileId: 'f', content: 'x' },
		})) as { isError?: boolean; content: Array<{ text: string }> }
		expect(res.isError).toBe(true)
		expect(res.content[0]?.text).not.toContain('secret=abc')
	})
})
