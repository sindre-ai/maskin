import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { beforeEach, describe, expect, it, vi } from 'vitest'
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

import {
	commentInputShape,
	registerDriveWriteTools,
	writeFileInputShape,
} from '../../../../lib/integrations/providers/google-drive/write-tools'
import { googleError, jsonResponse } from './google-drive-fakes'

type Handler = (
	args: unknown,
	extra: unknown,
) => Promise<{
	isError?: boolean
	content: Array<{ type: string; text: string }>
}>

function setup(fetchImpl: typeof fetch) {
	const server = new McpServer({ name: 't', version: '0' }, { capabilities: { tools: {} } })
	registerDriveWriteTools(server, {
		workspaceId: 'ws-1',
		actorId: 'actor-1',
		getAccessToken: async () => 'ya29.test',
		fetchImpl,
		sleep: async () => {},
	})
	const tools = (
		server as unknown as {
			_registeredTools: Record<string, { handler: Handler; description?: string }>
		}
	)._registeredTools
	return tools
}

beforeEach(() => capturePosthogEventMock.mockClear())

describe('registration', () => {
	it('registers both tools and documents the Doc and Sheet body shapes', () => {
		const tools = setup((async () => jsonResponse({})) as unknown as typeof fetch)
		expect(Object.keys(tools).sort()).toEqual([
			'google_drive__comment_on_document',
			'google_drive__write_file',
		])
		const description = tools.google_drive__write_file?.description ?? ''
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

describe('tool calls', () => {
	it('write_file returns the output shape and emits drive_file_written', async () => {
		const tools = setup((async () =>
			jsonResponse({
				id: 'f1',
				name: 'a.txt',
				mimeType: 'text/plain',
				webViewLink: 'https://x',
				version: '2',
			})) as unknown as typeof fetch)
		const res = await tools.google_drive__write_file?.handler(
			{ name: 'a.txt', mimeType: 'text/plain', content: 'hi' },
			{},
		)
		expect(res?.isError).toBeUndefined()
		expect(JSON.parse(res?.content[0]?.text ?? '')).toEqual({
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
	})

	it('write_file surfaces PERMISSION_DENIED as an error envelope and emits nothing', async () => {
		const tools = setup((async () =>
			googleError(403, 'nope', 'insufficientFilePermissions')) as unknown as typeof fetch)
		const res = await tools.google_drive__write_file?.handler(
			{ name: 'a.txt', mimeType: 'text/plain', content: 'hi' },
			{},
		)
		expect(res?.isError).toBe(true)
		expect(JSON.parse(res?.content[0]?.text ?? '').error).toMatchObject({
			code: 'PERMISSION_DENIED',
			provider_status: 403,
		})
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('comment_on_document returns the output shape and emits drive_comment_created', async () => {
		const tools = setup((async () =>
			jsonResponse({
				id: 'c1',
				createdTime: '2026-10-05T10:00:00Z',
				htmlContent: '<p>x</p>',
			})) as unknown as typeof fetch)
		const res = await tools.google_drive__comment_on_document?.handler(
			{ fileId: 'f', content: 'x' },
			{},
		)
		expect(JSON.parse(res?.content[0]?.text ?? '')).toEqual({
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
		const tools = setup((async () =>
			googleError(
				403,
				'Request had insufficient authentication scopes.',
				'insufficientPermissions',
				{
					details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
				},
			)) as unknown as typeof fetch)
		const res = await tools.google_drive__comment_on_document?.handler(
			{ fileId: 'f', content: 'x' },
			{},
		)
		expect(res?.isError).toBe(true)
		expect(JSON.parse(res?.content[0]?.text ?? '').error.code).toBe('SCOPE_INSUFFICIENT')
	})

	it('does not leak unexpected exceptions', async () => {
		const tools = setup((async () => {
			throw new Error('socket secret=abc')
		}) as unknown as typeof fetch)
		const res = await tools.google_drive__comment_on_document?.handler(
			{ fileId: 'f', content: 'x' },
			{},
		)
		expect(res?.isError).toBe(true)
		expect(res?.content[0]?.text).not.toContain('secret=abc')
	})
})
