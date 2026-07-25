import { randomUUID } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActor, buildWorkspaceMember } from '../factories'
import { createImportTestApp } from '../setup'

const { default: actorAvatarUploadRoutes } = await import('../../routes/actor-avatar-upload')

const workspaceId = '11111111-1111-1111-1111-111111111111'
const actorId = '22222222-2222-2222-2222-222222222222'
const callerId = 'test-actor-id'

// Minimal 1×1 PNG. sharp() decodes and re-encodes it into a 256×256 avatar.
const ONE_PX_PNG = Buffer.from(
	'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQI12P4//8/AwAI/AL+jN2XVwAAAABJRU5ErkJggg==',
	'base64',
)

function multipartRequest(
	path: string,
	filename: string,
	mime: string,
	bytes: Buffer,
	headers: Record<string, string> = {},
) {
	const form = new FormData()
	form.append('file', new Blob([new Uint8Array(bytes)], { type: mime }), filename)
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		body: form,
		headers,
	})
}

describe('POST /api/actors/:id/avatar', () => {
	beforeEach(() => {
		vi.stubEnv('FRONTEND_URL', 'http://localhost:5173')
	})
	afterEach(() => {
		vi.restoreAllMocks()
		vi.unstubAllEnvs()
	})

	it('uploads a PNG, resizes with sharp, stores in S3, updates avatar_url', async () => {
		const { app, mockResults, storageProvider, calls } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const admin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'admin' })
		const target = buildWorkspaceMember({ workspaceId, actorId, role: 'member' })
		const updated = buildActor({ id: actorId })
		mockResults.selectQueue = [[admin], [target]]
		mockResults.update = [
			{ ...updated, avatar_url: `http://localhost:5173/api/actors/${actorId}/avatar?v=1` },
		]

		const res = await app.request(
			multipartRequest(`/api/actors/${actorId}/avatar`, 'me.png', 'image/png', ONE_PX_PNG, {
				'X-Workspace-Id': workspaceId,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.avatar_url).toMatch(new RegExp(`/api/actors/${actorId}/avatar\\?v=\\d+`))
		expect(storageProvider.put).toHaveBeenCalledTimes(1)
		const putCall = vi.mocked(storageProvider.put).mock.calls[0]
		expect(putCall).toBeDefined()
		const [key, buf] = putCall as [string, Buffer]
		expect(key).toBe(`workspaces/${workspaceId}/avatars/${actorId}.png`)
		expect(buf).toBeInstanceOf(Buffer)
		expect((buf as Buffer).byteLength).toBeGreaterThan(0)
		// The PATCH must set avatarUrl (Drizzle column name), not the wire name.
		const setArg = calls.updates[0] as Record<string, unknown>
		expect(typeof setArg.avatarUrl).toBe('string')
	})

	it('accepts a JPEG and writes it with a .jpg key', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const admin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'owner' })
		const target = buildWorkspaceMember({ workspaceId, actorId, role: 'member' })
		mockResults.selectQueue = [[admin], [target]]
		mockResults.update = [buildActor({ id: actorId })]

		// A minimal valid JPEG produced by re-encoding the 1×1 PNG through sharp
		// at test bootstrap. Building it lazily avoids a static base64 blob.
		const sharpMod = await import('sharp')
		const jpg = await sharpMod.default(ONE_PX_PNG).jpeg().toBuffer()

		const res = await app.request(
			multipartRequest(`/api/actors/${actorId}/avatar`, 'me.jpg', 'image/jpeg', jpg, {
				'X-Workspace-Id': workspaceId,
			}),
		)

		expect(res.status).toBe(200)
		expect(storageProvider.put).toHaveBeenCalledTimes(1)
		const putCall = vi.mocked(storageProvider.put).mock.calls[0]
		expect(putCall).toBeDefined()
		const [key] = putCall as [string, Buffer]
		expect(key).toBe(`workspaces/${workspaceId}/avatars/${actorId}.jpg`)
	})

	it('returns 415 for a non-image content type', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const admin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'admin' })
		const target = buildWorkspaceMember({ workspaceId, actorId, role: 'member' })
		mockResults.selectQueue = [[admin], [target]]

		const res = await app.request(
			multipartRequest(
				`/api/actors/${actorId}/avatar`,
				'notes.txt',
				'text/plain',
				Buffer.from('hi'),
				{ 'X-Workspace-Id': workspaceId },
			),
		)

		expect(res.status).toBe(415)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})

	it('returns 413 for an oversized file (post-buffer check)', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const admin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'admin' })
		const target = buildWorkspaceMember({ workspaceId, actorId, role: 'member' })
		mockResults.selectQueue = [[admin], [target]]

		// 2MB + 1 byte of fake PNG data — must be rejected before sharp runs.
		const oversized = Buffer.alloc(2 * 1024 * 1024 + 1, 0x89)

		const res = await app.request(
			multipartRequest(`/api/actors/${actorId}/avatar`, 'big.png', 'image/png', oversized, {
				'X-Workspace-Id': workspaceId,
			}),
		)

		expect(res.status).toBe(413)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})

	it('returns 403 when caller is a plain workspace member (not admin)', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const notAdmin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'member' })
		mockResults.selectQueue = [[notAdmin]]

		const res = await app.request(
			multipartRequest(`/api/actors/${actorId}/avatar`, 'me.png', 'image/png', ONE_PX_PNG, {
				'X-Workspace-Id': workspaceId,
			}),
		)

		expect(res.status).toBe(403)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})

	it('returns 404 when the target actor is not a member of the workspace', async () => {
		const { app, mockResults } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const admin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'admin' })
		mockResults.selectQueue = [[admin], []]

		const res = await app.request(
			multipartRequest(`/api/actors/${actorId}/avatar`, 'me.png', 'image/png', ONE_PX_PNG, {
				'X-Workspace-Id': workspaceId,
			}),
		)

		expect(res.status).toBe(404)
	})

	it('returns 400 when the file bytes are not a decodable image', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const admin = buildWorkspaceMember({ workspaceId, actorId: callerId, role: 'admin' })
		const target = buildWorkspaceMember({ workspaceId, actorId, role: 'member' })
		mockResults.selectQueue = [[admin], [target]]

		const res = await app.request(
			multipartRequest(
				`/api/actors/${actorId}/avatar`,
				'me.png',
				'image/png',
				Buffer.from('not an image'),
				{ 'X-Workspace-Id': workspaceId },
			),
		)

		expect(res.status).toBe(400)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})
})

