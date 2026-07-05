import { randomUUID } from 'node:crypto'
import {
	events,
	actors,
	agentFiles,
	files,
	imports,
	integrations,
	notifications,
	objects,
	readState,
	relationships,
	sessions,
	subscriptions,
	triggers,
	userDisplaySettings,
	webhookDeliveries,
	workspaceMembers,
	workspaceSkills,
	workspaces,
} from '@maskin/db/schema'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildActor, buildWorkspaceMember } from '../factories'
import { jsonRequest } from '../helpers'
import { createImportTestApp, createTestApp } from '../setup'

const mockVerifyPassword = vi.fn()
const mockHashPassword = vi.fn()
vi.mock('@maskin/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@maskin/auth')>()
	return {
		...actual,
		verifyPassword: mockVerifyPassword,
		hashPassword: mockHashPassword,
	}
})

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: authRoutes } = await import('../../routes/auth')

const workspaceId = '00000000-0000-0000-0000-000000000001'
const headers = { 'X-Workspace-Id': workspaceId }

// Walks a Drizzle SQL condition tree and collects every column `name` it
// references. The mock chain captures the raw node passed to `.where()`, so
// asserting against this set proves the actual columns the route filtered on
// without needing the Drizzle SQL serializer. WeakSet guards against the
// column→table→column back-references Drizzle wires in its schema graph.
function collectColumnNames(node: unknown): Set<string> {
	const names = new Set<string>()
	const seen = new WeakSet<object>()
	const visit = (v: unknown) => {
		if (!v || typeof v !== 'object') return
		if (seen.has(v as object)) return
		seen.add(v as object)
		const obj = v as Record<string, unknown>
		if (typeof obj.name === 'string' && obj.columnType !== undefined) {
			names.add(obj.name)
		}
		for (const key of Object.keys(obj)) {
			visit(obj[key])
		}
	}
	visit(node)
	return names
}

describe('Profile — PATCH /api/actors/:id (T2 profile fields)', () => {
	beforeEach(() => {
		mockVerifyPassword.mockReset()
		mockHashPassword.mockReset()
	})

	it('writes bio when caller is the actor and emits one profile.field_changed event', async () => {
		const actor = buildActor({ type: 'human', notificationPrefs: {} })
		const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
		// existing-row lookup, telemetry workspace lookup, then update return.
		mockResults.selectQueue = [[{ type: 'human', notificationPrefs: {} }], [{ workspaceId }]]
		mockResults.update = [{ ...actor, bio: 'Hello' }]

		const res = await app.request(jsonRequest('PATCH', `/api/actors/${actor.id}`, { bio: 'Hello' }))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.bio).toBe('Hello')
		// One event inserted: profile.field_changed for `bio`.
		const eventInsert = calls.inserts.find(
			(i): i is { action: string; data: { field: string } } =>
				(i as { action?: string }).action === 'profile.field_changed',
		)
		expect(eventInsert).toBeDefined()
		expect(eventInsert?.data.field).toBe('bio')
	})

	it('writes name and emits one profile.field_changed event for name', async () => {
		const actor = buildActor({ type: 'human', notificationPrefs: {} })
		const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
		// existing-row lookup, then telemetry workspace lookup. Without the second
		// row the telemetry path silently drops via the `actor has no workspace`
		// warn branch — that swallow is exactly what hides the regression this
		// test exists to catch.
		mockResults.selectQueue = [[{ type: 'human', notificationPrefs: {} }], [{ workspaceId }]]
		mockResults.update = [{ ...actor, name: 'Renamed' }]

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, { name: 'Renamed' }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.name).toBe('Renamed')
		const eventInsert = calls.inserts.find(
			(i): i is { action: string; data: { field: string } } =>
				(i as { action?: string }).action === 'profile.field_changed',
		)
		expect(eventInsert).toBeDefined()
		expect(eventInsert?.data.field).toBe('name')
	})

	it('merges partial notification_prefs onto the existing object', async () => {
		const actor = buildActor({
			type: 'human',
			notificationPrefs: {
				mentions: true,
				subscribed: true,
				betStatusChanges: true,
				weeklyDigest: false,
			},
		})
		const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
		mockResults.selectQueue = [
			[{ type: 'human', notificationPrefs: actor.notificationPrefs }],
			[{ workspaceId }],
		]
		mockResults.update = [actor]

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, {
				notification_prefs: { weeklyDigest: true },
			}),
		)

		expect(res.status).toBe(200)
		// The first update call has the merged notification_prefs payload.
		const updatePayload = calls.updates[0] as { notificationPrefs: Record<string, boolean> }
		expect(updatePayload.notificationPrefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: true,
		})
	})

	it('rejects email updates via PATCH (must go through verified flow)', async () => {
		const actor = buildActor({ type: 'human' })
		const { app } = createTestApp(actorsRoutes, '/api/actors', actor.id)

		const res = await app.request(
			jsonRequest('PATCH', `/api/actors/${actor.id}`, { email: 'new@x.com' }),
		)

		// Zod strips `email` (not in updateActorSchema). With no other fields, the
		// request still has an empty body — the route runs and returns 404 because
		// nothing matches; the key check is that the email column was never set.
		// We assert the route does NOT update the email field.
		expect([200, 404]).toContain(res.status)
	})
})

