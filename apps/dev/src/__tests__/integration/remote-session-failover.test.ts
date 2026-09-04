import { agentServers, sessions, workspaces } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, ne } from 'drizzle-orm'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import { encrypt } from '../../lib/crypto'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, sql } from './global-setup'

/**
 * Regression coverage for the completion path that a production session
 * actually takes.
 *
 * `handleCompletion` (local Docker) classified the stdout tail and called
 * `maybeRetryClaudeOAuthOnNextSlot`; `markRemoteSessionComplete` — the path
 * for every session dispatched to an agent-server, which is how sessions run
 * in production — did neither. It wrote `{ exit_code }` and returned. So a
 * subscription that hit its usage limit produced a bare failed session, the
 * workspace's `active_slot` never moved, and every following session landed
 * on the same spent subscription. Connecting more subscriptions could not
 * help, because nothing ever walked the chain.
 *
 * Mocked-DB tests cannot show this: the point is the real row transition and
 * the retry session that has to exist afterwards.
 */
describe('Remote session completion — Claude subscription failover (Integration)', () => {
	function futureBlob(overrides?: Partial<EncryptedOAuthData>): EncryptedOAuthData {
		return {
			encryptedAccessToken: encrypt('primary-access-plain'),
			encryptedRefreshToken: encrypt('primary-refresh-plain'),
			// Far future so nothing here reaches the live token-refresh path.
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			subscriptionType: 'pro',
			...overrides,
		}
	}

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

	// The verbatim shape a spent Claude subscription produces, taken from a real
	// failed production session: the structured rate_limit_event the CLI emits
	// followed by the banner it prints. `claudeRuntimeFailoverReason` reads
	// `rateLimitType` out of the former to tell a 5-hour limit from a weekly one.
	const LIMIT_TAIL =
		'{"type":"rate_limit_event","rate_limit_info":{"status":"rejected","resetsAt":1788532200,"rateLimitType":"five_hour","overageStatus":"rejected","overageDisabledReason":"org_level_disabled","isUsingOverage":false}}\n' +
		"You've hit your limit · resets 2:30pm (UTC)\n"

	let workspaceId: string
	let actorId: string
	let agentServerId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		actorId = actor.id
		const ws = await insertWorkspace(db, actorId, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: futureBlob(),
					backup: futureBlob({ encryptedAccessToken: encrypt('backup-access-plain') }),
					failover: { active_slot: 'primary' },
				},
			},
		})
		workspaceId = ws.id

		// global-setup truncates sessions but NOT agent_servers.
		await sql`TRUNCATE agent_servers CASCADE`
		const [server] = await db
			.insert(agentServers)
			.values({
				url: 'https://agent-under-test.maskin.test:3001',
				secret: 'x'.repeat(32),
				maxConcurrentSessions: 10,
				status: 'active',
			})
			.returning()
		agentServerId = server.id
	})

	async function completeRemoteSessionOnLimit(exitCode: number) {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId,
			containerId: 'sandbox-under-test',
			config: { llm_route: 'claude_oauth', llm_oauth_slot: 'primary' },
		})
		// A remote session's stdout lives only in session_logs — there is no
		// in-memory tail buffer for it, which is why the classifier had nothing
		// to read on this path before.
		await insertSessionLog(db, session.id, { stream: 'stdout', content: LIMIT_TAIL })

		const manager = new SessionManager(db, stubStorage())
		// The retry session is created with autoStart — stub the launch so the
		// test asserts on the row that gets created, not on Docker.
		const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(undefined)
		try {
			await manager.markRemoteSessionComplete(session.id, exitCode)
		} finally {
			startSpy.mockRestore()
			await manager.stop()
		}
		return session
	}

	it('classifies the limit, moves the workspace to the next subscription, and starts one retry', async () => {
		vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', 'true')
		const session = await completeRemoteSessionOnLimit(1)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		expect(row?.status).toBe('failed')
		// Before the fix this was `{ exit_code: 1 }` with no failure_reason at all,
		// so the UI had nothing to render but the raw exit code.
		expect(row?.result).toMatchObject({
			exit_code: 1,
			failure_reason: { provider: 'anthropic', reason_code: 'session_limit' },
		})

		// The workspace pointer actually moved — this is what stops the NEXT
		// session landing on the spent subscription.
		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		const claudeOauth = (ws?.settings as { claude_oauth?: { failover?: { active_slot?: string } } })
			?.claude_oauth
		expect(claudeOauth?.failover?.active_slot).toBe('backup')

		// And the work was actually picked back up on the next subscription.
		const retries = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), ne(sessions.id, session.id)))
		expect(retries).toHaveLength(1)
		expect(retries[0]?.config).toMatchObject({
			llm_route: 'claude_oauth',
			llm_oauth_slot: 'backup',
			claude_oauth_runtime_failover_retry_of: session.id,
		})
	})

	it('does not fail over when the kill-switch flag is off', async () => {
		vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', 'false')
		const session = await completeRemoteSessionOnLimit(1)

		// The classification is still recorded — it describes what happened, and
		// the flag governs failover, not diagnosis.
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		expect(row?.result).toMatchObject({
			failure_reason: { reason_code: 'session_limit' },
		})

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		const claudeOauth = (ws?.settings as { claude_oauth?: { failover?: { active_slot?: string } } })
			?.claude_oauth
		expect(claudeOauth?.failover?.active_slot).toBe('primary')

		const retries = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), ne(sessions.id, session.id)))
		expect(retries).toHaveLength(0)
	})

	it('flips an exitCode 0 remote session to failed when the CLI printed a limit banner', async () => {
		// The CLI can print the banner and still exit 0. The local path already
		// treated that as a failure; the remote path reported it as a clean
		// success, which is the other half of "sessions just fail" looking
		// inexplicable in the timeline.
		vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', 'true')
		const session = await completeRemoteSessionOnLimit(0)

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		expect(row?.status).toBe('failed')
		expect(row?.result).toMatchObject({
			exit_code: 0,
			failure_reason: { reason_code: 'session_limit' },
		})
	})

	it('leaves an ordinary remote failure untouched', async () => {
		vi.stubEnv('MASKIN_CLAUDE_FAILOVER_ENABLED', 'true')
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			agentServerId,
			containerId: 'sandbox-under-test',
			config: { llm_route: 'claude_oauth', llm_oauth_slot: 'primary' },
		})
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: 'TypeError: cannot read properties of undefined\n',
		})

		const manager = new SessionManager(db, stubStorage())
		const startSpy = vi.spyOn(manager, 'startSession').mockResolvedValue(undefined)
		try {
			await manager.markRemoteSessionComplete(session.id, 1)
		} finally {
			startSpy.mockRestore()
			await manager.stop()
		}

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id)).limit(1)
		expect(row?.status).toBe('failed')
		expect(row?.result).not.toHaveProperty('failure_reason')

		const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId)).limit(1)
		const claudeOauth = (ws?.settings as { claude_oauth?: { failover?: { active_slot?: string } } })
			?.claude_oauth
		expect(claudeOauth?.failover?.active_slot).toBe('primary')

		const retries = await db
			.select()
			.from(sessions)
			.where(and(eq(sessions.workspaceId, workspaceId), ne(sessions.id, session.id)))
		expect(retries).toHaveLength(0)
	})
})
