import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { postComment } from '../../lib/comments'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// End-to-end coverage for the S6 slice on the trigger-engine bet
// (bet/f46b18f7-trigger-engine). Verifies that:
//   1. A user-defined trigger with action = 'commented' fires when a comment
//      lands on the target object type (bet #12 unlocked).
//   2. The `on_target_type` filter narrows correctly — a trigger scoped to
//      'bet' does NOT fire on a comment on a task, and vice versa.
//   3. CommentDispatcher's `suppress_auto_dispatch` escape hatch still ONLY
//      suppresses CommentDispatcher — a user-defined 'commented' trigger
//      still fires when metadata.suppress_auto_dispatch is true (tech spec
//      §5.3).
//   4. The matcher rejects action = 'commented' when the workspace is NOT
//      on `trigger_engine_v2` — a safety net that prevents an author from
//      accidentally saving a trigger under an incorrectly-set flag state.
//
// Structure and mocking follow beat6-signal-analyst-chained-trigger.test.ts —
// TriggerRunner runs against a real Postgres, only SessionManager is stubbed,
// events are emitted through an EventEmitter (not a real PG NOTIFY bridge) so
// each test can observe dispatch synchronously without waiting on the LISTEN
// channel.

describe('Commented action trigger (integration)', () => {
	let workspaceId: string
	let actorId: string
	let mockBridge: EventEmitter & PgNotifyBridge
	let previousFlagEnv: string | undefined

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		// EventEmitter subset that TriggerRunner listens against — no PG NOTIFY
		// required, we hand it PgEvent objects directly.
		mockBridge = new EventEmitter() as EventEmitter & PgNotifyBridge

		// Enable trigger_engine_v2 for this workspace so the matcher's flag
		// gate lets the 'commented' path through. Restored in afterEach.
		previousFlagEnv = process.env.FF_WORKSPACE_FEATURES
		process.env.FF_WORKSPACE_FEATURES = `${workspaceId}:trigger_engine_v2`
		// isFlagEnabledForWorkspace reads via the memoized feature-flag config
		// (parsed once from env). Reset so this test's env write is picked up.
		_resetFeatureFlagConfig()
	})

	afterEach(() => {
		// Restore the env var — assigning undefined mimics `delete` for the
		// isFlagEnabledForWorkspace check (it reads through a memoized config
		// derived from a truthy string). biome's `noDelete` is why we don't
		// `delete`.
		process.env.FF_WORKSPACE_FEATURES = previousFlagEnv ?? undefined
		_resetFeatureFlagConfig()
	})

	async function seedBet() {
		return insertObject(db, workspaceId, actorId, { type: 'bet', status: 'active' })
	}

	async function seedTask() {
		return insertObject(db, workspaceId, actorId, { type: 'task', status: 'todo' })
	}

	async function seedAgent(name: string) {
		return insertActor(db, { type: 'agent', name })
	}

	function newRunner(createSession: ReturnType<typeof vi.fn>) {
		return new TriggerRunner(db, mockBridge, {
			createSession,
		} as unknown as SessionManager)
	}

	async function postSampleComment(
		bet: { id: string },
		opts?: { attention?: number; mentions?: string[]; metadata?: Record<string, unknown> },
	) {
		return postComment(db, {
			workspaceId,
			actorId,
			entityId: bet.id,
			entityType: 'object',
			content: 'ping',
			attention: opts?.attention,
			mentions: opts?.mentions,
			metadata: opts?.metadata,
		})
	}

	// Load the event row that postComment created so we can hand its id to the
	// bridge — trigger-runner reads `events.data` by id.
	async function latestCommentEventOn(entityId: string) {
		const rows = await db
			.select()
			.from(events)
			.where(eq(events.entityId, entityId))
			.orderBy(events.id)
		return rows[rows.length - 1]
	}

	async function pollUntil<T>(
		check: () => T | undefined,
		timeoutMs = 2000,
	): Promise<T | undefined> {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			const value = check()
			if (value !== undefined) return value
			await new Promise((resolve) => setTimeout(resolve, 25))
		}
		return check()
	}

	it('fires when a comment lands on the target object type', async () => {
		const targetAgent = await seedAgent('Test Agent A')
		const bet = await seedBet()
		await insertTrigger(db, workspaceId, actorId, targetAgent.id, {
			name: 'On comment posted on any bet',
			type: 'event',
			enabled: true,
			config: {
				entity_type: 'object',
				action: 'commented',
				filter: { on_target_type: 'bet' },
			},
		})

		const commentResult = await postSampleComment(bet)
		expect(commentResult.comment.id).toBeDefined()
		const commentEvent = await latestCommentEventOn(bet.id)
		expect(commentEvent?.action).toBe('commented')

		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const runner = newRunner(createSession)
		await runner.start()
		try {
			mockBridge.emit('event', {
				workspace_id: workspaceId,
				actor_id: actorId,
				action: 'commented',
				entity_type: 'object',
				entity_id: bet.id,
				event_id: String(commentEvent?.id),
			})
			await pollUntil(() => (createSession.mock.calls.length > 0 ? true : undefined))
		} finally {
			await runner.stop()
		}

		expect(createSession).toHaveBeenCalledTimes(1)
		const [, sessionArgs] = createSession.mock.calls[0] as [
			string,
			{ actorId: string; actionPrompt: string; triggerId?: string },
		]
		expect(sessionArgs.actorId).toBe(targetAgent.id)
		expect(sessionArgs.actionPrompt).toContain('commented')
	})

	it('rejects a comment posted on a different target object type via on_target_type', async () => {
		const targetAgent = await seedAgent('Test Agent B')
		const task = await seedTask()
		await insertTrigger(db, workspaceId, actorId, targetAgent.id, {
			name: 'On comment posted on any bet',
			type: 'event',
			enabled: true,
			config: {
				entity_type: 'object',
				action: 'commented',
				filter: { on_target_type: 'bet' },
			},
		})

		await postSampleComment(task)
		const commentEvent = await latestCommentEventOn(task.id)

		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const runner = newRunner(createSession)
		await runner.start()
		try {
			mockBridge.emit('event', {
				workspace_id: workspaceId,
				actor_id: actorId,
				action: 'commented',
				entity_type: 'object',
				entity_id: task.id,
				event_id: String(commentEvent?.id),
			})
			// Give the runner time to consider — 400ms is well past the
			// fire-and-forget matcher pass. Absence of a dispatch is the assertion.
			await new Promise((resolve) => setTimeout(resolve, 400))
		} finally {
			await runner.stop()
		}

		expect(createSession).not.toHaveBeenCalled()
	})

	it('still fires when metadata.suppress_auto_dispatch is true (only CommentDispatcher is suppressed)', async () => {
		const targetAgent = await seedAgent('Test Agent C')
		const bet = await seedBet()
		await insertTrigger(db, workspaceId, actorId, targetAgent.id, {
			name: 'On comment posted on any bet',
			type: 'event',
			enabled: true,
			config: {
				entity_type: 'object',
				action: 'commented',
				filter: { on_target_type: 'bet' },
			},
		})

		await postSampleComment(bet, {
			metadata: { suppress_auto_dispatch: true },
		})
		const commentEvent = await latestCommentEventOn(bet.id)

		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const runner = newRunner(createSession)
		await runner.start()
		try {
			mockBridge.emit('event', {
				workspace_id: workspaceId,
				actor_id: actorId,
				action: 'commented',
				entity_type: 'object',
				entity_id: bet.id,
				event_id: String(commentEvent?.id),
			})
			await pollUntil(() => (createSession.mock.calls.length > 0 ? true : undefined))
		} finally {
			await runner.stop()
		}

		// User trigger STILL fires — `suppress_auto_dispatch` only silences the
		// separate CommentDispatcher code path (tech spec §5.3).
		expect(createSession).toHaveBeenCalledTimes(1)
	})

	it('rejects action = commented when trigger_engine_v2 is off for the workspace', async () => {
		// Turn the flag off for this test only — same undefined-assignment used
		// in afterEach's restore path.
		process.env.FF_WORKSPACE_FEATURES = undefined
		_resetFeatureFlagConfig()

		const targetAgent = await seedAgent('Test Agent D')
		const bet = await seedBet()
		await insertTrigger(db, workspaceId, actorId, targetAgent.id, {
			name: 'On comment posted on any bet',
			type: 'event',
			enabled: true,
			config: {
				entity_type: 'object',
				action: 'commented',
				filter: { on_target_type: 'bet' },
			},
		})

		await postSampleComment(bet)
		const commentEvent = await latestCommentEventOn(bet.id)

		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const runner = newRunner(createSession)
		await runner.start()
		try {
			mockBridge.emit('event', {
				workspace_id: workspaceId,
				actor_id: actorId,
				action: 'commented',
				entity_type: 'object',
				entity_id: bet.id,
				event_id: String(commentEvent?.id),
			})
			await new Promise((resolve) => setTimeout(resolve, 400))
		} finally {
			await runner.stop()
		}

		expect(createSession).not.toHaveBeenCalled()
	})
})
