import { randomBytes } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { DriveWriteError } from '../../../../lib/integrations/providers/google-drive/write-errors'
import { writeFile } from '../../../../lib/integrations/providers/google-drive/write-file'
import {
	fakeResumableDrive,
	googleError,
	jsonResponse,
	makeHttp,
	pieces,
	sha256,
} from './google-drive-fakes'

const MB = 1024 * 1024
const DOC = 'application/vnd.google-apps.document'
const SHEET = 'application/vnd.google-apps.spreadsheet'

interface Call {
	method: string
	url: string
	body?: unknown
}

/** Routes by URL and records every call, like a hand-written cassette. */
function router(handlers: Array<(c: Call) => Response | undefined>) {
	const calls: Call[] = []
	const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
		const raw = init?.body
		const body =
			typeof raw === 'string' ? JSON.parse(raw) : raw ? Buffer.from(raw as Uint8Array) : undefined
		const call: Call = { method: init?.method ?? 'GET', url: String(url), body }
		calls.push(call)
		for (const handler of handlers) {
			const res = handler(call)
			if (res) return res
		}
		throw new Error(`unrouted ${call.method} ${call.url}`)
	}) as unknown as typeof fetch
	return { calls, fetchImpl }
}

const filesCreate = (call: Call) =>
	call.method === 'POST' && call.url.startsWith('https://www.googleapis.com/drive/v3/files?')
		? jsonResponse({
				id: 'new-1',
				name: 'Made',
				mimeType: (call.body as { mimeType: string }).mimeType,
				webViewLink: 'https://docs.google.com/x',
				version: '1',
			})
		: undefined

const ctx = (fetchImpl: typeof fetch, extra: object = {}) => ({
	http: makeHttp(fetchImpl),
	workspaceId: 'ws-1',
	...extra,
})

async function failure(promise: Promise<unknown>): Promise<DriveWriteError> {
	try {
		await promise
	} catch (err) {
		expect(err).toBeInstanceOf(DriveWriteError)
		return err as DriveWriteError
	}
	throw new Error('expected the call to fail')
}

