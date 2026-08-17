import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// T1 of bet/loop-lifecycle-status-ladder: TriggerRunner must consult the
// parent loop's status before firing. A trigger owned by a loop in `draft`,
// `paused`, or `archived` produces zero sessions.
//
// Real-Postgres coverage because the gate reads through a JSONB predicate
// (`objects.metadata->'trigger_ids' @> jsonb`) — the mocked-DB unit-test
// harness can't exercise that operator or the workspace-scoped filter.
describe('TriggerRunner loop-status gate (integration)', () => {
	let workspaceId: string
	let targetActorId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent', name: 'Loop Agent' })
		targetActorId = agent.id
	})

	async function fireEventThroughRunner(triggerId: string, subjectObjectId: string) {
		const [eventRow] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId: getTestActorId(),
				action: 'status_changed',
				entityType: 'lead',
				entityId: subjectObjectId,
				data: { changes: [{ field: 'status', old: 'new', new: 'qualified' }] },
			})
			.returning()

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const runner = new TriggerRunner(db, bridge, {
			createSession,
		} as unknown as SessionManager)
		await runner.start()
		try {
			bridge.emit('event', {
				workspace_id: workspaceId,
				entity_type: 'lead',
				entity_id: subjectObjectId,
				action: 'status_changed',
				actor_id: getTestActorId(),
				event_id: String(eventRow?.id),
			})
			// handleEvent runs fire-and-forget off the bridge listener — poll
			// briefly, mirroring the pattern in triggers.test.ts.
			const deadline = Date.now() + 3000
			while (createSession.mock.calls.length === 0 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		} finally {
			await runner.stop()
		}
		// Extra beat so any suppression-path DB writes settle before we assert.
		await new Promise((resolve) => setTimeout(resolve, 100))
		return { createSession, eventRow }
	}

	async function setupLoopWithEventTrigger(loopStatus: string) {
		const trigger = await insertTrigger(db, workspaceId, getTestActorId(), targetActorId, {
			type: 'event',
			config: { entity_type: 'lead', action: 'status_changed', filter: { status: 'qualified' } },
			enabled: true,
		})
		const loop = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'loop',
			title: `${loopStatus} loop`,
			status: loopStatus,
			metadata: { trigger_ids: [trigger.id] },
		})
		const subject = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'lead',
			title: 'Acme Corp',
			status: 'qualified',
		})
		return { trigger, loop, subject }
	}

	it('does not create a session when the parent loop is paused', async () => {
		const { trigger, subject } = await setupLoopWithEventTrigger('paused')
		const { createSession } = await fireEventThroughRunner(trigger.id, subject.id)
		expect(createSession).not.toHaveBeenCalled()

		// And no `trigger_fired` event was logged either — suppression must
		// mirror the zero-scope-matches early-return in fireCronTrigger.
		const firedEvents = await db.select().from(events).where(eq(events.entityId, trigger.id))
		expect(firedEvents.find((e) => e.action === 'trigger_fired')).toBeUndefined()
	})

	it('does not create a session when the parent loop is draft', async () => {
		const { trigger, subject } = await setupLoopWithEventTrigger('draft')
		const { createSession } = await fireEventThroughRunner(trigger.id, subject.id)
		expect(createSession).not.toHaveBeenCalled()
	})

	it('does not create a session when the parent loop is archived', async () => {
		const { trigger, subject } = await setupLoopWithEventTrigger('archived')
		const { createSession } = await fireEventThroughRunner(trigger.id, subject.id)
		expect(createSession).not.toHaveBeenCalled()
	})

	it('fires normally when the parent loop is live', async () => {
		const { trigger, subject } = await setupLoopWithEventTrigger('live')
		const { createSession } = await fireEventThroughRunner(trigger.id, subject.id)
		expect(createSession).toHaveBeenCalledTimes(1)
	})

	it('fires normally when the trigger has no parent loop', async () => {
		const trigger = await insertTrigger(db, workspaceId, getTestActorId(), targetActorId, {
			type: 'event',
			config: { entity_type: 'lead', action: 'status_changed', filter: { status: 'qualified' } },
			enabled: true,
		})
		const subject = await insertObject(db, workspaceId, getTestActorId(), {
			type: 'lead',
			title: 'Independent lead',
			status: 'qualified',
		})
		const { createSession } = await fireEventThroughRunner(trigger.id, subject.id)
		expect(createSession).toHaveBeenCalledTimes(1)
	})

	it('does not read a same-id loop from a different workspace', async () => {
		// A paused loop in workspace B with a trigger_ids entry that happens
		// to match the *primary* workspace's trigger must not gate that
		// trigger — the JSONB predicate is workspace-scoped.
		const { trigger, subject } = await setupLoopWithEventTrigger('live')
		const otherWs = await insertWorkspace(db, getTestActorId())
		await insertObject(db, otherWs.id, getTestActorId(), {
			type: 'loop',
			title: 'Paused foreign loop with same trigger id',
			status: 'paused',
			metadata: { trigger_ids: [trigger.id] },
		})
		const { createSession } = await fireEventThroughRunner(trigger.id, subject.id)
		expect(createSession).toHaveBeenCalledTimes(1)
	})
})
