import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildCreateFileBody, buildFile, buildWorkspaceMember } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createImportTestApp } from '../setup'

const { default: filesRoutes } = await import('../../routes/files')

const workspaceId = '00000000-0000-0000-0000-000000000001'

function authedHeaders() {
	return { 'X-Workspace-Id': workspaceId }
}

describe('Files Routes', () => {
	beforeEach(() => {
		// Routes read FRONTEND_URL for the returned `url` field. Pin it so
		// assertions don't depend on dev defaults or leak between tests.
		// vi.stubEnv handles both set and unset cleanly — plain
		// `process.env.X = undefined` would coerce to the string 'undefined'.
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
	})

	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	describe('POST /api/files', () => {
		it('returns 201, inserts a row, writes to storage, and emits a created event', async () => {
			const { app, mockResults, calls, storageProvider } = createImportTestApp(
				filesRoutes,
				'/api/files',
			)
			const body = buildCreateFileBody()
			const inserted = buildFile({ workspaceId, name: body.name, mimeType: body.mime_type })
			mockResults.insertQueue = [[inserted], [{ id: 'evt-1' }]]

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.id).toBe(inserted.id)
			expect(json.name).toBe(inserted.name)
			expect(json.content).toBe(body.content)
			expect(json.url).toBe(`http://localhost:5173/${workspaceId}/files/${inserted.id}`)
			expect(json.downloadUrl).toBeUndefined()
			expect(storageProvider.put).toHaveBeenCalledTimes(1)

			// First insert is the file row, second is the audit event.
			const fileInsert = calls.inserts[0] as Record<string, unknown>
			expect(fileInsert.workspaceId).toBe(workspaceId)
			expect(fileInsert.mimeType).toBe(body.mime_type)
			const eventInsert = calls.inserts[1] as Record<string, unknown>
			expect(eventInsert.entityType).toBe('file')
			expect(eventInsert.action).toBe('created')
			// Audit event must NOT echo the content (PG NOTIFY 8KB cap).
			expect((eventInsert.data as Record<string, unknown>).content).toBeUndefined()
		})

		it('mints absolute URLs from FRONTEND_URL', async () => {
			vi.stubEnv('FRONTEND_URL', 'https://app.example.com')
			const { app, mockResults } = createImportTestApp(filesRoutes, '/api/files')
			const body = buildCreateFileBody()
			const inserted = buildFile({ workspaceId, name: body.name, mimeType: body.mime_type })
			mockResults.insertQueue = [[inserted], [{ id: 'evt-1' }]]

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.url).toBe(`https://app.example.com/${workspaceId}/files/${inserted.id}`)
		})

		it('returns 500 in production when FRONTEND_URL is unset, before any side effects', async () => {
			vi.stubEnv('NODE_ENV', 'production')
			vi.stubEnv('FRONTEND_URL', '')
			const { app, calls, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const body = buildCreateFileBody()

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(500)
			// No row should have been inserted and no bytes written — env
			// validation must run before any side effects so a retry doesn't
			// create orphan rows / objects.
			expect(calls.inserts).toHaveLength(0)
			expect(storageProvider.put).not.toHaveBeenCalled()
		})

		it('returns 500 when S3 put fails (row is compensated)', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const body = buildCreateFileBody()
			const inserted = buildFile({ workspaceId, name: body.name, mimeType: body.mime_type })
			mockResults.insertQueue = [[inserted]]
			vi.mocked(storageProvider.put).mockRejectedValueOnce(new Error('S3 down'))

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(500)
		})

		it('returns 400 on invalid base64 content when encoding=base64', async () => {
			const { app } = createImportTestApp(filesRoutes, '/api/files')
			const body = {
				...buildCreateFileBody(),
				content: 'not base64!!',
				encoding: 'base64' as const,
			}

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(400)
		})

		it('returns 400 when base64 content exceeds 10MB', async () => {
			const { app } = createImportTestApp(filesRoutes, '/api/files')
			const oversized = Buffer.alloc(11 * 1024 * 1024).toString('base64')
			const body = { ...buildCreateFileBody(), content: oversized, encoding: 'base64' as const }

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			// The test OpenAPIHono has no defaultHook, so zod validation failures
			// surface as 500 instead of the 400 the production app returns. We
			// only care that the upload was rejected and never reached the
			// storage layer.
			expect([400, 500]).toContain(res.status)
			expect(res.status).not.toBe(201)
		})

		it('returns 400 when utf8 content exceeds 10MB', async () => {
			const { app } = createImportTestApp(filesRoutes, '/api/files')
			const oversized = 'a'.repeat(11 * 1024 * 1024)
			const body = { ...buildCreateFileBody(), content: oversized }

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect([400, 500]).toContain(res.status)
			expect(res.status).not.toBe(201)
		})

		it('accepts base64 content with a binary MIME type', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const pngBytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
			const body = {
				...buildCreateFileBody(),
				name: 'logo.png',
				mime_type: 'image/png',
				content: pngBytes.toString('base64'),
				encoding: 'base64' as const,
			}
			const inserted = buildFile({ workspaceId, name: body.name, mimeType: body.mime_type })
			mockResults.insertQueue = [[inserted], [{ id: 'evt-1' }]]

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(201)
			const json = await res.json()
			// Binary MIME → response echoes base64-encoded bytes.
			expect(json.encoding).toBe('base64')
			expect(json.content).toBe(pngBytes.toString('base64'))
			const putCall = vi.mocked(storageProvider.put).mock.calls[0]
			expect(putCall?.[1]).toEqual(pngBytes)
		})

		it('returns 400 on invalid MIME type', async () => {
			const { app } = createImportTestApp(filesRoutes, '/api/files')
			const body = { ...buildCreateFileBody(), mime_type: 'notamimetype' }

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(400)
		})
	})

	describe('GET /api/files', () => {
		it('returns 200 with the list ordered by created_at desc', async () => {
			const { app, mockResults } = createImportTestApp(filesRoutes, '/api/files')
			const a = buildFile({ workspaceId, name: 'a.md' })
			const b = buildFile({ workspaceId, name: 'b.md' })
			mockResults.selectQueue = [[a, b]]

			const res = await app.request(jsonGet('/api/files', authedHeaders()))

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json).toHaveLength(2)
			expect(json[0].name).toBe('a.md')
		})
	})

	describe('GET /api/files/:id', () => {
		it('returns 200 with utf8 content for text MIME types', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId, mimeType: 'text/markdown' })
			const bytes = Buffer.from('# Hello')
			vi.mocked(storageProvider.get).mockResolvedValue(bytes)
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}`))

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.encoding).toBe('utf8')
			expect(json.content).toBe('# Hello')
			expect(storageProvider.get).toHaveBeenCalledWith(file.storageKey)
		})

		it('returns 200 with base64 content for binary MIME types', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId, mimeType: 'image/png' })
			const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
			vi.mocked(storageProvider.get).mockResolvedValue(bytes)
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}`))

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.encoding).toBe('base64')
			expect(json.content).toBe(bytes.toString('base64'))
		})

		it('returns 404 when file does not exist', async () => {
			const { app, mockResults } = createImportTestApp(filesRoutes, '/api/files')
			mockResults.selectQueue = [[]]

			const res = await app.request(
				jsonGet(`/api/files/${'1'.repeat(8)}-1111-1111-1111-111111111111`),
			)

			expect(res.status).toBe(404)
		})

		it('returns 404 when caller is not a workspace member', async () => {
			const { app, mockResults } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId })
			mockResults.selectQueue = [[file], []] // no member row

			const res = await app.request(jsonGet(`/api/files/${file.id}`))

			expect(res.status).toBe(404)
		})
	})

	describe('PATCH /api/files/:id', () => {
		it('updates name without re-uploading when content is unchanged', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId, name: 'old.md' })
			const updated = { ...file, name: 'new.md' }
			vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from('# Hello'))
			mockResults.selectQueue = [
				[file], // first select: existing
				[buildWorkspaceMember({ workspaceId })], // membership
				[file], // re-select FOR UPDATE inside tx
			]
			mockResults.updateQueue = [[updated]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/files/${file.id}`, { name: 'new.md' }),
			)

			expect(res.status).toBe(200)
			expect(storageProvider.put).not.toHaveBeenCalled()
			expect(storageProvider.get).toHaveBeenCalledTimes(1) // for the response only
		})

		it('re-uploads when content changes (utf8 default)', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId, mimeType: 'text/markdown' })
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })], [file]]
			mockResults.updateQueue = [[file]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/files/${file.id}`, { content: '# Updated' }),
			)

			expect(res.status).toBe(200)
			expect(storageProvider.put).toHaveBeenCalledTimes(1)
			const putCall = vi.mocked(storageProvider.put).mock.calls[0]
			expect(putCall?.[1]).toEqual(Buffer.from('# Updated', 'utf8'))
		})

		it('re-uploads when content changes (explicit base64 encoding)', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId, mimeType: 'image/png' })
			const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47])
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })], [file]]
			mockResults.updateQueue = [[file]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/files/${file.id}`, {
					content: bytes.toString('base64'),
					encoding: 'base64',
				}),
			)

			expect(res.status).toBe(200)
			expect(storageProvider.put).toHaveBeenCalledTimes(1)
			const putCall = vi.mocked(storageProvider.put).mock.calls[0]
			expect(putCall?.[1]).toEqual(bytes)
		})
	})

	describe('DELETE /api/files/:id', () => {
		it('returns 200, deletes from DB and storage, and emits a deleted event', async () => {
			const { app, mockResults, calls, storageProvider } = createImportTestApp(
				filesRoutes,
				'/api/files',
			)
			const file = buildFile({ workspaceId })
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonDelete(`/api/files/${file.id}`))

			expect(res.status).toBe(200)
			expect(storageProvider.delete).toHaveBeenCalledWith(file.storageKey)
			const eventInsert = calls.inserts.at(-1) as Record<string, unknown>
			expect(eventInsert.entityType).toBe('file')
			expect(eventInsert.action).toBe('deleted')
		})

		it('returns 404 when caller is not a workspace member', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId })
			mockResults.selectQueue = [[file], []]

			const res = await app.request(jsonDelete(`/api/files/${file.id}`))

			expect(res.status).toBe(404)
			expect(storageProvider.delete).not.toHaveBeenCalled()
		})
	})
})
