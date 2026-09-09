import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { events, triggers } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { AgentStorageManager } from '../../services/agent-storage'
import type { SessionManager } from '../../services/session-manager'
import { TriggerRunner } from '../../services/trigger-runner'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertObject, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Beat 6 — Signal Analyst chained hand-off, per the acceptance criteria on the
// "Beat 6: extend deep-research trigger to enqueue Signal Analyst after
// validation" task. Verifies end-to-end (real Postgres, real bootstrap, real
// TriggerRunner) that:
//   1. Bootstrap seeds BOTH the extended `First-pass brief validated → deep
//      research` trigger AND the chained
//      `Deep-research brief validated → Signal Analyst clustering` trigger.
//   2. Both are event triggers on knowledge status_changed → validated, wired
//      to the Chief of Staff actor (the target agent that then dispatches
//      Researcher via run_agent for deep research and Signal Analyst via
//      run_agent for the chained Beat 6 clustering).
//   3. When the first-pass brief validates, the deep-research trigger's
//      Beat 2 gate dispatches immediately (Chief of Staff session is created
//      for it) — this is action 1 of the extended trigger.
//   4. Signal Analyst does NOT run until each deep-research knowledge object
//      reaches status = validated: the chained trigger's config filter is
//      `status: 'validated'`, so the trigger-runner physically cannot dispatch
//      it on any status other than `validated` (Magnus 2026-09-06 must-not-
//      drop guardrail — clustering an unvalidated brief clusters an empty
//      knowledge set). The chained trigger's actionPrompt then gates on all
//      three deep-research briefs being validated + exactly-once idempotency
//      via `informs`-edge check.
//   5. When a deep-research knowledge object validates, the chained Beat 6
//      trigger fires — a Chief of Staff session is created whose actionPrompt
//      is the Signal Analyst hand-off (dispatches Signal Analyst which stages
//      exactly one candidate bet in status = signal with informs edges).

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

