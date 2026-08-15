import { notifications } from '@maskin/db/schema'
import { and, eq, isNull, sql } from 'drizzle-orm'
import { insertActor, insertNotification, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

describe('Notifications schema extension (migrations 0053–0055)', () => {
	let workspaceId: string
	let sourceActorId: string

	beforeEach(async () => {
		sourceActorId = getTestActorId()
		const ws = await insertWorkspace(db, sourceActorId)
		workspaceId = ws.id
	})

	it('accepts inserts populating all four new columns', async () => {
		const expiresAt = new Date(Date.now() + 60_000)
		const dispatchAt = new Date(Date.now() + 30_000)

		const row = await insertNotification(db, workspaceId, sourceActorId, {
			expiresAt,
			defaultAction: 'approve',
			dispatchAt,
			wakeDispatched: false,
		})

		const [fetched] = await db.select().from(notifications).where(eq(notifications.id, row.id))

		expect(fetched.expiresAt?.toISOString()).toBe(expiresAt.toISOString())
		expect(fetched.defaultAction).toBe('approve')
		expect(fetched.dispatchAt?.toISOString()).toBe(dispatchAt.toISOString())
		expect(fetched.wakeDispatched).toBe(false)
	})

	it('defaults the four new columns to NULL / false when not provided', async () => {
		const row = await insertNotification(db, workspaceId, sourceActorId)
		const [fetched] = await db.select().from(notifications).where(eq(notifications.id, row.id))

		expect(fetched.expiresAt).toBeNull()
		expect(fetched.defaultAction).toBeNull()
		expect(fetched.dispatchAt).toBeNull()
		expect(fetched.wakeDispatched).toBe(false)
	})

	it('rejects NULL on wake_dispatched (NOT NULL DEFAULT false)', async () => {
		await expect(
			db.execute(sql`
				INSERT INTO notifications
					(workspace_id, type, title, source_actor_id, status, wake_dispatched)
				VALUES
					(${workspaceId}, 'test', 't', ${sourceActorId}, 'pending', NULL)
			`),
		).rejects.toThrow()
	})

	describe('partial indexes', () => {
		it('created notifications_dispatch_at_pending_idx with the exact predicate', async () => {
			const rows = await db.execute<{ indexdef: string }>(sql`
				SELECT indexdef FROM pg_indexes
				WHERE schemaname = 'public'
					AND tablename = 'notifications'
					AND indexname = 'notifications_dispatch_at_pending_idx'
			`)
			expect(rows.length).toBe(1)
			const def = rows[0].indexdef
			expect(def).toMatch(/USING btree \("?dispatch_at"?\)/)
			expect(def).toMatch(/WHERE .*dispatch_at.* IS NOT NULL/)
			expect(def).toMatch(/wake_dispatched = false/)
		})

		it('created notifications_expires_at_idx with the exact predicate', async () => {
			const rows = await db.execute<{ indexdef: string }>(sql`
				SELECT indexdef FROM pg_indexes
				WHERE schemaname = 'public'
					AND tablename = 'notifications'
					AND indexname = 'notifications_expires_at_idx'
			`)
			expect(rows.length).toBe(1)
			const def = rows[0].indexdef
			expect(def).toMatch(/USING btree \("?expires_at"?\)/)
			expect(def).toMatch(/WHERE .*expires_at.* IS NOT NULL/)
			expect(def).toMatch(/status = ANY .*'pending'.*'seen'/s)
		})

		it('dispatch_at partial index matches the reaper query shape', async () => {
			const targetActor = await insertActor(db)
			const past = new Date(Date.now() - 5_000)
			const future = new Date(Date.now() + 60_000)

			// Row 1: due and unclaimed → should be returned.
			const due = await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				dispatchAt: past,
				wakeDispatched: false,
			})
			// Row 2: due but already claimed → should NOT be returned.
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				dispatchAt: past,
				wakeDispatched: true,
			})
			// Row 3: not yet due → should NOT be returned.
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				dispatchAt: future,
				wakeDispatched: false,
			})
			// Row 4: no dispatch scheduled → should NOT be returned.
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
			})

			const rows = await db
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.workspaceId, workspaceId),
						eq(notifications.wakeDispatched, false),
						sql`${notifications.dispatchAt} IS NOT NULL AND ${notifications.dispatchAt} <= now()`,
					),
				)

			expect(rows.map((r) => r.id)).toEqual([due.id])
		})

		it('expires_at partial index matches the expiry sweep query shape', async () => {
			const targetActor = await insertActor(db)
			const past = new Date(Date.now() - 5_000)
			const future = new Date(Date.now() + 60_000)

			// Row 1: pending and past its deadline → should be swept.
			const duePending = await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				status: 'pending',
				expiresAt: past,
			})
			// Row 2: seen and past deadline → also swept (predicate covers both statuses).
			const dueSeen = await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				status: 'seen',
				expiresAt: past,
			})
			// Row 3: already resolved → should NOT be swept.
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				status: 'resolved',
				expiresAt: past,
			})
			// Row 4: pending but deadline in the future → should NOT be swept.
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				status: 'pending',
				expiresAt: future,
			})
			// Row 5: pending with no deadline → should NOT be swept.
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
				status: 'pending',
			})

			const rows = await db
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.workspaceId, workspaceId),
						sql`${notifications.expiresAt} IS NOT NULL AND ${notifications.expiresAt} <= now()`,
						sql`${notifications.status} IN ('pending', 'seen')`,
					),
				)

			const ids = rows.map((r) => r.id).sort()
			expect(ids).toEqual([duePending.id, dueSeen.id].sort())
		})

		it('leaves untouched notifications with no dispatch or expiry work invisible to both sweeps', async () => {
			const targetActor = await insertActor(db)
			await insertNotification(db, workspaceId, sourceActorId, {
				targetActorId: targetActor.id,
			})

			const dispatchScan = await db
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.workspaceId, workspaceId),
						eq(notifications.wakeDispatched, false),
						sql`${notifications.dispatchAt} IS NOT NULL`,
					),
				)
			const expiryScan = await db
				.select({ id: notifications.id })
				.from(notifications)
				.where(
					and(
						eq(notifications.workspaceId, workspaceId),
						sql`${notifications.expiresAt} IS NOT NULL`,
					),
				)

			expect(dispatchScan).toHaveLength(0)
			expect(expiryScan).toHaveLength(0)

			// Sanity: the row itself is queryable via a normal path.
			const wsScan = await db
				.select({ id: notifications.id })
				.from(notifications)
				.where(and(eq(notifications.workspaceId, workspaceId), isNull(notifications.dispatchAt)))
			expect(wsScan).toHaveLength(1)
		})
	})
})