describe('GET /api/actors/:id/avatar', () => {
	it('serves the PNG bytes when the actor has an uploaded avatar', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		const targetActor = { id: actorId, avatarUrl: 'http://x/y' }
		const membership = { workspaceId }
		mockResults.selectQueue = [[targetActor], [membership]]
		const pngBytes = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])
		vi.mocked(storageProvider.exists).mockResolvedValueOnce(true)
		vi.mocked(storageProvider.get).mockResolvedValueOnce(pngBytes)

		const res = await app.request(`/api/actors/${actorId}/avatar`)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/png')
		const buf = Buffer.from(await res.arrayBuffer())
		expect(buf.equals(pngBytes)).toBe(true)
	})

	it('falls back to the JPG key when no PNG exists', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		mockResults.selectQueue = [[{ id: actorId, avatarUrl: 'http://x/y' }], [{ workspaceId }]]
		const jpgBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0])
		vi.mocked(storageProvider.exists).mockResolvedValueOnce(false).mockResolvedValueOnce(true)
		vi.mocked(storageProvider.get).mockResolvedValueOnce(jpgBytes)

		const res = await app.request(`/api/actors/${actorId}/avatar`)

		expect(res.status).toBe(200)
		expect(res.headers.get('content-type')).toBe('image/jpeg')
	})

	it('returns 404 when the actor has no avatar_url set', async () => {
		const { app, mockResults } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		mockResults.selectQueue = [[{ id: actorId, avatarUrl: null }]]

		const res = await app.request(`/api/actors/${randomUUID()}/avatar`)

		expect(res.status).toBe(404)
	})

	it('returns 404 when neither PNG nor JPG object exists in storage', async () => {
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorAvatarUploadRoutes,
			'/api/actors',
			callerId,
		)
		mockResults.selectQueue = [[{ id: actorId, avatarUrl: 'http://x/y' }], [{ workspaceId }]]
		vi.mocked(storageProvider.exists).mockResolvedValue(false)

		const res = await app.request(`/api/actors/${actorId}/avatar`)

		expect(res.status).toBe(404)
	})
})
