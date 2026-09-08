import { EventEmitter } from 'node:events'
import { events } from '@maskin/db/schema'
import type { PgEvent, PgNotifyBridge } from '@maskin/realtime'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Case-2 fallback dispatch (spec §Solution sketch, Task 2 acceptance): when a
// comment lands on a driver-owned object and the commenter is not the driver
// and the comment carries no @mention, `trigger-runner.ts`'s `commented` event
// subscriber must dispatch exactly one session for the driver, tagged with
// `triggerSource:'comment_fallback'` + `sourceCommentEventId`, and emit a
// `comment_responder_resolved` PostHog event with case `case_2_driver_fallback`.
//
// This is the founding regression case: Sebk answered Strategist's comment 5.5h
// later on an object driven by Strategist, and no dispatch fired (spec §Problem).
// The test drives the runner via the same `PgNotifyBridge` event shape the
// production bridge emits (EventEmitter in the transport, real Postgres for the
// events + objects rows), so the resolver's `entity.driver` join runs against
// real Postgres — the class of DB-semantics failure that mocked-DB tests can't
// catch (see .claude/rules/known-pitfalls.md and .claude/rules/verification.md).

const capturePosthogEvent = vi.fn().mockResolvedValue(undefined)
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))

// Task 2 adds either `enqueueSession` or extends `createSession` — mock both so
// the assertions catch whichever entry point the resolver ends up calling. The
// spec's acceptance criterion names `enqueueSession`; if Task 2 keeps
// `createSession` and threads the new fields through `config`, the fallback
// assertion below still holds.
function createMockSessionManager() {
	return {
		enqueueSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		createSession: vi.fn().mockResolvedValue({ id: 'session-stub' }),
		stopSession: vi.fn(),
		pauseSession: vi.fn(),
		resumeSession: vi.fn(),
		writeInput: vi.fn(),
		on: vi.fn(),
		off: vi.fn(),
	}
}

type MockSessionManager = ReturnType<typeof createMockSessionManager>

function collectDispatchCalls(sm: MockSessionManager) {
	return [
		...(sm.enqueueSession.mock.calls as unknown[][]),
		...(sm.createSession.mock.calls as unknown[][]),
	]
}

async function insertCommentEvent(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	content: string
	mentions?: string[]
	parentEventId?: number
}): Promise<number> {
	const rows = await db
		.insert(events)
		.values({
			workspaceId: opts.workspaceId,
			actorId: opts.actorId,
			action: 'commented',
			entityType: 'object',
			entityId: opts.entityId,
			data: {
				content: opts.content,
				mentions: opts.mentions ?? [],
				...(opts.parentEventId !== undefined ? { parentEventId: opts.parentEventId } : {}),
			},
		})
		.returning({ id: events.id })
	return rows[0].id
}

function buildPgEvent(opts: {
	workspaceId: string
	actorId: string
	entityId: string
	eventId: number
}): PgEvent {
	return {
		workspace_id: opts.workspaceId,
		actor_id: opts.actorId,
		action: 'commented',
		entity_type: 'object',
		entity_id: opts.entityId,
		event_id: String(opts.eventId),
	}
}

describe('Comment fallback resolver — case 2 driver dispatch (integration)', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: MockSessionManager
	let runner: TriggerRunner

	beforeEach(async () => {
		capturePosthogEvent.mockClear()
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		runner = new TriggerRunner(db, bridge, sessionManager as unknown as SessionManager)
		await runner.start()
	})

	afterEach(async () => {
		await runner.stop()
		vi.restoreAllMocks()
	})

	// Reproduces the Sebk→Strategist 5.5h founding regression case. The object
	// is driven by the agent, the commenter is a different human, and the
	// comment carries no @mention. Before this bet: no dispatch fired. After:
	// case 2 fires exactly one session for the driver.
	it('dispatches one session for the driver on a non-mention comment from a different actor', async () => {
		const humanActor = getTestActorId()
		const driverAgent = await insertActor(db, {
			type: 'agent',
			name: 'Strategist',
			email: 'strategist@integration.test',
			apiKey: 'ank_strategist_int',
		})
		const ws = await insertWorkspace(db, humanActor)
		const object = await insertObject(db, ws.id, humanActor, {
			type: 'bet',
			title: 'Should we ship the always-a-responder bet?',
			driver: driverAgent.id,
		})

		const commentEventId = await insertCommentEvent({
			workspaceId: ws.id,
			actorId: humanActor,
			entityId: object.id,
			content: 'Answering your question — yes, ship it.',
		})

		bridge.emit(
			'event',
			buildPgEvent({
				workspaceId: ws.id,
				actorId: humanActor,
				entityId: object.id,
				eventId: commentEventId,
			}),
		)

		await vi.waitFor(
			() => {
				const dispatches = collectDispatchCalls(sessionManager)
				expect(dispatches.length).toBeGreaterThan(0)
			},
			{ timeout: 5_000, interval: 25 },
		)

		const dispatches = collectDispatchCalls(sessionManager)
		expect(dispatches).toHaveLength(1)

		// One dispatch is the whole point — the target is the driver, the trigger
		// source names the fallback path, and the source event id round-trips so
		// downstream sessions can walk back to the comment that spawned them.
		const [firstArg, secondArg] = dispatches[0]
		const payload = (secondArg ?? firstArg) as Record<string, unknown> & {
			config?: Record<string, unknown>
		}
		const triggerSource = payload.triggerSource ?? payload.config?.triggerSource
		const sourceCommentEventId =
			payload.sourceCommentEventId ?? payload.config?.sourceCommentEventId
		const dispatchedActorId = payload.actorId

		expect(dispatchedActorId).toBe(driverAgent.id)
		expect(triggerSource).toBe('comment_fallback')
		expect(String(sourceCommentEventId)).toBe(String(commentEventId))

		// PostHog attribution: the resolver labels this handled event
		// `case_2_driver_fallback` and names the driver as the resolved actor.
		// Without this label Product Validator can only measure aggregate
		// `orphan_thread_detected` drop but can't attribute drop to case 2.
		const resolvedEmits = capturePosthogEvent.mock.calls.filter(
			(c: unknown[]) => c[0] === 'comment_responder_resolved',
		)
		expect(resolvedEmits).toHaveLength(1)
		const [, , props] = resolvedEmits[0]
		expect(props).toMatchObject({
			case: 'case_2_driver_fallback',
			resolved_actor_id: driverAgent.id,
		})
		expect(String((props as Record<string, unknown>).source_comment_event_id)).toBe(
			String(commentEventId),
		)
	})
})

