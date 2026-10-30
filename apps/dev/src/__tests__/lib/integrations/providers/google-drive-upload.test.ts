import { randomBytes } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
	MULTIPART_MAX_BYTES,
	RESUMABLE_CHUNK_BYTES,
	multipartUpload,
	resumableUpload,
} from '../../../../lib/integrations/providers/google-drive/upload'
import { DriveWriteError } from '../../../../lib/integrations/providers/google-drive/write-errors'
import {
	fakeResumableDrive,
	googleError,
	jsonResponse,
	makeHttp,
	pieces,
	sha256,
} from './google-drive-fakes'

const MB = 1024 * 1024
const meta = { name: 'big.bin', mimeType: 'application/octet-stream', parentFolderId: 'folder-9' }

async function failure(promise: Promise<unknown>): Promise<DriveWriteError> {
	try {
		await promise
	} catch (err) {
		expect(err).toBeInstanceOf(DriveWriteError)
		return err as DriveWriteError
	}
	throw new Error('expected the call to fail')
}

describe('multipartUpload', () => {
	it('posts metadata and bytes in one multipart/related request', async () => {
		let captured: { url: string; init: RequestInit } | undefined
		const http = makeHttp((async (url: string, init: RequestInit) => {
			captured = { url, init }
			return jsonResponse({ id: 'f1', name: 'notes.txt', mimeType: 'text/plain', version: '2' })
		}) as unknown as typeof fetch)

		const file = await multipartUpload(
			http,
			{ name: 'notes.txt', mimeType: 'text/plain', parentFolderId: 'folder-9' },
			Buffer.from('héllo'),
		)

		expect(file.id).toBe('f1')
		expect(captured?.url).toContain('/upload/drive/v3/files?uploadType=multipart')
		expect(captured?.url).toContain('supportsAllDrives=true')
		const headers = captured?.init.headers as Record<string, string>
		expect(headers.Authorization).toBe('Bearer ya29.test')
		expect(headers['Content-Type']).toMatch(/^multipart\/related; boundary=maskin-/)
		const body = Buffer.from(captured?.init.body as Uint8Array).toString('utf8')
		expect(body).toContain('"name":"notes.txt"')
		expect(body).toContain('"parents":["folder-9"]')
		expect(body).toContain('Content-Type: text/plain\r\n\r\nhéllo\r\n')
	})

	it('maps Drive errors: 403 file permission and missing scope are distinct', async () => {
		const denied = makeHttp((async () =>
			googleError(
				403,
				'The user does not have sufficient permissions',
				'insufficientFilePermissions',
			)) as unknown as typeof fetch)
		expect((await failure(multipartUpload(denied, meta, Buffer.from('x')))).code).toBe(
			'PERMISSION_DENIED',
		)

		const scope = makeHttp((async () =>
			googleError(
				403,
				'Request had insufficient authentication scopes.',
				'insufficientPermissions',
				{
					details: [{ reason: 'ACCESS_TOKEN_SCOPE_INSUFFICIENT' }],
				},
			)) as unknown as typeof fetch)
		expect((await failure(multipartUpload(scope, meta, Buffer.from('x')))).code).toBe(
			'SCOPE_INSUFFICIENT',
		)
	})
})

