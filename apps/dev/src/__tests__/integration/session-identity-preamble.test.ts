import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * The CLI under a session (Claude Code, Codex, …) injects its own identity
 * text into the model's context; an agent's own persona prompt never
 * contradicts it, so an agent asked what it runs on answers with the
 * underlying model/vendor instead of Maskin. The fix prepends a Maskin
 * identity preamble to SYSTEM_PROMPT in `buildLaunchSpec`.
 *
 * Real Postgres rather than a mocked query builder because `buildLaunchSpec`
 * assembles SYSTEM_PROMPT from the agent row it reads back — the persona that
 * must survive behind the preamble only exists because it was persisted and
 * re-read. A mocked DB test hands the manager the object it already holds,
 * which cannot prove the row round-trips.
 */
function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		listWithMetadata: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

describe('SessionManager.buildLaunchSpec — Maskin identity preamble (Integration)', () => {
	let workspaceId: string
	let agentId: string

	const savedEnv: Record<string, string | undefined> = {}
	const trackedEnvKeys = [
		'MASKIN_FALLBACK_OPENROUTER_KEY',
		'MASKIN_FALLBACK_BASE_URL',
		'MASKIN_FALLBACK_MODEL',
		'MASKIN_FALLBACK_SMALL_MODEL',
	] as const

	beforeEach(async () => {
		for (const key of trackedEnvKeys) {
			savedEnv[key] = process.env[key]
		}
		process.env.MASKIN_FALLBACK_OPENROUTER_KEY = 'sk-or-integration-test'
		process.env.MASKIN_FALLBACK_BASE_URL = 'https://openrouter.ai/api'
		process.env.MASKIN_FALLBACK_MODEL = 'deepseek/deepseek-v4-flash'

		const actorId = getTestActorId()
		const agent = await insertActor(db, {
			type: 'agent',
			systemPrompt: 'You are Workspace Coach.',
		})
		agentId = agent.id
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: { billing: { plan: 'pro', hard_cap_usd_cents: 100_000, period_start: 0 } },
		})
		workspaceId = ws.id
	})

	afterEach(() => {
		for (const key of trackedEnvKeys) {
			if (savedEnv[key] === undefined) {
				delete process.env[key]
			} else {
				process.env[key] = savedEnv[key]
			}
		}
	})

	it('prepends the identity preamble to the persisted agent prompt, and names no underlying provider', async () => {
		const pending = await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'pending',
			containerId: null,
			config: {},
		})

		const manager = new SessionManager(db, stubStorage())
		let systemPrompt: string
		try {
			const [session] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
			const spec = await manager.buildLaunchSpec(session)
			systemPrompt = spec.env.SYSTEM_PROMPT
		} finally {
			await manager.stop()
		}

		expect(systemPrompt.startsWith('You are a Maskin agent')).toBe(true)
		// The agent's own persona, read back from the row, still follows it.
		expect(systemPrompt).toContain('You are Workspace Coach.')
		// The branding end-state: nothing in the assembled prompt names the
		// model or vendor behind the session.
		expect(systemPrompt).not.toMatch(/claude|anthropic/i)
	})

	it('keeps the identity preamble ahead of the conversation preamble for a chat session', async () => {
		const pending = await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'pending',
			containerId: null,
			config: { conversation: true },
		})

		const manager = new SessionManager(db, stubStorage())
		let systemPrompt: string
		try {
			const [session] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
			const spec = await manager.buildLaunchSpec(session)
			systemPrompt = spec.env.SYSTEM_PROMPT
		} finally {
			await manager.stop()
		}

		const identityAt = systemPrompt.indexOf('You are a Maskin agent')
		const conversationAt = systemPrompt.indexOf('You are in a live, interactive chat conversation')
		expect(identityAt).toBe(0)
		expect(conversationAt).toBeGreaterThan(identityAt)
	})
})