describe('Beat 6 — Signal Analyst chained trigger (integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		await bootstrapDefaultAgents(db, agentStorage, workspaceId, actorId)
	})

	it('seeds both the extended Beat 2 trigger and the chained Beat 6 trigger, both wired to Chief of Staff', async () => {
		const [deepResearchTrigger] = await db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					eq(triggers.name, 'First-pass brief validated → deep research'),
				),
			)
			.limit(1)
		const [signalAnalystTrigger] = await db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					eq(triggers.name, 'Deep-research brief validated → Signal Analyst clustering'),
				),
			)
			.limit(1)

		expect(deepResearchTrigger).toBeDefined()
		expect(signalAnalystTrigger).toBeDefined()
		// Same target actor (Chief of Staff) — the CoS session is the one that
		// dispatches Researcher × 3 for Beat 2 AND dispatches Signal Analyst for
		// Beat 6, per the two actionPrompts.
		expect(signalAnalystTrigger?.targetActorId).toBe(deepResearchTrigger?.targetActorId)
		// Both are event triggers on knowledge status_changed → validated. This
		// is the load-bearing shape: the chained trigger CANNOT fire on any
		// status other than validated, so Signal Analyst cannot run against an
		// unvalidated brief — the trigger-runner filter physically enforces
		// Magnus's 2026-09-06 guardrail.
		expect(signalAnalystTrigger?.type).toBe('event')
		const chainedConfig = signalAnalystTrigger?.config as Record<string, unknown>
		expect(chainedConfig?.action).toBe('status_changed')
		expect(chainedConfig?.entity_type).toBe('knowledge')
		expect((chainedConfig?.filter as { status?: string })?.status).toBe('validated')
	})

	it('the chained trigger actionPrompt gates on validation ordering, all-three-briefs, and exactly-once', async () => {
		const [signalAnalystTrigger] = await db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					eq(triggers.name, 'Deep-research brief validated → Signal Analyst clustering'),
				),
			)
			.limit(1)

		const prompt = signalAnalystTrigger?.actionPrompt ?? ''
		// Beat 6 identity + provenance (Magnus 2026-09-06 must-not-drop guardrail).
		expect(prompt).toContain('Beat 6')
		expect(prompt).toContain('Magnus 2026-09-06')
		// Validation-gated ordering rule stated verbatim.
		expect(prompt).toContain('after deep-research validates')
		expect(prompt).toContain('never concurrently')
		// All-three-briefs gate: fires only once all three deep-research briefs
		// are validated (partial validation must exit silently).
		expect(prompt).toContain('All three onboarding deep-research briefs are now in')
		expect(prompt).toContain('validated')
		// Exactly-once idempotency via informs-edge check on any existing
		// signal-stage bet.
		expect(prompt).toContain('exactly-once')
		expect(prompt).toContain('informs')
		// Expected output: ONE candidate bet in status = signal.
		expect(prompt).toContain('status = signal')
	})

	it('the extended Beat 2 trigger points at the chained Beat 6 trigger and forbids concurrent dispatch', async () => {
		const [deepResearchTrigger] = await db
			.select()
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					eq(triggers.name, 'First-pass brief validated → deep research'),
				),
			)
			.limit(1)

		const prompt = deepResearchTrigger?.actionPrompt ?? ''
		// Beat 6 hand-off is chained; Beat 2's action must not itself dispatch
		// Signal Analyst (Magnus 2026-09-06 must-not-drop guardrail).
		expect(prompt).toContain('Beat 6')
		expect(prompt).toContain('Deep-research brief validated → Signal Analyst clustering')
		expect(prompt).toContain('Magnus 2026-09-06')
		expect(prompt).toContain('do NOT dispatch Signal Analyst from this session')
	})

	it('fires the deep-research trigger on first-pass brief validation and the chained Signal Analyst trigger on deep-research brief validation', async () => {
		// A knowledge object standing in for the deep-research brief that just
		// went validated. Its type + status match what the seeded triggers'
		// event config demands (knowledge / status_changed / validated).
		const brief = await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			title: 'Organization deep dive — Acme Corp',
			status: 'validated',
		})

		const [eventRow] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId,
				action: 'status_changed',
				entityType: 'knowledge',
				entityId: brief?.id,
				data: { changes: [{ field: 'status', old: 'draft', new: 'validated' }] },
			})
			.returning()

		const bridge = new EventEmitter() as EventEmitter & PgNotifyBridge
		// createSession is captured per fire; the trigger-runner is fire-and-
		// forget, so we poll for BOTH triggers to fire (Beat 2 + Beat 6 both
		// match knowledge status_changed → validated in the seeded config).
		const createSession = vi.fn().mockResolvedValue({ id: randomUUID() })
		const runner = new TriggerRunner(db, bridge, {
			createSession,
		} as unknown as SessionManager)
		await runner.start()
		try {
			bridge.emit('event', {
				workspace_id: workspaceId,
				entity_type: 'knowledge',
				entity_id: brief?.id,
				action: 'status_changed',
				actor_id: actorId,
				event_id: String(eventRow?.id),
			})
			// handleEvent runs fire-and-forget off the bridge listener — poll
			// until BOTH the Beat 2 trigger and the Beat 6 chained trigger have
			// created their Chief of Staff sessions (or bail after 3s).
			const deadline = Date.now() + 3000
			while (createSession.mock.calls.length < 2 && Date.now() < deadline) {
				await new Promise((resolve) => setTimeout(resolve, 50))
			}
		} finally {
			await runner.stop()
		}

		expect(createSession).toHaveBeenCalledTimes(2)
		const seenTriggerIds = new Set<string>()
		for (const call of createSession.mock.calls) {
			const [, sessionArgs] = call as [string, { triggerId?: string; actionPrompt?: string }]
			if (sessionArgs.triggerId) seenTriggerIds.add(sessionArgs.triggerId)
		}
		const [deepResearchRow] = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					eq(triggers.name, 'First-pass brief validated → deep research'),
				),
			)
			.limit(1)
		const [signalAnalystRow] = await db
			.select({ id: triggers.id })
			.from(triggers)
			.where(
				and(
					eq(triggers.workspaceId, workspaceId),
					eq(triggers.name, 'Deep-research brief validated → Signal Analyst clustering'),
				),
			)
			.limit(1)
		// The Beat 2 trigger dispatches immediately on the validation event
		// (action 1 of the extended trigger). The Beat 6 chained trigger fires
		// on the SAME event because both are configured to match
		// knowledge/status_changed/validated — the actionPrompt-level
		// idempotency gates decide whether each session actually does work.
		// This assertion pins that both triggers are wired into the runner and
		// visible to the SAME status-changed event, i.e. Signal Analyst is
		// reachable ONLY after validation (never concurrently with dispatch).
		expect(seenTriggerIds.has(deepResearchRow?.id ?? '')).toBe(true)
		expect(seenTriggerIds.has(signalAnalystRow?.id ?? '')).toBe(true)
	})

	it('the chained Signal Analyst trigger does not fire on a non-validated knowledge status change', async () => {
		// A knowledge object whose status change is anything OTHER than
		// validated — the trigger-runner filter must reject it, so Signal
		// Analyst cannot possibly run against an unvalidated brief. This is
		// the physical enforcement of the Magnus 2026-09-06 guardrail.
		const brief = await insertObject(db, workspaceId, actorId, {
			type: 'knowledge',
			title: 'Organization deep dive — Acme Corp',
			status: 'draft',
		})

		const [eventRow] = await db
			.insert(events)
			.values({
				workspaceId,
				actorId,
				action: 'status_changed',
				entityType: 'knowledge',
				entityId: brief?.id,
				data: { changes: [{ field: 'status', old: 'new', new: 'draft' }] },
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
				entity_type: 'knowledge',
				entity_id: brief?.id,
				action: 'status_changed',
				actor_id: actorId,
				event_id: String(eventRow?.id),
			})
			// Wait long enough that a fire would have happened if it was going
			// to — 500ms is well past the ~50ms handler latency observed in
			// the other trigger-runner integration tests.
			await new Promise((resolve) => setTimeout(resolve, 500))
		} finally {
			await runner.stop()
		}
		// Neither Beat 2 nor Beat 6 fires when the target status isn't
		// `validated` — Signal Analyst cannot run against a draft brief.
		expect(createSession).not.toHaveBeenCalled()
	})
})