describe('resumableUpload', () => {
	it('uploads a known-size source in 8 MB chunks with Content-Range', async () => {
		const data = randomBytes(20 * MB)
		const drive = fakeResumableDrive()
		const file = await resumableUpload(makeHttp(drive.fetchImpl), {
			meta,
			source: pieces(data, 3 * MB),
			totalSize: data.length,
		})

		expect(file.id).toBe('file-1')
		expect(drive.starts[0]?.headers['X-Upload-Content-Length']).toBe(String(data.length))
		expect(drive.starts[0]?.headers['X-Upload-Content-Type']).toBe(meta.mimeType)
		expect(drive.puts.map((p) => p.contentRange)).toEqual([
			`bytes 0-${8 * MB - 1}/${20 * MB}`,
			`bytes ${8 * MB}-${16 * MB - 1}/${20 * MB}`,
			`bytes ${16 * MB}-${20 * MB - 1}/${20 * MB}`,
		])
		expect(sha256(drive.received())).toBe(sha256(data))
	})

	it('sends "*" as the total until the last chunk when the size is unknown', async () => {
		const data = randomBytes(16 * MB) // ends exactly on a chunk boundary
		const drive = fakeResumableDrive()
		await resumableUpload(makeHttp(drive.fetchImpl), { meta, source: pieces(data, 5 * MB) })

		expect(drive.starts[0]?.headers['X-Upload-Content-Length']).toBeUndefined()
		expect(drive.puts.map((p) => p.contentRange)).toEqual([
			`bytes 0-${8 * MB - 1}/*`,
			`bytes ${8 * MB}-${16 * MB - 1}/${16 * MB}`,
		])
		expect(sha256(drive.received())).toBe(sha256(data))
	})

	it('resumes from the last committed byte after a TCP drop at 40 percent (S17)', async () => {
		const data = randomBytes(25 * MB)
		const dropAt = Math.floor(data.length * 0.4) // 10 MB, inside the second chunk
		const drive = fakeResumableDrive({ dropAtByte: dropAt })
		const http = makeHttp(drive.fetchImpl)

		const file = await resumableUpload(http, {
			meta,
			source: pieces(data, 2 * MB),
			totalSize: data.length,
		})

		expect(file.id).toBe('file-1')
		const statusQueries = drive.puts.filter((p) => p.contentRange.startsWith('bytes */'))
		expect(statusQueries).toEqual([
			{ contentRange: `bytes */${data.length}`, contentLength: '0', bytes: 0 },
		])
		// The retry starts at the committed offset, not at the chunk start.
		expect(drive.puts.map((p) => p.contentRange)).toContain(
			`bytes ${dropAt}-${16 * MB - 1}/${data.length}`,
		)
		expect(http.sleep).toHaveBeenCalledTimes(1)
		expect(sha256(drive.received())).toBe(sha256(data))
	})

	it('treats an expired session as fresh-session-required, with no retry', async () => {
		const drive = fakeResumableDrive({ expireSession: true })
		const http = makeHttp(drive.fetchImpl)
		const err = await failure(
			resumableUpload(http, { meta, source: pieces(randomBytes(9 * MB), MB), totalSize: 9 * MB }),
		)
		expect(err.code).toBe('UPLOAD_FAILED')
		expect(err.message).toMatch(/expired/i)
		expect(err.hint).toMatch(/restart the upload/i)
		expect(drive.puts).toHaveLength(1)
		expect(http.sleep).not.toHaveBeenCalled()
	})

	it('fails with UPLOAD_FAILED and a restart hint once the retry budget is spent', async () => {
		const http = makeHttp((async (url: string, init: RequestInit) => {
			if (init.method === 'POST') {
				return new Response(null, { status: 200, headers: { location: 'https://session/x' } })
			}
			throw new TypeError('terminated')
		}) as unknown as typeof fetch)
		const err = await failure(
			resumableUpload(http, { meta, source: pieces(randomBytes(MB), MB), totalSize: MB }),
		)
		expect(err.code).toBe('UPLOAD_FAILED')
		expect(err.hint).toMatch(/restart the upload/i)
		expect(http.sleep).toHaveBeenCalledTimes(5)
	})

	it('surfaces a permission failure on a chunk without retrying', async () => {
		const http = makeHttp((async (url: string, init: RequestInit) => {
			if (init.method === 'POST') {
				return new Response(null, { status: 200, headers: { location: 'https://session/x' } })
			}
			return googleError(403, 'Forbidden', 'forbidden')
		}) as unknown as typeof fetch)
		const err = await failure(
			resumableUpload(http, { meta, source: pieces(randomBytes(MB), MB), totalSize: MB }),
		)
		expect(err.code).toBe('PERMISSION_DENIED')
		expect(http.sleep).not.toHaveBeenCalled()
	})

	it('rejects a source whose length disagrees with the declared size', async () => {
		const drive = fakeResumableDrive()
		const err = await failure(
			resumableUpload(makeHttp(drive.fetchImpl), {
				meta,
				source: pieces(randomBytes(3 * MB), MB),
				totalSize: 4 * MB,
			}),
		)
		expect(err.code).toBe('UPLOAD_FAILED')
		expect(err.message).toMatch(/declared/)
	})

	it('falls back to a multipart request for an empty source', async () => {
		const urls: string[] = []
		const http = makeHttp((async (url: string) => {
			urls.push(url)
			return jsonResponse({ id: 'empty', name: 'e', mimeType: 'text/plain' })
		}) as unknown as typeof fetch)
		const file = await resumableUpload(http, {
			meta: { name: 'e', mimeType: 'text/plain' },
			source: pieces(Buffer.alloc(0), MB),
		})
		expect(file.id).toBe('empty')
		expect(urls).toHaveLength(1)
		expect(urls[0]).toContain('uploadType=multipart')
	})

	it('keeps the documented sizes', () => {
		expect(MULTIPART_MAX_BYTES).toBe(5 * MB)
		expect(RESUMABLE_CHUNK_BYTES).toBe(8 * MB)
		expect(RESUMABLE_CHUNK_BYTES % (256 * 1024)).toBe(0)
	})
})
