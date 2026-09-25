import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

// G2 trigger provenance: `createSession` folds `triggerType` into
// `config.trigger_type` so `launchContainer` can emit it on
// `agent_session_started_with_prompt`, while `triggerId` lands on the real
// `sessions.trigger_id` column. Both feed the cron-vs-event segmentation the
// bet's PostHog verdict reads. Mocked-DB tests would pass on the call shape
// alone; only a real Postgres round-trip proves the column and the JSONB fold
// actually persist.
describe('SessionManager.createSession — trigger provenance (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		// enterpriseGranted short-circuits `checkPlanCap` in createSession's
		// pre-flight (isEnterprise() → true → hasByoCredentials false, but the
		// cap check returns early on `enterprise`). Keeps this suite focused on
		// provenance persistence rather than billing.
		const ws = await insertWorkspace(db, actorId, { enterpriseGranted: true })
		workspaceId = ws.id
	})

	it('persists trigger_type and trigger_id for a cron-dispatched session', async () => {
		const trigger = await insertTrigger(db, workspaceId, actorId, actorId, { type: 'cron' })

		const manager = new SessionManager(db, stubStorage())
		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'cron tick',
				triggerId: trigger.id,
				triggerType: 'cron',
				createdBy: actorId,
			})
			sessionId = session.id
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect((row?.config as Record<string, unknown>).trigger_type).toBe('cron')
		expect(row?.triggerId).toBe(trigger.id)
	})

	it('persists trigger_type and trigger_id for an event-dispatched session', async () => {
		const trigger = await insertTrigger(db, workspaceId, actorId, actorId, { type: 'event' })

		const manager = new SessionManager(db, stubStorage())
		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'event fired',
				triggerId: trigger.id,
				triggerType: 'event',
				createdBy: actorId,
			})
			sessionId = session.id
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect((row?.config as Record<string, unknown>).trigger_type).toBe('event')
		expect(row?.triggerId).toBe(trigger.id)
	})

	it('omits trigger_type when the caller supplies no triggerType', async () => {
		const manager = new SessionManager(db, stubStorage())
		let sessionId: string
		try {
			const session = await manager.createSession(workspaceId, {
				actorId,
				actionPrompt: 'interactive turn',
				createdBy: actorId,
			})
			sessionId = session.id
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		expect('trigger_type' in ((row?.config as Record<string, unknown>) ?? {})).toBe(false)
		expect(row?.triggerId).toBeNull()
	})
})