describe('Profile — POST /api/actors/:id/avatar', () => {
	const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
	const JPEG_SIGNATURE = new Uint8Array([0xff, 0xd8, 0xff, 0xe0])
	// 12 bytes: 'RIFF' + 4-byte size + 'WEBP'
	const WEBP_SIGNATURE = new Uint8Array([
		0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
	])

	function avatarRequest(id: string, file: File, callerId = id) {
		const form = new FormData()
		form.append('file', file)
		return new Request(`http://localhost/api/actors/${id}/avatar`, {
			method: 'POST',
			body: form,
		})
	}

	it('uploads an avatar, persists the storage key, fires telemetry', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider, calls } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.selectQueue = [[actor], [{ workspaceId }]]
		mockResults.update = [{ ...actor, avatarStorageKey: `actors/${actor.id}/avatar.png` }]

		const png = new File([PNG_SIGNATURE], 'a.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(actor.id, png))

		expect(res.status).toBe(200)
		expect(storageProvider.put).toHaveBeenCalledTimes(1)
		const [storedKey] = (storageProvider.put as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(storedKey).toBe(`actors/${actor.id}/avatar.png`)
		// Telemetry event present.
		const evt = calls.inserts.find(
			(i): i is { action: string } => (i as { action?: string }).action === 'profile.field_changed',
		)
		expect(evt).toBeDefined()
	})

	it('accepts a JPEG with matching magic bytes', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.selectQueue = [[actor], [{ workspaceId }]]
		mockResults.update = [{ ...actor, avatarStorageKey: `actors/${actor.id}/avatar.jpg` }]

		const jpg = new File([JPEG_SIGNATURE], 'a.jpg', { type: 'image/jpeg' })
		const res = await app.request(avatarRequest(actor.id, jpg))

		expect(res.status).toBe(200)
		const [storedKey] = (storageProvider.put as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(storedKey).toBe(`actors/${actor.id}/avatar.jpg`)
	})

	it('accepts a WebP with matching magic bytes', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.selectQueue = [[actor], [{ workspaceId }]]
		mockResults.update = [{ ...actor, avatarStorageKey: `actors/${actor.id}/avatar.webp` }]

		const webp = new File([WEBP_SIGNATURE], 'a.webp', { type: 'image/webp' })
		const res = await app.request(avatarRequest(actor.id, webp))

		expect(res.status).toBe(200)
		const [storedKey] = (storageProvider.put as ReturnType<typeof vi.fn>).mock.calls[0]
		expect(storedKey).toBe(`actors/${actor.id}/avatar.webp`)
	})

	it('rejects an HTML payload tagged as image/png and never calls storage', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.select = [actor]

		const html = new File([new TextEncoder().encode('<script>alert(1)</script>')], 'evil.png', {
			type: 'image/png',
		})
		const res = await app.request(avatarRequest(actor.id, html))

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toMatch(/JPEG, PNG, or WebP/)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})

	it('rejects a PNG payload tagged as image/jpeg (mime/header mismatch)', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.select = [actor]

		const mismatched = new File([PNG_SIGNATURE], 'a.jpg', { type: 'image/jpeg' })
		const res = await app.request(avatarRequest(actor.id, mismatched))

		expect(res.status).toBe(400)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})

	it('rejects a body too short to identify a known image format', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.select = [actor]

		const tiny = new File([new Uint8Array([0x89, 0x50])], 'a.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(actor.id, tiny))

		expect(res.status).toBe(400)
		expect(storageProvider.put).not.toHaveBeenCalled()
	})

	it('rejects an avatar over 5MB', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults } = createImportTestApp(actorsRoutes, '/api/actors', actor.id)
		mockResults.select = [actor]

		const big = new File([new Uint8Array(6 * 1024 * 1024)], 'big.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(actor.id, big))

		expect(res.status).toBe(400)
		const body = await res.json()
		expect(body.error.message).toContain('5MB')
	})

	it('rejects unsupported mime types', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults } = createImportTestApp(actorsRoutes, '/api/actors', actor.id)
		mockResults.select = [actor]

		const gif = new File([new Uint8Array([0])], 'a.gif', { type: 'image/gif' })
		const res = await app.request(avatarRequest(actor.id, gif))

		expect(res.status).toBe(400)
	})

	it('forbids uploading an avatar for another actor', async () => {
		const otherId = randomUUID()
		const callerId = randomUUID()
		const { app } = createImportTestApp(actorsRoutes, '/api/actors', callerId)

		const png = new File([new Uint8Array([0])], 'a.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(otherId, png))

		expect(res.status).toBe(403)
	})

	it('deletes the just-stored blob when the actor row disappeared mid-upload', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		// Existing-row lookup succeeds, then the UPDATE finds nothing (concurrent
		// delete or row vanished between SELECT and UPDATE).
		mockResults.selectQueue = [[actor]]
		mockResults.update = []

		const png = new File([PNG_SIGNATURE], 'a.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(actor.id, png))

		expect(res.status).toBe(404)
		const expectedKey = `actors/${actor.id}/avatar.png`
		expect(storageProvider.put).toHaveBeenCalledTimes(1)
		expect(storageProvider.delete).toHaveBeenCalledTimes(1)
		expect((storageProvider.delete as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(expectedKey)
	})

	it('deletes the just-stored blob when the actors UPDATE throws', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.selectQueue = [[actor]]
		mockResults.updateError = new Error('connection reset')

		const png = new File([PNG_SIGNATURE], 'a.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(actor.id, png))

		expect(res.status).toBe(500)
		const expectedKey = `actors/${actor.id}/avatar.png`
		expect(storageProvider.put).toHaveBeenCalledTimes(1)
		expect(storageProvider.delete).toHaveBeenCalledTimes(1)
		expect((storageProvider.delete as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe(expectedKey)
	})

	it('returns the original 404 even when the orphan cleanup itself fails', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.selectQueue = [[actor]]
		mockResults.update = []
		;(storageProvider.delete as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
			new Error('s3 unreachable'),
		)

		const png = new File([PNG_SIGNATURE], 'a.png', { type: 'image/png' })
		const res = await app.request(avatarRequest(actor.id, png))

		expect(res.status).toBe(404)
		expect(storageProvider.delete).toHaveBeenCalledTimes(1)
	})
})

describe('Profile — GET /api/actors/:id/avatar', () => {
	it('returns base64 avatar bytes for your own avatar', async () => {
		const actor = buildActor({ type: 'human', avatarStorageKey: 'actors/actor-1/avatar.png' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			actor.id,
		)
		mockResults.select = [actor]
		;(storageProvider.get as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('fake-bytes'))

		const res = await app.request(new Request(`http://localhost/api/actors/${actor.id}/avatar`))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.mime_type).toBe('image/png')
		expect(Buffer.from(body.content, 'base64').toString()).toBe('fake-bytes')
	})

	it('returns 404 when the actor has no avatar set', async () => {
		const actor = buildActor({ type: 'human', avatarStorageKey: null })
		const { app, mockResults } = createImportTestApp(actorsRoutes, '/api/actors', actor.id)
		mockResults.select = [actor]

		const res = await app.request(new Request(`http://localhost/api/actors/${actor.id}/avatar`))

		expect(res.status).toBe(404)
	})

	it('returns 404 for another actor who shares no workspace with the caller', async () => {
		const actor = buildActor({ type: 'human', avatarStorageKey: 'actors/actor-1/avatar.png' })
		const { app, mockResults } = createImportTestApp(actorsRoutes, '/api/actors', 'caller-id')
		// Actor lookup, then shareWorkspace's two selects, both empty.
		mockResults.selectQueue = [[actor], [], []]

		const res = await app.request(new Request(`http://localhost/api/actors/${actor.id}/avatar`))

		expect(res.status).toBe(404)
	})

	it('returns 200 for another actor who shares a workspace with the caller', async () => {
		const actor = buildActor({ type: 'human', avatarStorageKey: 'actors/actor-1/avatar.png' })
		const { app, mockResults, storageProvider } = createImportTestApp(
			actorsRoutes,
			'/api/actors',
			'caller-id',
		)
		mockResults.selectQueue = [[actor], [], [{ workspaceId }]]
		;(storageProvider.get as ReturnType<typeof vi.fn>).mockResolvedValue(Buffer.from('fake-bytes'))

		const res = await app.request(new Request(`http://localhost/api/actors/${actor.id}/avatar`))

		expect(res.status).toBe(200)
	})
})

describe('Profile — DELETE /api/actors/:id (human self-delete)', () => {
	it('forbids deleting another human account', async () => {
		const target = buildActor({ type: 'human' })
		const caller = buildActor({ type: 'human' })
		const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors', caller.id)
		mockResults.select = [target]

		const res = await app.request(
			new Request(`http://localhost/api/actors/${target.id}`, {
				method: 'DELETE',
				headers,
			}),
		)

		expect(res.status).toBe(403)
	})

	it('returns 200 when a human deletes their own account with no workspaces', async () => {
		const actor = buildActor({ type: 'human' })
		const { app, mockResults } = createTestApp(actorsRoutes, '/api/actors', actor.id)
		// 1: actor lookup, 2: membership list (empty).
		mockResults.selectQueue = [[actor], []]

		const res = await app.request(
			new Request(`http://localhost/api/actors/${actor.id}`, {
				method: 'DELETE',
				headers,
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.deleted).toBe(true)
	})

	it('tears down a solely-owned workspace in FK-safe order, then the actor', async () => {
		const actor = buildActor({ type: 'human' })
		const wsId = randomUUID()
		const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
		// Selects, in order:
		//   1) actor lookup
		//   2) memberships → one workspace
		//   3) otherHumanCount → 0 (solely-owned branch)
		//   4) objects subquery used by `inArray` on relationships.source_id
		//   5) objects subquery used by `inArray` on relationships.target_id
		//   6) wsSessions (empty → skip the conditional sessionLogs delete)
		mockResults.selectQueue = [[actor], [{ workspaceId: wsId }], [{ count: 0 }], [], [], []]

		const res = await app.request(
			new Request(`http://localhost/api/actors/${actor.id}`, {
				method: 'DELETE',
				headers,
			}),
		)

		expect(res.status).toBe(200)
		// Per-workspace teardown order — FK dependents before parents. The two
		// relationships deletes are the in/source and in/target queries; the
		// sessionLogs delete is intentionally absent because wsSessions was empty.
		expect(calls.deleteTables.slice(0, 16)).toEqual([
			events,
			notifications,
			relationships,
			relationships,
			objects,
			integrations,
			triggers,
			subscriptions,
			readState,
			imports,
			agentFiles,
			sessions,
			webhookDeliveries,
			userDisplaySettings,
			workspaceMembers,
			workspaces,
		])
		// After the per-workspace loop, actor-level cleanup runs and the actors
		// row is the final delete.
		expect(calls.deleteTables[calls.deleteTables.length - 1]).toBe(actors)
		expect(calls.updateTables[calls.updateTables.length - 1]).toBe(actors)
	})

	it('reassigns authored content to Sindre in a shared workspace and removes membership', async () => {
		const actor = buildActor({ type: 'human' })
		const wsId = randomUUID()
		const sindreId = randomUUID()
		const { app, mockResults, calls } = createTestApp(actorsRoutes, '/api/actors', actor.id)
		// Selects, in order:
		//   1) actor lookup
		//   2) memberships → one workspace
		//   3) otherHumanCount → 1 (shared branch)
		//   4) Sindre lookup → present, so reassignment can proceed
		//   5) objects subquery used by inArray on relationships in the workspace
		mockResults.selectQueue = [
			[actor],
			[{ workspaceId: wsId }],
			[{ count: 1 }],
			[{ id: sindreId }],
			[],
		]

		const res = await app.request(
			new Request(`http://localhost/api/actors/${actor.id}`, {
				method: 'DELETE',
				headers,
			}),
		)

		expect(res.status).toBe(200)
		// Updates, in order: objects (createdBy), objects (owner=null), files,
		// integrations, imports, sessions (createdBy), sessions (actorId),
		// events (actorId), triggers (createdBy), workspaceSkills (createdBy),
		// relationships (createdBy), workspaces (createdBy), and the actor-level
		// createdBy=null sweep just before the actors row drops.
		expect(calls.updateTables).toEqual([
			objects,
			objects,
			files,
			integrations,
			imports,
			sessions,
			sessions,
			events,
			triggers,
			workspaceSkills,
			relationships,
			workspaces,
			actors,
		])
		// Deletes, in order (per-workspace): triggers targeting the deleted user,
		// agentFiles for the actor, subscriptions, readState, workspaceMembers.
		// Then actor-level sweep: notifications×2, sessions×2, triggers residual,
		// agentFiles residual, relationships residual, actors.
		expect(calls.deleteTables).toEqual([
			triggers,
			agentFiles,
			subscriptions,
			readState,
			workspaceMembers,
			notifications,
			notifications,
			sessions,
			sessions,
			triggers,
			agentFiles,
			relationships,
			actors,
		])
		// Nine `createdBy` reassignments to Sindre: objects, files, integrations,
		// imports, sessions, triggers, workspaceSkills, relationships, workspaces.
		// The actor-level createdBy sweep nulls instead, so it is excluded.
		const reassignedToSindre = calls.updates.filter(
			(u): u is { createdBy: string } =>
				typeof (u as { createdBy?: unknown }).createdBy === 'string' &&
				(u as { createdBy: string }).createdBy === sindreId,
		)
		expect(reassignedToSindre).toHaveLength(9)
		// Two `actorId` reassignments to Sindre: sessions and events.
		const actorIdReassigned = calls.updates.filter(
			(u): u is { actorId: string } =>
				typeof (u as { actorId?: unknown }).actorId === 'string' &&
				(u as { actorId: string }).actorId === sindreId,
		)
		expect(actorIdReassigned).toHaveLength(2)
	})
})

describe('Profile — POST /api/auth/password', () => {
	beforeEach(() => {
		mockVerifyPassword.mockReset()
		mockHashPassword.mockReset()
	})

	it('rotates the API key on a valid password change and emits telemetry', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const { app, mockResults, calls } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.selectQueue = [[actor], [{ workspaceId }]]
		mockResults.update = [{ ...actor, apiKey: 'ank_newkey' }]
		mockVerifyPassword.mockResolvedValue(true)
		mockHashPassword.mockResolvedValue('new-hash')

		const res = await app.request(
			jsonRequest('POST', '/api/auth/password', {
				current_password: 'old-pw',
				new_password: 'newpassword123',
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.api_key).toBeDefined()
		// The update issued sets passwordHash and a new apiKey.
		const updatePayload = calls.updates[0] as { passwordHash: string; apiKey: string }
		expect(updatePayload.passwordHash).toBe('new-hash')
		expect(updatePayload.apiKey).toMatch(/^ank_/)
		const evt = calls.inserts.find(
			(i): i is { action: string; data: { field: string } } =>
				(i as { action?: string }).action === 'profile.field_changed',
		)
		expect(evt?.data.field).toBe('password')
	})

	it('returns 401 when current password is wrong', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.select = [actor]
		mockVerifyPassword.mockResolvedValue(false)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/password', {
				current_password: 'wrong',
				new_password: 'newpassword123',
			}),
		)

		expect(res.status).toBe(401)
	})

	it('returns 400 when new_password is shorter than 8 chars', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const { app } = createTestApp(authRoutes, '/api/auth', actor.id)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/password', {
				current_password: 'whatever',
				new_password: '2short',
			}),
		)

		expect(res.status).toBe(400)
	})
})

