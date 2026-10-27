import { randomUUID } from 'node:crypto'
import { MAX_LARGE_FILE_SIZE_BYTES } from '@maskin/shared'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildFile, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(async () => {}),
}))

const { default: filesRoutes } = await import('../../routes/files')

const workspaceId = '00000000-0000-0000-0000-000000000001'
const actorId = 'test-actor-id'
const MiB = 1024 * 1024
const headers = { 'X-Workspace-Id': workspaceId }

function buildUpload(overrides?: Record<string, unknown>) {
	const fileId = randomUUID()
	return {
		id: randomUUID(),
		workspaceId,
		fileId,
		name: 'clip.mp4',
		description: null,
		kind: null,
		mimeType: 'video/mp4',
		sizeBytes: 100 * MiB,
		storageKey: `workspaces/${workspaceId}/files/${fileId}`,
		s3UploadId: 's3-upload-1',
		partSize: 16 * MiB,
		partCount: 7,
		status: 'pending',
		createdBy: actorId,
		createdAt: new Date(),
		expiresAt: new Date(Date.now() + 60 * 60 * 1000),
		...overrides,
	}
}

/** An error the way the AWS SDK throws it: identified by `name`, not by message. */
function storageError(name: string) {
	return Object.assign(new Error(name), { name })
}

function allParts(count: number) {
	return Array.from({ length: count }, (_, i) => ({ part_number: i + 1, etag: `"etag-${i + 1}"` }))
}

