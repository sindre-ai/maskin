import { events, notifications } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { NotificationsLifecycle } from '../../services/notifications-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { insertActor, insertNotification, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function mockSessionManager() {
	return {
		createSession: vi.fn().mockResolvedValue({ id: '00000000-0000-0000-0000-0000000000ff' }),
		resumeSession: vi.fn().mockResolvedValue(undefined),
	} as unknown as SessionManager
}

describe('NotificationsLifecycle (integration)', () => {
	let workspaceId: string
	let humanActorId: string
	let agentActorId: string

	beforeEach(async () => {
		humanActorId = getTestActorId()
		const ws = await insertWorkspace(db, humanActorId)
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Test agent' })
		agentActorId = agent.id
	})

	describe('wake reaper', () => {
		it('dispatches a wake when dispatch_at has elapsed and flips wake_dispatched', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const past = new Date(Date.now() - 1000)
			const n = await insertNotification(db, workspaceId, agentActorId, {
				status: 'resolved',
				dispatchAt: past,
				wakeDispatched: false,
				metadata: { response: 'approve' },
			})

			const dispatched = await service.runWakeReaper()

			expect(dispatched).toBe(1)
			expect(sm.createSession).toHaveBeenCalledTimes(1)
			const [row] = await db.select().from(notifications).where(eq(notifications.id, n.id)).limit(1)
			expect(row.wakeDispatched).toBe(true)
		})

		it('does not dispatch when dispatch_at is still in the future', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const future = new Date(Date.now() + 60_000)
			await insertNotification(db, workspaceId, agentActorId, {
				status: 'resolved',
				dispatchAt: future,
				wakeDispatched: false,
			})

			const dispatched = await service.runWakeReaper()

			expect(dispatched).toBe(0)
			expect(sm.createSession).not.toHaveBeenCalled()
		})

		it('does not re-dispatch a row that was already dispatched', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const past = new Date(Date.now() - 1000)
			await insertNotification(db, workspaceId, agentActorId, {
				status: 'resolved',
				dispatchAt: past,
				wakeDispatched: true,
			})

			const dispatched = await service.runWakeReaper()

			expect(dispatched).toBe(0)
			expect(sm.createSession).not.toHaveBeenCalled()
		})

		it('skips non-agent source actors without dispatching a session', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const past = new Date(Date.now() - 1000)
			// human source — wakeSourceAgent returns early, but the reaper still
			// flips wake_dispatched so it doesn't retry every tick.
			await insertNotification(db, workspaceId, humanActorId, {
				status: 'resolved',
				dispatchAt: past,
				wakeDispatched: false,
			})

			await service.runWakeReaper()

			expect(sm.createSession).not.toHaveBeenCalled()
			const rows = await db
				.select()
				.from(notifications)
				.where(eq(notifications.wakeDispatched, true))
			expect(rows).toHaveLength(1)
		})

		it('processes rows in dispatch_at order and respects the batch size cap', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm, { batchSize: 2 })
			// Three eligible rows; only two should be handled per tick.
			for (let i = 0; i < 3; i++) {
				await insertNotification(db, workspaceId, agentActorId, {
					status: 'resolved',
					dispatchAt: new Date(Date.now() - (3 - i) * 1000),
					wakeDispatched: false,
					title: `n${i}`,
				})
			}

			const first = await service.runWakeReaper()
			const second = await service.runWakeReaper()

			expect(first).toBe(2)
			expect(second).toBe(1)
			expect(sm.createSession).toHaveBeenCalledTimes(3)
		})
	})

	describe('expiry sweep', () => {
		it('expires a pending notification past its expires_at and posts a comment on objectId', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const obj = await insertObject(db, workspaceId, humanActorId)
			const past = new Date(Date.now() - 5_000)
			const n = await insertNotification(db, workspaceId, agentActorId, {
				status: 'pending',
				expiresAt: past,
				defaultAction: 'approve',
				objectId: obj.id,
				metadata: { options: [{ key: 'approve', label: 'Approve' }] },
			})

			const expired = await service.runExpirySweep()

			expect(expired).toBe(1)
			const [row] = await db.select().from(notifications).where(eq(notifications.id, n.id)).limit(1)
			expect(row.status).toBe('expired')

			const comments = await db
				.select()
				.from(events)
				.where(
					and(
						eq(events.entityType, 'object'),
						eq(events.entityId, obj.id),
						eq(events.action, 'commented'),
					),
				)
			expect(comments).toHaveLength(1)
			const commentData = comments[0].data as { content: string; metadata: Record<string, unknown> }
			expect(commentData.content).toContain('Approve')
			expect(commentData.metadata.notification_id).toBe(n.id)
		})

		it('does not expire notifications whose expires_at is in the future', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			await insertNotification(db, workspaceId, agentActorId, {
				status: 'pending',
				expiresAt: new Date(Date.now() + 60_000),
				defaultAction: 'approve',
			})

			const expired = await service.runExpirySweep()

			expect(expired).toBe(0)
		})

		it('does not expire notifications that are already resolved or expired', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const past = new Date(Date.now() - 5_000)
			await insertNotification(db, workspaceId, agentActorId, {
				status: 'resolved',
				resolvedAt: new Date(),
				expiresAt: past,
				defaultAction: 'approve',
			})
			await insertNotification(db, workspaceId, agentActorId, {
				status: 'expired',
				expiresAt: past,
				defaultAction: 'approve',
			})

			const expired = await service.runExpirySweep()

			expect(expired).toBe(0)
		})

		it('handles a null objectId by writing only the notification event, not a comment', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const past = new Date(Date.now() - 1000)
			const n = await insertNotification(db, workspaceId, agentActorId, {
				status: 'pending',
				expiresAt: past,
				defaultAction: 'approve',
				objectId: null,
			})

			const expired = await service.runExpirySweep()

			expect(expired).toBe(1)
			const expiredEvents = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, n.id), eq(events.action, 'expired')))
			expect(expiredEvents).toHaveLength(1)
		})

		it('is idempotent: a second pass over the same rows expires nothing', async () => {
			const sm = mockSessionManager()
			const service = new NotificationsLifecycle(db, sm)
			const past = new Date(Date.now() - 1000)
			await insertNotification(db, workspaceId, agentActorId, {
				status: 'pending',
				expiresAt: past,
				defaultAction: 'approve',
			})

			const first = await service.runExpirySweep()
			const second = await service.runExpirySweep()

			expect(first).toBe(1)
			expect(second).toBe(0)
		})
	})
})