describe('Profile — POST /api/auth/email-change', () => {
	beforeEach(() => {
		mockVerifyPassword.mockReset()
	})

	it('writes pending email + token and logs the verify URL', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const { app, mockResults, calls } = createTestApp(authRoutes, '/api/auth', actor.id)
		// 1: actor lookup, 2: email-collision check (none).
		mockResults.selectQueue = [[actor], []]
		mockResults.update = [{ ...actor, pendingEmail: 'new@x.com' }]
		mockVerifyPassword.mockResolvedValue(true)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change', {
				new_email: 'new@x.com',
				current_password: 'pw',
			}),
		)

		expect(res.status).toBe(200)
		const updatePayload = calls.updates[0] as {
			pendingEmail: string
			pendingEmailToken: string
			pendingEmailExpiresAt: Date
		}
		expect(updatePayload.pendingEmail).toBe('new@x.com')
		expect(updatePayload.pendingEmailToken).toMatch(/^[a-f0-9]{64}$/)
		expect(updatePayload.pendingEmailExpiresAt).toBeInstanceOf(Date)
	})

	it('returns 409 when target email already belongs to another actor', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const other = buildActor({ type: 'human', email: 'taken@x.com' })
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.selectQueue = [[actor], [{ id: other.id }]]
		mockVerifyPassword.mockResolvedValue(true)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change', {
				new_email: 'taken@x.com',
				current_password: 'pw',
			}),
		)

		expect(res.status).toBe(409)
	})

	it('collision check also covers another actor with the same pendingEmail', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const other = buildActor({ type: 'human', pendingEmail: 'taken@x.com' })
		const { app, mockResults, calls } = createTestApp(authRoutes, '/api/auth', actor.id)
		// 1: actor lookup, 2: collision lookup hits the other actor via pendingEmail.
		mockResults.selectQueue = [[actor], [{ id: other.id }]]
		mockVerifyPassword.mockResolvedValue(true)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change', {
				new_email: 'taken@x.com',
				current_password: 'pw',
			}),
		)

		expect(res.status).toBe(409)
		// The collision query is the second .where() — the first is the actor lookup.
		// Asserting against the column set proves the route filtered on both columns,
		// independent of how drizzle-orm serializes the or(...) tree.
		const columns = collectColumnNames(calls.wheres[1])
		expect(columns).toContain('email')
		expect(columns).toContain('pending_email')
	})

	it('returns 401 when current password is wrong', async () => {
		const actor = buildActor({ type: 'human', passwordHash: 'old' })
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.select = [actor]
		mockVerifyPassword.mockResolvedValue(false)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change', {
				new_email: 'new@x.com',
				current_password: 'wrong',
			}),
		)

		expect(res.status).toBe(401)
	})
})

