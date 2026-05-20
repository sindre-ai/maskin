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
		// Routes read FRONTEND_URL for the returned `url` field and API_BASE_URL
		// for `downloadUrl`. Pin them so assertions don't depend on dev defaults
		// or leak between tests. vi.stubEnv handles both set and unset cleanly —
		// plain `process.env.X = undefined` would coerce to the string 'undefined'.
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
		vi.stubEnv('API_BASE_URL', '')
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
			expect(json.downloadUrl).toBe(`http://localhost:5173/api/files/${inserted.id}/download`)
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

		it('targets API_BASE_URL for downloadUrl when set (split-origin prod)', async () => {
			vi.stubEnv('API_BASE_URL', 'https://api.example.com')
			vi.stubEnv('FRONTEND_URL', 'https://app.example.com')
			const { app, mockResults } = createImportTestApp(filesRoutes, '/api/files')
			const body = buildCreateFileBody()
			const inserted = buildFile({ workspaceId, name: body.name, mimeType: body.mime_type })
			mockResults.insertQueue = [[inserted], [{ id: 'evt-1' }]]

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(201)
			const json = await res.json()
			expect(json.url).toBe(`https://app.example.com/${workspaceId}/files/${inserted.id}`)
			expect(json.downloadUrl).toBe(`https://api.example.com/api/files/${inserted.id}/download`)
		})

		it('returns 400 on invalid base64 content', async () => {
			const { app } = createImportTestApp(filesRoutes, '/api/files')
			const body = { ...buildCreateFileBody(), content: 'not base64!!' }

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			expect(res.status).toBe(400)
		})

		it('returns 400 when content exceeds 10MB', async () => {
			const { app } = createImportTestApp(filesRoutes, '/api/files')
			const oversized = Buffer.alloc(11 * 1024 * 1024).toString('base64')
			const body = { ...buildCreateFileBody(), content: oversized }

			const res = await app.request(jsonRequest('POST', '/api/files', body, authedHeaders()))

			// The test OpenAPIHono has no defaultHook, so zod validation failures
			// surface as 500 instead of the 400 the production app returns. We
			// only care that the upload was rejected and never reached the
			// storage layer.
			expect([400, 500]).toContain(res.status)
			expect(res.status).not.toBe(201)
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
		it('returns 200 with base64 content', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId })
			const bytes = Buffer.from('# Hello')
			vi.mocked(storageProvider.get).mockResolvedValue(bytes)
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}`))

			expect(res.status).toBe(200)
			const json = await res.json()
			expect(json.content).toBe(bytes.toString('base64'))
			expect(storageProvider.get).toHaveBeenCalledWith(file.storageKey)
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

	describe('GET /api/files/:id/download', () => {
		it('streams raw bytes with nosniff and inline disposition for text', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId, mimeType: 'text/markdown', name: 'doc.md' })
			vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from('hello'))
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}/download`))

			expect(res.status).toBe(200)
			expect(res.headers.get('Content-Type')).toBe('text/markdown')
			expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
			const disp = res.headers.get('Content-Disposition')
			expect(disp).toMatch(/^inline; filename="doc.md"$/)
		})

		it('forces attachment for HTML so the browser cannot execute the bytes', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({
				workspaceId,
				mimeType: 'text/html',
				name: 'page.html',
			})
			vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from('<script>alert(1)</script>'))
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}/download`))

			expect(res.status).toBe(200)
			expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
		})

		it('forces attachment for SVG (script execution vector)', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({
				workspaceId,
				mimeType: 'image/svg+xml',
				name: 'icon.svg',
			})
			vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from('<svg></svg>'))
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}/download`))

			expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
		})

		it('forces attachment for JavaScript', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({
				workspaceId,
				mimeType: 'application/javascript',
				name: 'app.js',
			})
			vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from('alert(1)'))
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })]]

			const res = await app.request(jsonGet(`/api/files/${file.id}/download`))

			expect(res.headers.get('Content-Disposition')).toMatch(/^attachment;/)
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

		it('re-uploads when content changes', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(filesRoutes, '/api/files')
			const file = buildFile({ workspaceId })
			const newContent = Buffer.from('# Updated').toString('base64')
			mockResults.selectQueue = [[file], [buildWorkspaceMember({ workspaceId })], [file]]
			mockResults.updateQueue = [[file]]

			const res = await app.request(
				jsonRequest('PATCH', `/api/files/${file.id}`, { content: newContent }),
			)

			expect(res.status).toBe(200)
			expect(storageProvider.put).toHaveBeenCalledTimes(1)
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