describe('Comment fallback resolver — burst load safety (integration)', () => {
	let bridge: EventEmitter & PgNotifyBridge
	let sessionManager: MockSessionManager
	let runner: TriggerRunner
	let errorSpy: ReturnType<typeof vi.spyOn>

	beforeEach(async () => {
		capturePosthogEvent.mockClear()
		bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		sessionManager = createMockSessionManager()
		runner = new TriggerRunner(db, bridge, sessionManager as unknown as SessionManager)
		errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
		await runner.start()
	})

	afterEach(async () => {
		await runner.stop()
		errorSpy.mockRestore()
		vi.restoreAllMocks()
	})

	// 100 comments on the same driver-owned object within 1s. Magnus rejected
	// `comment_dispatch_log` in v1 (see spec §Idempotency; comment 516012), so we
	// rely on `PgNotifyBridge` + `webhook-delivery` at-least-once semantics —
	// asserting a LOWER bound of 100 dispatches (some retry duplicates are
	// acceptable in v1) and no thrown handler errors.
	it('dispatches at least one session per comment under a 100-in-1s burst without subscriber errors', async () => {
		const humanActor = getTestActorId()
		const driverAgent = await insertActor(db, {
			type: 'agent',
			name: 'Burst Driver',
			email: 'burst-driver@integration.test',
			apiKey: 'ank_burst_int',
		})
		const ws = await insertWorkspace(db, humanActor)
		const object = await insertObject(db, ws.id, humanActor, {
			type: 'bet',
			title: 'Burst-load target',
			driver: driverAgent.id,
		})

		const BURST_SIZE = 100
		const eventIds: number[] = []
		for (let i = 0; i < BURST_SIZE; i += 1) {
			eventIds.push(
				await insertCommentEvent({
					workspaceId: ws.id,
					actorId: humanActor,
					entityId: object.id,
					content: `burst comment ${i}`,
				}),
			)
		}

		const start = Date.now()
		for (const eventId of eventIds) {
			bridge.emit(
				'event',
				buildPgEvent({
					workspaceId: ws.id,
					actorId: humanActor,
					entityId: object.id,
					eventId,
				}),
			)
		}
		const emitDuration = Date.now() - start
		expect(emitDuration).toBeLessThan(1_000)

		await vi.waitFor(
			() => {
				const dispatches = collectDispatchCalls(sessionManager)
				expect(dispatches.length).toBeGreaterThanOrEqual(BURST_SIZE)
			},
			{ timeout: 20_000, interval: 50 },
		)

		const dispatches = collectDispatchCalls(sessionManager)
		expect(dispatches.length).toBeGreaterThanOrEqual(BURST_SIZE)

		// At-least-once semantics can genuinely re-fire an event; a small ceiling
		// catches an obvious regression (fan-out bug, subscriber double-registration)
		// without flaking on legitimate retry duplication.
		expect(dispatches.length).toBeLessThanOrEqual(BURST_SIZE * 3)

		// Every dispatch targets the driver — case 2 is the only path that fires
		// on driver-owned, non-mention comments, so any other actor id here would
		// indicate the resolver misrouted a burst event.
		for (const [firstArg, secondArg] of dispatches) {
			const payload = (secondArg ?? firstArg) as Record<string, unknown>
			expect(payload.actorId).toBe(driverAgent.id)
		}

		// The subscriber must not surface a handler crash — the trigger-runner
		// wraps handleEvent in a `.catch(logger.error)`, so a swallowed error
		// would show up here rather than as an unhandled rejection.
		expect(errorSpy).not.toHaveBeenCalled()

		// PostHog fires per comment (once minimum, matching at-least-once).
		const resolvedEmits = capturePosthogEvent.mock.calls.filter(
			(c: unknown[]) => c[0] === 'comment_responder_resolved',
		)
		expect(resolvedEmits.length).toBeGreaterThanOrEqual(BURST_SIZE)
	})
})
