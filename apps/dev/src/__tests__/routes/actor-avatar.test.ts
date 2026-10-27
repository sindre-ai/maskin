import { randomUUID } from 'node:crypto'
import { jsonGet } from '../helpers'
import { createImportTestApp } from '../setup'

const { default: actorAvatarRoutes } = await import('../../routes/actor-avatar')

const WORKSPACE_ID = randomUUID()
const AGENT_ID = randomUUID()
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00])

function upload(bytes: Uint8Array, type = 'image/png') {
	const form = new FormData()
	form.append('file', new File([bytes], 'avatar', { type }))
	return new Request(`http://localhost/api/actors/${AGENT_ID}/avatar`, {
		method: 'POST',
		headers: { 'X-Workspace-Id': WORKSPACE_ID },
		body: form,
	})
}

// workspace membership of caller and agent, then the caller's admin workspaces, then the shared one
const ADMIN_CHECKS = [
	[{ actorId: 'a' }],
	[{ actorId: 'b' }],
	[{ workspaceId: WORKSPACE_ID }],
	[{ actorId: AGENT_ID }],
]

describe('Actor avatar routes', () => {
	describe('POST /api/actors/:id/avatar', () => {
		it('stores the image and returns a versioned avatar_url', async () => {
			const { app, mockResults, storageProvider, calls } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [...ADMIN_CHECKS, [{ type: 'agent', metadata: null }]]

			const res = await app.request(upload(PNG))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.avatar_url).toMatch(new RegExp(`^/api/actors/${AGENT_ID}/avatar\\?v=[0-9a-f-]+$`))
			expect(storageProvider.put).toHaveBeenCalledOnce()
			expect(calls.updates).toHaveLength(1)
		})

		it('deletes the replaced image', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [
				...ADMIN_CHECKS,
				[{ type: 'agent', metadata: { avatar_version: 'old-version' } }],
			]

			const res = await app.request(upload(PNG))

			expect(res.status).toBe(200)
			expect(storageProvider.delete).toHaveBeenCalledWith(`avatars/${AGENT_ID}/old-version`)
		})

		it('returns 404 for a human, which never gets an uploaded picture', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [...ADMIN_CHECKS, [{ type: 'human', metadata: null }]]

			const res = await app.request(upload(PNG))

			expect(res.status).toBe(404)
			expect(storageProvider.put).not.toHaveBeenCalled()
		})

		it('returns 403 when the caller is not a workspace admin', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [[{ actorId: 'a' }], [{ actorId: 'b' }], []]

			const res = await app.request(upload(PNG))

			expect(res.status).toBe(403)
			expect(storageProvider.put).not.toHaveBeenCalled()
		})

		it('returns 415 when the bytes are not a PNG or JPG, whatever the client says', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [...ADMIN_CHECKS, [{ type: 'agent', metadata: null }]]

			const res = await app.request(upload(new TextEncoder().encode('<svg onload=x>'), 'image/png'))

			expect(res.status).toBe(415)
			expect(storageProvider.put).not.toHaveBeenCalled()
		})

		it('returns 413 when the image is over 2 MB', async () => {
			const { app, mockResults } = createImportTestApp(actorAvatarRoutes, '/api/actors')
			mockResults.selectQueue = [...ADMIN_CHECKS, [{ type: 'agent', metadata: null }]]
			const big = new Uint8Array(2 * 1024 * 1024 + 1)
			big.set(PNG)

			const res = await app.request(upload(big))

			expect(res.status).toBe(413)
		})
	})

	describe('GET /api/actors/:id/avatar', () => {
		it('serves the stored bytes with the stored type and a long cache', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [
				[{ type: 'agent', metadata: { avatar_version: 'v1', avatar_content_type: 'image/png' } }],
			]
			vi.mocked(storageProvider.get).mockResolvedValue(Buffer.from(PNG))

			const res = await app.request(jsonGet(`/api/actors/${AGENT_ID}/avatar`))

			expect(res.status).toBe(200)
			expect(res.headers.get('content-type')).toBe('image/png')
			expect(res.headers.get('cache-control')).toContain('immutable')
			expect(res.headers.get('x-content-type-options')).toBe('nosniff')
			expect(res.headers.get('etag')).toBe('"v1"')
			expect(res.headers.get('content-security-policy')).toContain("default-src 'none'")
			expect(storageProvider.get).toHaveBeenCalledWith(`avatars/${AGENT_ID}/v1`)
			expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG)
		})

		it('answers 304 when the browser already has this version', async () => {
			const { app, mockResults, storageProvider } = createImportTestApp(
				actorAvatarRoutes,
				'/api/actors',
			)
			mockResults.selectQueue = [[{ type: 'agent', metadata: { avatar_version: 'v1' } }]]

			const res = await app.request(
				jsonGet(`/api/actors/${AGENT_ID}/avatar`, { 'If-None-Match': '"v1"' }),
			)

			expect(res.status).toBe(304)
			expect(storageProvider.get).not.toHaveBeenCalled()
		})

		it('returns 404 when the actor is a human, even with a stored picture', async () => {
			const { app, mockResults } = createImportTestApp(actorAvatarRoutes, '/api/actors')
			mockResults.selectQueue = [[{ type: 'human', metadata: { avatar_version: 'v1' } }]]

			const res = await app.request(jsonGet(`/api/actors/${AGENT_ID}/avatar`))

			expect(res.status).toBe(404)
		})

		it('returns 404 when the actor has no avatar', async () => {
			const { app, mockResults } = createImportTestApp(actorAvatarRoutes, '/api/actors')
			mockResults.selectQueue = [[{ type: 'agent', metadata: null }]]

			const res = await app.request(jsonGet(`/api/actors/${AGENT_ID}/avatar`))

			expect(res.status).toBe(404)
		})
	})
})