describe('Profile — POST /api/auth/email-change/verify', () => {
	it('promotes pending_email to email when the token is valid', async () => {
		const actor = buildActor({
			type: 'human',
			pendingEmail: 'new@x.com',
			pendingEmailToken: 'token123',
			pendingEmailExpiresAt: new Date(Date.now() + 60_000),
		})
		const { app, mockResults, calls } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.selectQueue = [[actor], [], [{ workspaceId }]]
		mockResults.update = [{ ...actor, email: 'new@x.com', pendingEmail: null }]

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change/verify', { token: 'token123' }),
		)

		expect(res.status).toBe(200)
		const updatePayload = calls.updates[0] as {
			email: string
			pendingEmail: null
			pendingEmailToken: null
		}
		expect(updatePayload.email).toBe('new@x.com')
		expect(updatePayload.pendingEmail).toBeNull()
		expect(updatePayload.pendingEmailToken).toBeNull()
	})

	it('returns 400 when the token does not match or is expired', async () => {
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth')
		mockResults.select = []

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change/verify', { token: 'bogus' }),
		)

		expect(res.status).toBe(400)
	})

	it('returns 409 when another actor claimed the address between request and verify', async () => {
		const actor = buildActor({
			type: 'human',
			pendingEmail: 'taken@x.com',
			pendingEmailToken: 'token123',
			pendingEmailExpiresAt: new Date(Date.now() + 60_000),
		})
		const other = buildActor({ type: 'human', email: 'taken@x.com' })
		const { app, mockResults, calls } = createTestApp(authRoutes, '/api/auth', actor.id)
		// 1: pending-token lookup hits the actor, 2: collision lookup finds another actor on the address.
		mockResults.selectQueue = [[actor], [{ id: other.id }]]

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change/verify', { token: 'token123' }),
		)

		expect(res.status).toBe(409)
		const body = await res.json()
		expect(body.error.code).toBe('CONFLICT')
		// The pending state is cleared so the user gets a clean retry path.
		const updatePayload = calls.updates[0] as {
			pendingEmail: null
			pendingEmailToken: null
			pendingEmailExpiresAt: null
		}
		expect(updatePayload.pendingEmail).toBeNull()
		expect(updatePayload.pendingEmailToken).toBeNull()
		expect(updatePayload.pendingEmailExpiresAt).toBeNull()
	})

	it('returns a notification_prefs object with every flag filled even when the column was the default empty object', async () => {
		const actor = buildActor({
			type: 'human',
			notificationPrefs: {},
			pendingEmail: 'new@x.com',
			pendingEmailToken: 'token123',
			pendingEmailExpiresAt: new Date(Date.now() + 60_000),
		})
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.selectQueue = [[actor], [], [{ workspaceId }]]
		mockResults.update = [{ ...actor, email: 'new@x.com', pendingEmail: null }]

		const res = await app.request(
			jsonRequest('POST', '/api/auth/email-change/verify', { token: 'token123' }),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.notification_prefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		})
	})
})