describe('writeFile: ordinary files', () => {
	it('sends inline utf8 under 5 MB as one multipart upload and shapes the output', async () => {
		const r = router([
			(c) =>
				c.url.includes('uploadType=multipart')
					? jsonResponse({
							id: 'f1',
							name: 'a.txt',
							mimeType: 'text/plain',
							webViewLink: 'https://drive.google.com/f1',
							version: '7',
						})
					: undefined,
		])
		const { output, path } = await writeFile(ctx(r.fetchImpl), {
			name: 'a.txt',
			mimeType: 'text/plain',
			content: 'hello',
		})
		expect(path).toBe('multipart')
		expect(output).toEqual({
			fileId: 'f1',
			name: 'a.txt',
			mimeType: 'text/plain',
			webViewLink: 'https://drive.google.com/f1',
			driveFileVersion: '7',
		})
		expect(r.calls).toHaveLength(1)
	})

	it('decodes base64 content before uploading', async () => {
		const r = router([
			(c) =>
				c.url.includes('multipart')
					? jsonResponse({ id: 'f', name: 'b', mimeType: 'image/png' })
					: undefined,
		])
		await writeFile(ctx(r.fetchImpl), {
			name: 'b.png',
			mimeType: 'image/png',
			content: { encoding: 'base64', data: Buffer.from([1, 2, 3, 250]).toString('base64') },
		})
		const sent = (r.calls[0]?.body as Buffer).toString('latin1')
		expect(sent).toContain('\u0001\u0002\u0003ú')
	})

	it('rejects invalid base64', async () => {
		const r = router([])
		const err = await failure(
			writeFile(ctx(r.fetchImpl), {
				name: 'b',
				mimeType: 'image/png',
				content: { encoding: 'base64', data: '***not base64***' },
			}),
		)
		expect(err.code).toBe('INVALID_INPUT')
		expect(r.calls).toHaveLength(0)
	})

	it('routes inline content of 5 MB or more through the resumable path', async () => {
		const data = randomBytes(6 * MB)
		const drive = fakeResumableDrive()
		const { path } = await writeFile(ctx(drive.fetchImpl), {
			name: 'big.bin',
			mimeType: 'application/octet-stream',
			content: { encoding: 'base64', data: data.toString('base64') },
		})
		expect(path).toBe('resumable')
		expect(sha256(drive.received())).toBe(sha256(data))
	})

	it('streams a storageUrl source through the resumable path', async () => {
		const data = randomBytes(9 * MB)
		const drive = fakeResumableDrive()
		const open = vi.fn(async () => ({ stream: pieces(data, MB), size: data.length }))
		const { path } = await writeFile(ctx(drive.fetchImpl, { openStorageObject: open }), {
			name: 'rec.mp4',
			mimeType: 'video/mp4',
			content: { storageUrl: 'workspaces/ws-1/integrations/google-drive/downloads/abc' },
		})
		expect(path).toBe('resumable')
		expect(open).toHaveBeenCalledWith('workspaces/ws-1/integrations/google-drive/downloads/abc')
		expect(drive.puts).toHaveLength(2)
		expect(sha256(drive.received())).toBe(sha256(data))
	})

	it('refuses a storageUrl outside the caller workspace without opening it', async () => {
		const open = vi.fn()
		for (const key of [
			'workspaces/ws-2/files/secret',
			'workspaces/ws-1/../ws-2/files/secret',
			'/etc/passwd',
		]) {
			const err = await failure(
				writeFile(ctx(router([]).fetchImpl, { openStorageObject: open }), {
					name: 'x',
					mimeType: 'text/plain',
					content: { storageUrl: key },
				}),
			)
			expect(err.code).toBe('INVALID_INPUT')
		}
		expect(open).not.toHaveBeenCalled()
	})

	it('returns PERMISSION_DENIED when the account cannot write to the folder', async () => {
		const r = router([() => googleError(403, 'no', 'insufficientFilePermissions')])
		const err = await failure(
			writeFile(ctx(r.fetchImpl), {
				name: 'a',
				mimeType: 'text/plain',
				content: 'x',
				parentFolderId: 'locked',
			}),
		)
		expect(err.code).toBe('PERMISSION_DENIED')
	})

	it('rejects shapes the tool does not support', async () => {
		const r = router([])
		const run = (input: Parameters<typeof writeFile>[1]) =>
			failure(writeFile(ctx(r.fetchImpl), input))
		expect((await run({ name: 'a', mimeType: 'text/plain' })).message).toMatch(
			/content is required/,
		)
		expect(
			(await run({ name: 'a', mimeType: 'text/plain', content: 'x', docStructuredBody: [] })).code,
		).toBe('INVALID_INPUT')
		expect(
			(await run({ name: 's', mimeType: 'application/vnd.google-apps.presentation', content: 'x' }))
				.message,
		).toMatch(/not supported/)
		expect((await run({ name: 'd', mimeType: DOC, content: 'text' })).message).toMatch(
			/docStructuredBody/,
		)
		expect(r.calls).toHaveLength(0)
	})
})

