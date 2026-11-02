import { workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { recordFailoverTransition } from '../../lib/claude-failover'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import { WORKSPACE_ROW_LOCK_TIMEOUT_MS, persistRefreshedSlot } from '../../lib/claude-oauth'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

// SQLSTATE 55P03 = lock_not_available, raised when lock_timeout expires.
function hasLockTimeoutCode(err: unknown): boolean {
	for (let e: unknown = err, depth = 0; e && depth < 3; depth++) {
		if (typeof e === 'object' && (e as { code?: unknown }).code === '55P03') return true
		e = e instanceof Error ? e.cause : undefined
	}
	return false
}

const fresh: EncryptedOAuthData = {
	encryptedAccessToken: 'p-new-enc',
	encryptedRefreshToken: 'p-new-enc-rt',
	expiresAt: 1_800_000_000_000,
	subscriptionType: 'pro',
}

/**
 * Session launch resolves credentials through two writers that take
 * `SELECT ... FOR UPDATE` on the workspaces row. With no lock_timeout, one
 * stuck holder blocked every launch behind it until the 10 minute reaper. Only
 * real Postgres can show the wait ending on its own, so this pins it here.
 */
describe('Claude OAuth slot writes — bounded wait on a locked workspaces row', () => {
	it('persistRefreshedSlot and recordFailoverTransition fail inside the lock timeout instead of waiting', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: { claude_oauth: { primary: fresh, failover: { active_slot: 'primary' } } },
		})

		let release!: () => void
		const held = new Promise<void>((resolve) => {
			release = resolve
		})
		let lockTaken!: () => void
		const lockAcquired = new Promise<void>((resolve) => {
			lockTaken = resolve
		})
		// The "stuck holder": takes the row lock and sits on it.
		const holder = db.transaction(async (tx) => {
			await tx.select().from(workspaces).where(eq(workspaces.id, ws.id)).for('update').limit(1)
			lockTaken()
			await held
		})
		await lockAcquired

		try {
			const startedAt = Date.now()
			const [persist, failover] = await Promise.allSettled([
				persistRefreshedSlot(db, ws.id, 'primary', fresh),
				recordFailoverTransition({
					db,
					workspaceId: ws.id,
					actorId: actor.id,
					fromSlot: 'primary',
					toSlot: 'backup',
					bucket: 0,
					reason: 'test',
				}),
			])
			const elapsedMs = Date.now() - startedAt

			expect(persist.status).toBe('rejected')
			expect(failover.status).toBe('rejected')
			expect(hasLockTimeoutCode((persist as PromiseRejectedResult).reason)).toBe(true)
			expect(hasLockTimeoutCode((failover as PromiseRejectedResult).reason)).toBe(true)
			expect(elapsedMs).toBeGreaterThanOrEqual(WORKSPACE_ROW_LOCK_TIMEOUT_MS - 500)
			expect(elapsedMs).toBeLessThan(WORKSPACE_ROW_LOCK_TIMEOUT_MS + 5_000)
		} finally {
			release()
			await holder
		}
	})

	it('still writes normally when the row is free', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: { claude_oauth: { primary: fresh, failover: { active_slot: 'primary' } } },
		})

		await persistRefreshedSlot(db, ws.id, 'primary', { ...fresh, encryptedAccessToken: 'p-2' })

		const [stored] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const oauth = (stored.settings as Record<string, unknown>).claude_oauth as {
			primary: EncryptedOAuthData
		}
		expect(oauth.primary.encryptedAccessToken).toBe('p-2')
	})
})
