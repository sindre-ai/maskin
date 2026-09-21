import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

/**
 * Foundational task for the session-cost accounting bet: every maskin_plan
 * session must land with `sessions.model_name` non-null (the OpenRouter model
 * that will actually run) and `sessions.config.llm_route = 'maskin_plan'` so
 * the follow-on local cost resolver has the fields it needs. Non-maskin_plan
 * routes (claude_oauth, BYO) leave `model_name` null on purpose — Claude
 * Code's own `total_cost_usd` stays ground truth there.
 *
 * Real Postgres rather than a mocked query builder because what's asserted is
 * the persisted terminal shape on the row after a full route-resolve pass,
 * across the new `model_name` column added in `0073_sessions_model_name.sql`.
 * A mocked DB test cannot prove the migration is applied or that the schema
 * exposes the column.
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

describe('SessionManager.buildLaunchSpec — stamps sessions.model_name on maskin_plan dispatch (Integration)', () => {
	let workspaceId: string
	let actorId: string
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

		actorId = getTestActorId()
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
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

	it('writes model_name = MASKIN_FALLBACK_MODEL and config.llm_route = "maskin_plan" for a pro-plan workspace with no BYO credentials', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: { billing: { plan: 'pro', hard_cap_usd_cents: 100_000, period_start: 0 } },
		})
		workspaceId = ws.id
		const pending = await insertSession(db, workspaceId, agentId, actorId, {
			status: 'pending',
			containerId: null,
			config: {},
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			const [session] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
			await manager.buildLaunchSpec(
				session as unknown as Parameters<typeof manager.buildLaunchSpec>[0],
			)
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
		expect(row?.modelName).toBe('deepseek/deepseek-v4-flash')
		expect((row?.config as { llm_route?: string } | null)?.llm_route).toBe('maskin_plan')
	})

	it('leaves model_name null on a workspace-anthropic-key route (BYO / non-maskin_plan)', async () => {
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: true,
			settings: { llm_keys: { anthropic: 'sk-ant-integration-test' } },
		})
		workspaceId = ws.id
		const pending = await insertSession(db, workspaceId, agentId, actorId, {
			status: 'pending',
			containerId: null,
			config: {},
		})

		const manager = new SessionManager(db, stubStorage())
		try {
			const [session] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
			await manager
				.buildLaunchSpec(session as unknown as Parameters<typeof manager.buildLaunchSpec>[0])
				.catch(() => {
					// Downstream GitHub preflight / integrations lookup may throw
					// in the integration harness — the write path under test runs
					// before those, so an error further down doesn't invalidate
					// the assertion.
				})
		} finally {
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, pending.id))
		expect(row?.modelName).toBeNull()
		// The route stamp is still applied — that path is unchanged from before.
		expect((row?.config as { llm_route?: string } | null)?.llm_route).toBe('workspace_api_key')
	})
})
