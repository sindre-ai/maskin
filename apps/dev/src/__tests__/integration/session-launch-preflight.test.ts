import { events, sessions } from '@maskin/db/schema'
import type { SessionResultFailureReason } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
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

function failureReasonOf(result: unknown): SessionResultFailureReason | null {
	return (result as { failure_reason?: SessionResultFailureReason } | null)?.failure_reason ?? null
}

// Both suites cover the same incident: six trigger sessions on 2026-08-26 sat
// in `starting` with no container, no agent-server, no logs and an empty
// `config`, until the 10-minute zombie reaper closed them out with the generic
// 'Session stuck in starting state'. Nothing on the row said credential
// resolution was the cause, which sent the on-call after the container pool.
//
// Real Postgres rather than the mocked query builder because what's asserted is
// the persisted terminal shape — status, `result.failure_reason`, and the
// audit/SSE event row — across several writes in one launch path.
describe('SessionManager launch — LLM credential pre-flight (Integration)', () => {
	let workspaceId: string
	let actorId: string
	let agentId: string
	const savedFallbackKey = process.env.MASKIN_FALLBACK_OPENROUTER_KEY

	beforeEach(async () => {
		// A workspace with no BYO credentials would otherwise still resolve the
		// maskin_plan route whenever the operator's OpenRouter key happens to be
		// set in the environment running the suite. Clearing it makes "no route
		// is configured at all" deterministic rather than environment-dependent.
		// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
		delete process.env.MASKIN_FALLBACK_OPENROUTER_KEY
		actorId = getTestActorId()
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
	})

	afterEach(() => {
		if (savedFallbackKey === undefined) {
			// biome-ignore lint/performance/noDelete: assigning undefined coerces to the string "undefined" in Node.js
			delete process.env.MASKIN_FALLBACK_OPENROUTER_KEY
		} else {
			process.env.MASKIN_FALLBACK_OPENROUTER_KEY = savedFallbackKey
		}
	})

	it('fails a session with a not_logged_in reason instead of launching it', async () => {
		const ws = await insertWorkspace(db, actorId, { byollmAllowed: true, settings: {} })
		workspaceId = ws.id
		const pending = await insertSession(db, workspaceId, agentId, actorId, {
			status: 'pending',
			containerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.startSession(pending.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
		expect(row?.status).toBe('failed')
		expect(row?.completedAt).not.toBeNull()
		// The pre-flight runs before any runtime is created, so nothing was
		// launched and no container or sandbox was ever assigned.
		expect(row?.containerId).toBeNull()
		expect(row?.agentServerId).toBeNull()

		const reason = failureReasonOf(row?.result)
		expect(reason?.reason_code).toBe('not_logged_in')
		expect(reason?.human_message).toMatch(/no working LLM credentials/i)
		// The detail is what makes it diagnosable without server logs.
		expect(reason?.verbatim_output).toMatch(/Claude subscription/i)
	})

	it('writes the session_failed event so the audit log and SSE feed see it', async () => {
		const ws = await insertWorkspace(db, actorId, { byollmAllowed: true, settings: {} })
		workspaceId = ws.id
		const pending = await insertSession(db, workspaceId, agentId, actorId, {
			status: 'pending',
			containerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.startSession(pending.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		const eventRows = await db.select().from(events).where(eq(events.entityId, pending.id))
		const failed = eventRows.find((e) => e.action === 'session_failed')
		expect(failed).toBeDefined()
		expect((failed?.data as Record<string, unknown>).reason_code).toBe('not_logged_in')
	})

	it('lets a session through when the workspace has an Anthropic key configured', async () => {
		const ws = await insertWorkspace(db, actorId, {
			byollmAllowed: true,
			settings: { llm_keys: { anthropic: 'sk-ant-test' } },
		})
		workspaceId = ws.id
		const pending = await insertSession(db, workspaceId, agentId, actorId, {
			status: 'pending',
			containerId: null,
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			// The launch itself still fails past the pre-flight — there is no Docker
			// or agent-server in this suite. What matters is that it was NOT
			// rejected for missing credentials.
			await manager.startSession(pending.id).catch(() => {})
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
		expect(failureReasonOf(row?.result)?.reason_code).not.toBe('not_logged_in')
	})
})

describe('SessionManager.runWatchdog — stalled launches carry a reason (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	it('classifies a session stuck in starting as startup_stalled and names what it reached', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const stuck = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'starting',
			containerId: null,
			startedAt: null,
			config: {},
			updatedAt: new Date(Date.now() - 20 * 60 * 1000),
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, stuck.id))
		expect(row?.status).toBe('failed')

		const reason = failureReasonOf(row?.result)
		expect(reason?.reason_code).toBe('startup_stalled')
		expect(reason?.human_message).toMatch(/never started/i)
		// An empty `config` means route resolution never returned — the exact
		// signature of the 2026-08-26 incident, and the part that points at
		// credentials rather than at the container pool.
		expect(reason?.verbatim_output).toMatch(/before an LLM route was resolved/i)
		expect(reason?.verbatim_output).toMatch(/Sat in 'starting' for \d+s/)

		const eventRows = await db.select().from(events).where(eq(events.entityId, stuck.id))
		const failed = eventRows.find((e) => e.action === 'session_failed')
		expect((failed?.data as Record<string, unknown>).reason_code).toBe('startup_stalled')
	})

	it('reports a route-resolved stall differently from a pre-route stall', async () => {
		const agent = await insertActor(db, { type: 'agent' })
		const stuck = await insertSession(db, workspaceId, agent.id, actorId, {
			status: 'starting',
			containerId: null,
			startedAt: null,
			config: { llm_route: 'claude_oauth', llm_oauth_slot: 'primary' },
			updatedAt: new Date(Date.now() - 20 * 60 * 1000),
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			await (manager as unknown as { runWatchdog(): Promise<void> }).runWatchdog()
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, stuck.id))
		const reason = failureReasonOf(row?.result)
		expect(reason?.reason_code).toBe('startup_stalled')
		expect(reason?.verbatim_output).toMatch(/after resolving the claude_oauth LLM route/i)
	})
})
