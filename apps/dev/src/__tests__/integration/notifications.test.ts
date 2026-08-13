import { events, notifications } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { buildCreateNotificationBody, insertNotification, insertWorkspace } from '../factories'
import { jsonDelete, jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: notificationsRoutes } = await import('../../routes/notifications')

function createApp() {
	return createIntegrationApp({ path: '/api/notifications', module: notificationsRoutes })
}

describe('Notifications Integration', () => {
	let workspaceId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
	})

	describe('CRUD lifecycle', () => {
		it('creates, reads, updates, responds, and deletes a notification', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications',
					buildCreateNotificationBody({ source_actor_id: getTestActorId() }),
					headers,
				),
			)
			expect(createRes.status).toBe(201)
			const created = await createRes.json()
			expect(created.id).toBeDefined()
			expect(created.status).toBe('pending')
			expect(created.workspaceId).toBe(workspaceId)

			// List
			const listRes = await app.request(jsonGet('/api/notifications', headers))
			expect(listRes.status).toBe(200)
			const list = await listRes.json()
			expect(list.length).toBeGreaterThanOrEqual(1)

			// Get by ID
			const getRes = await app.request(jsonGet(`/api/notifications/${created.id}`))
			expect(getRes.status).toBe(200)
			const fetched = await getRes.json()
			expect(fetched.id).toBe(created.id)

			// Update
			const updateRes = await app.request(
				jsonRequest('PATCH', `/api/notifications/${created.id}`, { status: 'seen' }, headers),
			)
			expect(updateRes.status).toBe(200)
			const updated = await updateRes.json()
			expect(updated.status).toBe('seen')

			// Respond
			const respondRes = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${created.id}/respond`,
					{ response: 'Approved by human' },
					headers,
				),
			)
			expect(respondRes.status).toBe(200)
			const responded = await respondRes.json()
			expect(responded.status).toBe('resolved')

			// Respond again should fail
			const respondAgainRes = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${created.id}/respond`,
					{ response: 'Too late' },
					headers,
				),
			)
			expect(respondAgainRes.status).toBe(400)

			// Delete
			const deleteRes = await app.request(
				jsonRequest('DELETE', `/api/notifications/${created.id}`, undefined, headers),
			)
			expect(deleteRes.status).toBe(200)

			// Verify deleted
			const getDeletedRes = await app.request(jsonGet(`/api/notifications/${created.id}`))
			expect(getDeletedRes.status).toBe(404)
		})
	})

	describe('events audit trail', () => {
		it('creates events for mutations', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			// Create notification
			const createRes = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications',
					buildCreateNotificationBody({ source_actor_id: getTestActorId() }),
					headers,
				),
			)
			const created = await createRes.json()

			// Check events were created
			const auditEvents = await db.select().from(events).where(eq(events.entityId, created.id))

			expect(auditEvents.length).toBeGreaterThanOrEqual(1)
			expect(auditEvents.some((e) => e.action === 'created')).toBe(true)
		})
	})

	describe('deferred wake dispatch', () => {
		it('respond writes dispatch_at + wake_dispatched=false (default)', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const n = await insertNotification(db, workspaceId, getTestActorId())

			const respondRes = await app.request(
				jsonRequest('POST', `/api/notifications/${n.id}/respond`, { response: 'ok' }, headers),
			)
			expect(respondRes.status).toBe(200)

			const [row] = await db.select().from(notifications).where(eq(notifications.id, n.id)).limit(1)
			expect(row.status).toBe('resolved')
			expect(row.dispatchAt).toBeInstanceOf(Date)
			expect(row.wakeDispatched).toBe(false)
			// dispatch_at must be ~6s in the future (server clock) — tolerate a
			// generous 2s clock skew on slow CI runners.
			expect(row.dispatchAt).not.toBeNull()
			const delta = (row.dispatchAt as Date).getTime() - Date.now()
			expect(delta).toBeGreaterThan(3500)
			expect(delta).toBeLessThan(8500)
		})

		it('respond?dispatch=immediate does NOT write dispatch_at', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const n = await insertNotification(db, workspaceId, getTestActorId())

			const respondRes = await app.request(
				jsonRequest(
					'POST',
					`/api/notifications/${n.id}/respond?dispatch=immediate`,
					{ response: 'ok' },
					headers,
				),
			)
			expect(respondRes.status).toBe(200)

			const [row] = await db.select().from(notifications).where(eq(notifications.id, n.id)).limit(1)
			expect(row.status).toBe('resolved')
			expect(row.dispatchAt).toBeNull()
			expect(row.wakeDispatched).toBe(false)
		})
	})

	describe('bulk-respond', () => {
		it('resolves N notifications and dedupes dispatch_at by sourceActorId', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const actorId = getTestActorId()
			const n1 = await insertNotification(db, workspaceId, actorId)
			const n2 = await insertNotification(db, workspaceId, actorId)
			// n3 shares sourceActorId with n1/n2 (all use actorId as source)
			const n3 = await insertNotification(db, workspaceId, actorId)

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond',
					{ ids: [n1.id, n2.id, n3.id], response: 'approve_all' },
					headers,
				),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body).toHaveLength(3)
			expect(body.every((r: { status: string }) => r.status === 'resolved')).toBe(true)

			// All three rows resolved in DB
			const rows = await db
				.select()
				.from(notifications)
				.where(eq(notifications.workspaceId, workspaceId))
			expect(rows.every((r) => r.status === 'resolved')).toBe(true)

			// Dedupe: same sourceActorId → only ONE row got dispatch_at set
			const withDispatch = rows.filter((r) => r.dispatchAt !== null)
			expect(withDispatch).toHaveLength(1)

			// Audit events emitted for each row
			const auditRows = await db.select().from(events).where(eq(events.workspaceId, workspaceId))
			const respondedEvents = auditRows.filter((e) => e.action === 'responded')
			expect(respondedEvents).toHaveLength(3)
		})

		it('returns 400 when any id is missing and rolls back', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const n1 = await insertNotification(db, workspaceId, getTestActorId())

			const res = await app.request(
				jsonRequest(
					'POST',
					'/api/notifications/bulk-respond',
					{ ids: [n1.id, '00000000-0000-0000-0000-000000000099'], response: 'x' },
					headers,
				),
			)

			expect(res.status).toBe(400)
			// n1 must NOT have been resolved — the txn rolled back
			const [row] = await db
				.select()
				.from(notifications)
				.where(eq(notifications.id, n1.id))
				.limit(1)
			expect(row.status).toBe('pending')
			expect(row.dispatchAt).toBeNull()
		})
	})

	describe('reverse within the 6s window', () => {
		it('restores a just-resolved notification and clears dispatch_at', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const n = await insertNotification(db, workspaceId, getTestActorId())

			// Respond first (deferred → dispatch_at gets set)
			const respondRes = await app.request(
				jsonRequest('POST', `/api/notifications/${n.id}/respond`, { response: 'approve' }, headers),
			)
			expect(respondRes.status).toBe(200)

			// Reverse immediately (well inside 6s)
			const reverseRes = await app.request(
				jsonRequest('POST', `/api/notifications/${n.id}/reverse`, {}, headers),
			)
			expect(reverseRes.status).toBe(200)

			const [row] = await db.select().from(notifications).where(eq(notifications.id, n.id)).limit(1)
			expect(row.status).toBe('pending')
			expect(row.resolvedAt).toBeNull()
			expect(row.dispatchAt).toBeNull()
			expect(row.wakeDispatched).toBe(false)
			// metadata.response must be stripped
			expect(row.metadata && (row.metadata as Record<string, unknown>).response).toBeUndefined()
		})

		it('returns 400 after the 6s window has elapsed', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const n = await insertNotification(db, workspaceId, getTestActorId())

			// Simulate an old resolution by writing the row directly with a
			// resolved_at 10s in the past.
			await db
				.update(notifications)
				.set({
					status: 'resolved',
					resolvedAt: new Date(Date.now() - 10_000),
					metadata: { response: 'old' },
				})
				.where(eq(notifications.id, n.id))

			const reverseRes = await app.request(
				jsonRequest('POST', `/api/notifications/${n.id}/reverse`, {}, headers),
			)
			expect(reverseRes.status).toBe(400)
			const body = await reverseRes.json()
			expect(body.error.message).toContain('window')

			// Row is untouched
			const [row] = await db.select().from(notifications).where(eq(notifications.id, n.id)).limit(1)
			expect(row.status).toBe('resolved')
		})

		it('returns 400 when the notification is not in resolved state', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }
			const n = await insertNotification(db, workspaceId, getTestActorId())

			const reverseRes = await app.request(
				jsonRequest('POST', `/api/notifications/${n.id}/reverse`, {}, headers),
			)
			expect(reverseRes.status).toBe(400)
		})
	})

	describe('attention_needed filter (For You feed)', () => {
		it('returns only notifications whose metadata.attention_needed is true when the query flag is set', async () => {
			const app = createApp()
			const headers = { 'x-workspace-id': workspaceId }

			const attention = await insertNotification(db, workspaceId, getTestActorId(), {
				title: 'Wants attention',
				metadata: { attention_needed: true, asked: 'Ship it?' },
			})
			await insertNotification(db, workspaceId, getTestActorId(), {
				title: 'Silent recommendation',
				metadata: { attention_needed: false, recommendation: 'ignore' },
			})
			await insertNotification(db, workspaceId, getTestActorId(), {
				title: 'No attention key at all',
				metadata: { asked: 'anyone home?' },
			})

			const filteredRes = await app.request(
				jsonGet('/api/notifications?attention_needed=true', headers),
			)
			expect(filteredRes.status).toBe(200)
			const filtered = await filteredRes.json()
			expect(filtered.map((n: { id: string }) => n.id)).toEqual([attention.id])

			// Sanity: without the flag, the caller still sees all three
			const allRes = await app.request(jsonGet('/api/notifications', headers))
			const all = await allRes.json()
			expect(all.length).toBe(3)
		})
	})
})
