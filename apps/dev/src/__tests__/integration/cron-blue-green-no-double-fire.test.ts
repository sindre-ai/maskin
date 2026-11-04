import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { triggerDispatches } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { describe, expect, it, vi } from 'vitest'
import { configureSessionLifecycle } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Blue-green double-fire proof for cron triggers. Event triggers already claim a
// (trigger_id, event_id) row in trigger_dispatches before dispatching; cron
// triggers did not, so a tick that landed while the old and new instance both
// held the cron job started two sessions. A cron tick has no events row, so its
// claim key is the negative of the tick's unix seconds.

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

describe('cron triggers — trigger_dispatches idempotency prevents blue-green double-fire', () => {
	it('two runners holding the same every-second cron trigger start one session per tick', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const targetActor = await insertActor(db, { type: 'agent', name: 'Cron blue-green target' })
		const trig = await insertTrigger(db, ws.id, actorId, targetActor.id, {
			name: 'Cron blue-green trigger',
			type: 'cron',
			enabled: true,
			// Six fields: croner reads the first as seconds.
			config: { expression: '* * * * * *' },
		})

		const createSession = vi.fn(async () => ({ id: randomUUID() }))
		const manager = { createSession } as unknown as SessionManager
		// startSession() reads one process-wide SessionManager, so both runners'
		// dispatches land in this one spy and the total covers both.
		configureSessionLifecycle({ db, sessionManager: manager })

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const blue = new TriggerRunner(db, bridge, manager)
		const green = new TriggerRunner(db, bridge, manager)
		await blue.start()
		await green.start()

		try {
			await new Promise((resolve) => setTimeout(resolve, 3_500))
		} finally {
			await blue.stop()
			await green.stop()
		}
		// Let any dispatch already past the claim finish its createSession call.
		await new Promise((resolve) => setTimeout(resolve, 200))

		const rows = await db
			.select({ eventId: triggerDispatches.eventId })
			.from(triggerDispatches)
			.where(eq(triggerDispatches.triggerId, trig.id))

		// Several ticks happened, each was claimed exactly once, and each claim
		// produced exactly one session. With no guard there are no rows at all and
		// createSession runs twice per tick.
		expect(rows.length).toBeGreaterThanOrEqual(2)
		expect(new Set(rows.map((r) => r.eventId)).size).toBe(rows.length)
		expect(rows.every((r) => r.eventId < 0)).toBe(true)
		expect(createSession).toHaveBeenCalledTimes(rows.length)
	})
})