describe('Large file routes', () => {
	beforeEach(() => {
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	describe('POST /api/files/uploads', () => {
		const body = { name: 'clip.mp4', mime_type: 'video/mp4', size_bytes: 100 * MiB }

		it('starts a multipart upload and returns one presigned URL per part', async () => {
			const { app, mockResults, calls, storageProvider } = createImportTestApp(
				filesRoutes,
				'/api/files',
			)
			const upload = buildUpload()
			mockResults.insertQueue = [[upload]]

			const res = await app.request(jsonRequest('POST', '/api/files/uploads', body, headers))

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.upload_id).toBe(upload.id)
			expect(json.part_size).toBe(16 * MiB)
			// 100 MiB / 16 MiB parts = 7 parts, numbered from 1.
			expect(json.parts.map((p: { part_number: number }) => p.part_number)).toEqual([
				1, 2, 3, 4, 5, 6, 7,
			])
			expect(storageProvider.createMultipartUpload).toHaveBeenCalledWith(
				expect.stringContaining(`workspaces/${workspaceId}/files/`),
				{ contentType: 'video/mp4' },
			)
			const inserted = calls.inserts[0] as Record<string, unknown>
			expect(inserted).toMatchObject({
				workspaceId,
				sizeBytes: 100 * MiB,
				partCount: 7,
				createdBy: actorId,
			})
		})

		it('rejects a file over the limit before touching storage', async () => {
			const { app, storageProvider } = createImportTestApp(filesRoutes, '/api/files')

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/files/uploads',
					{ ...body, size_bytes: MAX_LARGE_FILE_SIZE_BYTES + 1 },
					headers,
				),
			)

			expect(res.status).toBe(400)
			expect(storageProvider.createMultipartUpload).not.toHaveBeenCalled()
		})

		it('aborts the storage upload when saving the row fails', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.insertQueue = [[]]

			const res = await app.request(jsonRequest('POST', '/api/files/uploads', body, headers))

			expect(res.status).toBe(500)
			expect(storageProvider.abortMultipartUpload).toHaveBeenCalledWith(
				expect.any(String),
				's3-upload-1',
			)
		})
	})

	describe('POST /api/files/uploads/:id/complete', () => {
		function setup(upload = buildUpload()) {
			const ctx = createImportTestApp(filesRoutes, '/api/files')
			ctx.mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })]]
			// The claim (pending → completed) wins.
			ctx.mockResults.update = [{ id: upload.id }]
			vi.mocked(ctx.storageProvider.headObject).mockResolvedValue({ size: upload.sizeBytes })
			const created = buildFile({
				id: upload.fileId,
				workspaceId,
				name: upload.name,
				mimeType: upload.mimeType,
				sizeBytes: upload.sizeBytes,
				storageKey: upload.storageKey,
			})
			ctx.mockResults.insertQueue = [[created], [{ id: 'evt-1' }]]
			return { ...ctx, upload, created }
		}

		const complete = (id: string, parts = allParts(7)) =>
			jsonRequest('POST', `/api/files/uploads/${id}/complete`, { parts }, headers)

		it('stitches the parts, verifies the size and returns the file with a download URL', async () => {
			const { app, upload, storageProvider, calls } = setup()

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.id).toBe(upload.fileId)
			expect(json.contentOmitted).toBe(true)
			expect(json.content).toBe('')
			expect(json.downloadUrl).toBe('https://storage.test/download/file')
			expect(storageProvider.completeMultipartUpload).toHaveBeenCalledWith(
				upload.storageKey,
				's3-upload-1',
				expect.arrayContaining([{ partNumber: 1, etag: '"etag-1"' }]),
			)
			// File row first, audit event second; neither carries bytes.
			const fileInsert = calls.inserts[0] as Record<string, unknown>
			expect(fileInsert).toMatchObject({ id: upload.fileId, sizeBytes: upload.sizeBytes })
			expect((calls.inserts[1] as Record<string, unknown>).action).toBe('created')
			expect(storageProvider.get).not.toHaveBeenCalled()
		})

		it('rejects a missing part', async () => {
			const { app, upload, storageProvider } = setup()

			const res = await app.request(complete(upload.id, allParts(6)))

			expect(res.status).toBe(400)
			expect(storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it('rejects duplicate part numbers', async () => {
			const { app, upload, storageProvider } = setup()
			const parts = [...allParts(6), { part_number: 1, etag: '"dup"' }]

			const res = await app.request(complete(upload.id, parts))

			expect(res.status).toBe(400)
			expect(storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it('deletes the object and refuses when the stored size differs from the declared one', async () => {
			const { app, upload, storageProvider, calls } = setup()
			vi.mocked(storageProvider.headObject).mockResolvedValue({ size: upload.sizeBytes - 1 })

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(400)
			expect(storageProvider.delete).toHaveBeenCalledWith(upload.storageKey)
			expect(calls.inserts).toHaveLength(0)
		})

		it('lets the client retry when storage rejects the parts', async () => {
			const { app, upload, storageProvider, calls } = setup()
			vi.mocked(storageProvider.completeMultipartUpload).mockRejectedValue(
				storageError('InvalidPart'),
			)

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(400)
			// The claim is released back to pending; the stored parts are kept.
			expect(calls.updates.at(-1)).toMatchObject({ status: 'pending' })
			expect(storageProvider.delete).not.toHaveBeenCalled()
		})

		it('takes the upload as completing and only marks it completed once the file exists', async () => {
			const { app, upload, calls } = setup()

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(201)
			expect(calls.updates[0]).toMatchObject({ status: 'completing' })
			expect(calls.updates[0]).toHaveProperty('claimedAt')
			// Completed only as the last write, after the file row insert.
			expect(calls.updates.map((u) => (u as { status?: string }).status)).toEqual([
				'completing',
				'completed',
			])
			expect((calls.inserts[0] as Record<string, unknown>).id).toBe(upload.fileId)
		})

		it('reports an unreachable storage as unavailable and keeps the upload retryable', async () => {
			const { app, upload, storageProvider, calls } = setup()
			vi.mocked(storageProvider.completeMultipartUpload).mockRejectedValue(
				storageError('ServiceUnavailable'),
			)

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(503)
			expect(calls.updates.at(-1)).toMatchObject({ status: 'pending' })
			expect(storageProvider.delete).not.toHaveBeenCalled()
		})

		it('closes the upload when storage no longer has it', async () => {
			const { app, upload, storageProvider, calls } = setup()
			vi.mocked(storageProvider.completeMultipartUpload).mockRejectedValue(
				storageError('NoSuchUpload'),
			)

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(409)
			expect(calls.updates.at(-1)).toMatchObject({ status: 'aborted' })
		})

		it('still deletes the object and refuses when the size check cannot read storage', async () => {
			const { app, upload, storageProvider, calls } = setup()
			vi.mocked(storageProvider.headObject).mockRejectedValue(new Error('boom'))

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(500)
			expect(storageProvider.delete).toHaveBeenCalledWith(upload.storageKey)
			expect(calls.updates.at(-1)).toMatchObject({ status: 'aborted' })
		})

		it('does not fail the request when deleting the orphaned object fails', async () => {
			const { app, upload, storageProvider } = setup()
			vi.mocked(storageProvider.headObject).mockResolvedValue({ size: upload.sizeBytes - 1 })
			vi.mocked(storageProvider.delete).mockRejectedValue(new Error('storage down'))

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(400)
		})

		it('returns the file for a retried complete when only the final status write was lost', async () => {
			const upload = buildUpload({ status: 'completing', claimedAt: new Date() })
			const ctx = createImportTestApp(filesRoutes, '/api/files')
			const existing = buildFile({
				id: upload.fileId,
				workspaceId,
				mimeType: 'video/mp4',
				sizeBytes: upload.sizeBytes,
			})
			ctx.mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })], [existing]]

			const res = await ctx.app.request(complete(upload.id))

			expect(res.status).toBe(201)
			expect((await res.json()).id).toBe(upload.fileId)
			expect(ctx.calls.updates.at(-1)).toMatchObject({ status: 'completed' })
			expect(ctx.storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it('tells a retry that another request is still completing the upload', async () => {
			const upload = buildUpload({ status: 'completing', claimedAt: new Date() })
			const ctx = createImportTestApp(filesRoutes, '/api/files')
			ctx.mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })], []]

			const res = await ctx.app.request(complete(upload.id))

			expect(res.status).toBe(409)
			expect(ctx.storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it('returns the existing file when a finished upload is completed again', async () => {
			const upload = buildUpload({ status: 'completed' })
			const ctx = createImportTestApp(filesRoutes, '/api/files')
			const existing = buildFile({
				id: upload.fileId,
				workspaceId,
				mimeType: 'video/mp4',
				sizeBytes: upload.sizeBytes,
			})
			ctx.mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })], [existing]]

			const res = await ctx.app.request(complete(upload.id))

			expect(res.status).toBe(201)
			expect((await res.json()).id).toBe(upload.fileId)
			expect(ctx.storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it('refuses an expired upload', async () => {
			const { app, upload, storageProvider } = setup(
				buildUpload({ expiresAt: new Date(Date.now() - 1000) }),
			)

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(409)
			expect(storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it('returns 409 when another request already claimed the upload', async () => {
			const { app, upload, mockResults, storageProvider } = setup()
			mockResults.update = []

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(409)
			expect(storageProvider.completeMultipartUpload).not.toHaveBeenCalled()
		})

		it("returns 404 for someone else's upload", async () => {
			const { app, upload } = setup(buildUpload({ createdBy: randomUUID() }))

			const res = await app.request(complete(upload.id))

			expect(res.status).toBe(404)
		})
	})

	describe('DELETE /api/files/uploads/:id', () => {
		it('discards the stored parts of a pending upload', async () => {
			const upload = buildUpload()
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })]]
			mockResults.update = [{ id: upload.id }]

			const res = await app.request(jsonDelete(`/api/files/uploads/${upload.id}`, headers))

			expect(res.status).toBe(200)
			expect(storageProvider.abortMultipartUpload).toHaveBeenCalledWith(
				upload.storageKey,
				upload.s3UploadId,
			)
		})

		it('reopens the upload and reports the failure when storage cannot discard the parts', async () => {
			const upload = buildUpload()
			const { app, mockResults, storageProvider, calls } = createImportTestApp(
				filesRoutes,
				'/api/files',
			)
			mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })]]
			mockResults.update = [{ id: upload.id }]
			vi.mocked(storageProvider.abortMultipartUpload).mockRejectedValue(new Error('storage down'))

			const res = await app.request(jsonDelete(`/api/files/uploads/${upload.id}`, headers))

			expect(res.status).toBe(500)
			expect(calls.updates.at(-1)).toMatchObject({ status: 'pending' })
		})

		it('treats an upload storage already forgot as discarded', async () => {
			const upload = buildUpload()
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })]]
			mockResults.update = [{ id: upload.id }]
			vi.mocked(storageProvider.abortMultipartUpload).mockRejectedValue(
				storageError('NoSuchUpload'),
			)

			const res = await app.request(jsonDelete(`/api/files/uploads/${upload.id}`, headers))

			expect(res.status).toBe(200)
		})

		it('refuses to abort an upload that is being completed', async () => {
			const upload = buildUpload({ status: 'completing' })
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonDelete(`/api/files/uploads/${upload.id}`, headers))

			expect(res.status).toBe(409)
			expect(storageProvider.abortMultipartUpload).not.toHaveBeenCalled()
		})

		it('refuses to abort an upload that already became a file', async () => {
			const upload = buildUpload({ status: 'completed' })
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[upload], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonDelete(`/api/files/uploads/${upload.id}`, headers))

			expect(res.status).toBe(409)
			expect(storageProvider.abortMultipartUpload).not.toHaveBeenCalled()
		})
	})

	describe('reading and editing a large file', () => {
		const largeFile = () =>
			buildFile({
				workspaceId,
				name: 'clip.mp4',
				mimeType: 'video/mp4',
				sizeBytes: 200 * MiB,
			})

		it('GET returns a download URL and never reads the bytes into memory', async () => {
			const file = largeFile()
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}`))

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.contentOmitted).toBe(true)
			expect(json.content).toBe('')
			expect(json.downloadUrl).toBe('https://storage.test/download/file')
			expect(storageProvider.get).not.toHaveBeenCalled()
			// Video plays inline; the filename travels in the disposition.
			expect(storageProvider.presignDownload).toHaveBeenCalledWith(
				file.storageKey,
				expect.objectContaining({
					contentType: 'video/mp4',
					contentDisposition: "inline; filename*=UTF-8''clip.mp4",
				}),
			)
		})

		it('GET makes non-media large files a download, not an inline page', async () => {
			const file = buildFile({
				workspaceId,
				name: 'a b.zip',
				mimeType: 'application/zip',
				sizeBytes: 200 * MiB,
			})
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			await app.request(jsonGet(`/api/files/${file.id}`))

			expect(storageProvider.presignDownload).toHaveBeenCalledWith(
				file.storageKey,
				expect.objectContaining({ contentDisposition: "attachment; filename*=UTF-8''a%20b.zip" }),
			)
		})

		it('PATCH refuses to replace the content of a large file', async () => {
			const file = largeFile()
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/files/${file.id}`, { content: 'new', mime_type: 'text/plain' }),
			)

			expect(res.status).toBe(400)
			expect(storageProvider.put).not.toHaveBeenCalled()
			expect(storageProvider.get).not.toHaveBeenCalled()
		})
	})
})