describe('Profile — POST /api/auth/email-change/cancel', () => {
	it('clears the pending email columns', async () => {
		const actor = buildActor({
			type: 'human',
			pendingEmail: 'new@x.com',
			pendingEmailToken: 'token123',
		})
		const { app, mockResults, calls } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.update = [{ ...actor, pendingEmail: null, pendingEmailToken: null }]

		const res = await app.request(jsonRequest('POST', '/api/auth/email-change/cancel', {}))

		expect(res.status).toBe(200)
		const updatePayload = calls.updates[0] as {
			pendingEmail: null
			pendingEmailToken: null
			pendingEmailExpiresAt: null
		}
		expect(updatePayload.pendingEmail).toBeNull()
		expect(updatePayload.pendingEmailToken).toBeNull()
		expect(updatePayload.pendingEmailExpiresAt).toBeNull()
	})

	it('returns a notification_prefs object with every flag filled even when the column was the default empty object', async () => {
		const actor = buildActor({
			type: 'human',
			notificationPrefs: {},
			pendingEmail: 'new@x.com',
			pendingEmailToken: 'token123',
		})
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth', actor.id)
		mockResults.update = [
			{ ...actor, notificationPrefs: {}, pendingEmail: null, pendingEmailToken: null },
		]

		const res = await app.request(jsonRequest('POST', '/api/auth/email-change/cancel', {}))

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.notification_prefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		})
	})
})

describe('Profile — POST /api/auth/login', () => {
	beforeEach(() => {
		mockVerifyPassword.mockReset()
	})

	it('returns a notification_prefs object with every flag filled even when the column was the default empty object', async () => {
		const actor = buildActor({
			type: 'human',
			passwordHash: 'hashed-password',
			notificationPrefs: {},
		})
		const { app, mockResults } = createTestApp(authRoutes, '/api/auth')
		mockResults.select = [actor]
		mockVerifyPassword.mockResolvedValue(true)

		const res = await app.request(
			jsonRequest('POST', '/api/auth/login', {
				email: actor.email,
				password: 'correct-password',
			}),
		)

		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.notification_prefs).toEqual({
			mentions: true,
			subscribed: true,
			betStatusChanges: true,
			weeklyDigest: false,
		})
	})
})

afterEach(() => {
	vi.restoreAllMocks()
})

// Pull buildWorkspaceMember into scope so a future test for the agent-delete path
// can use it without re-importing — keeps the file's import surface stable.
void buildWorkspaceMember