describe('writeFile: Docs and Sheets', () => {
	it('mints an empty Doc, then populates it with batchUpdate in element order', async () => {
		const r = router([
			filesCreate,
			(c) =>
				c.method === 'POST' && c.url.endsWith(':batchUpdate') && c.url.includes('/documents/')
					? jsonResponse({})
					: undefined,
			(c) =>
				c.method === 'GET' && c.url.includes('docs.googleapis.com/v1/documents/new-1?fields=body')
					? jsonResponse({
							body: {
								content: [
									{ endIndex: 14 },
									{
										table: {
											tableRows: [
												{
													tableCells: [
														{ content: [{ startIndex: 20 }] },
														{ content: [{ startIndex: 22 }] },
													],
												},
												{
													tableCells: [
														{ content: [{ startIndex: 30 }] },
														{ content: [{ startIndex: 32 }] },
													],
												},
											],
										},
									},
									{ endIndex: 40 },
								],
							},
						})
					: undefined,
		])
		const { output, path } = await writeFile(ctx(r.fetchImpl), {
			name: 'Spec',
			parentFolderId: 'folder-1',
			mimeType: DOC,
			docStructuredBody: [
				{ type: 'heading', level: 1, text: 'Title' },
				{ type: 'paragraph', text: 'Hello' },
				{
					type: 'table',
					cells: [
						['a', 'bb'],
						['c', 'd'],
					],
				},
				{ type: 'paragraph', text: 'Tail' },
			],
		})

		expect(path).toBe('doc')
		expect(output).toMatchObject({ fileId: 'new-1', mimeType: DOC })
		const [create, text1, insertTable, readTable, fillCells, text2] = r.calls
		expect(create?.body).toEqual({ name: 'Spec', mimeType: DOC, parents: ['folder-1'] })
		expect(create?.url).toContain('supportsAllDrives=true')
		// heading + paragraph first, from index 1
		expect((text1?.body as { requests: object[] }).requests[0]).toEqual({
			insertText: { location: { index: 1 }, text: 'Title\n' },
		})
		expect((text1?.body as { requests: object[] }).requests[2]).toEqual({
			insertText: { location: { index: 7 }, text: 'Hello\n' },
		})
		expect(insertTable?.body).toEqual({
			requests: [{ insertTable: { rows: 2, columns: 2, endOfSegmentLocation: { segmentId: '' } } }],
		})
		expect(readTable?.method).toBe('GET')
		// cells are filled last-to-first so earlier indices stay valid
		expect(fillCells?.body).toEqual({
			requests: [
				{ insertText: { location: { index: 32 }, text: 'd' } },
				{ insertText: { location: { index: 30 }, text: 'c' } },
				{ insertText: { location: { index: 22 }, text: 'bb' } },
				{ insertText: { location: { index: 20 }, text: 'a' } },
			],
		})
		// next text lands before the body's final newline, shifted by the 5 chars of cell text
		expect((text2?.body as { requests: object[] }).requests[0]).toEqual({
			insertText: { location: { index: 40 - 1 + 5 }, text: 'Tail\n' },
		})
		expect(r.calls).toHaveLength(6)
	})

	it('does not touch Docs when the body is invalid', async () => {
		const r = router([filesCreate])
		const err = await failure(
			writeFile(ctx(r.fetchImpl), {
				name: 'Spec',
				mimeType: DOC,
				docStructuredBody: [{ type: 'image' }],
			}),
		)
		expect(err.code).toBe('INVALID_INPUT')
		expect(r.calls).toHaveLength(0)
	})

	it('mints an empty Sheet, then writes values with spreadsheets.batchUpdate', async () => {
		const r = router([
			filesCreate,
			(c) =>
				c.method === 'GET' && c.url.includes('sheets.googleapis.com/v4/spreadsheets/new-1?fields=')
					? jsonResponse({ sheets: [{ properties: { sheetId: 42 } }] })
					: undefined,
			(c) =>
				c.method === 'POST' &&
				c.url === 'https://sheets.googleapis.com/v4/spreadsheets/new-1:batchUpdate'
					? jsonResponse({})
					: undefined,
		])
		const { output, path } = await writeFile(ctx(r.fetchImpl), {
			name: 'KPIs',
			mimeType: SHEET,
			docStructuredBody: {
				values: [
					['week', 'clicks'],
					['1', '40'],
				],
			},
		})
		expect(path).toBe('sheet')
		expect(output.fileId).toBe('new-1')
		const write = r.calls[2]?.body as {
			requests: Array<{ updateCells: { start: object; rows: unknown[] } }>
		}
		expect(write.requests[0]?.updateCells.start).toEqual({
			sheetId: 42,
			rowIndex: 0,
			columnIndex: 0,
		})
		expect(write.requests[0]?.updateCells.rows).toHaveLength(2)
	})
})
