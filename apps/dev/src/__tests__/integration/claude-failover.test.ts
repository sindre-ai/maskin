import { events, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import {
	FAILOVER_TRIGGERED_ACTION,
	resolveClaudeCredentialsWithFailover,
} from '../../lib/claude-failover'
import type { ClassifierInput } from '../../lib/claude-failure-classifier'
import { headersFrom } from '../../lib/claude-failure-classifier'
import type { EncryptedOAuthData } from '../../lib/claude-oauth'
import { encrypt } from '../../lib/crypto'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

/**
 * AC-T2 of the Claude Code subscription failover bet against real Postgres:
 * two concurrent session-starts hitting the same failure window must emit
 * exactly one `claude_subscription_failover_triggered` event AND both must
 * converge on the backup slot. The unit-suite Drizzle mocks can't model the
 * row-lock serialization that makes this true — only an integration test
 * exercising `db.transaction` + `SELECT ... FOR UPDATE` on the workspace
 * row does. Also covers the AC-T5 flag-off invariant (no event emitted).
 */
describe('Claude failover — session-start credential resolver against Postgres', () => {
	function futureBlob(overrides?: Partial<EncryptedOAuthData>): EncryptedOAuthData {
		return {
			encryptedAccessToken: encrypt('access-plain'),
			encryptedRefreshToken: encrypt('refresh-plain'),
			// Well in the future — refresh path is not exercised by these tests,
			// so no live Anthropic call fires from `refreshClaudeTokenIfNeeded`.
			expiresAt: Date.now() + 24 * 60 * 60 * 1000,
			subscriptionType: 'pro',
			...overrides,
		}
	}

	async function countFailoverEvents(workspaceId: string): Promise<number> {
		const rows = await db
			.select({ id: events.id })
			.from(events)
			.where(and(eq(events.workspaceId, workspaceId), eq(events.action, FAILOVER_TRIGGERED_ACTION)))
		return rows.length
	}

	it('AC-T2: two concurrent failovers emit exactly one event and both return backup', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: futureBlob(),
					backup: futureBlob({ encryptedAccessToken: encrypt('backup-plain') }),
					failover: { active_slot: 'primary' },
				},
			},
		})

		// AC-T3 fixture — 401 → failover(auth_failed). Same probe on both sessions.
		const probe = async (): Promise<ClassifierInput> => ({
			kind: 'http',
			status: 401,
			headers: headersFrom({}),
		})
		const now = () => 1_800_000_060_000

		const [a, b] = await Promise.all([
			resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: ws.id,
				actorId: actor.id,
				probe,
				now,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			}),
			resolveClaudeCredentialsWithFailover({
				db,
				workspaceId: ws.id,
				actorId: actor.id,
				probe,
				now,
				env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
			}),
		])

		expect(a?.slot).toBe('backup')
		expect(b?.slot).toBe('backup')
		expect(a?.tokens.accessToken).toBe('backup-plain')
		expect(b?.tokens.accessToken).toBe('backup-plain')

		expect(await countFailoverEvents(ws.id)).toBe(1)

		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = row.settings as Record<string, unknown>
		const claudeOAuth = settings.claude_oauth as Record<string, unknown>
		expect(claudeOAuth.failover).toEqual({
			active_slot: 'backup',
			last_primary_failure_at: 1_800_000_060_000,
			last_classified_reason: 'auth_failed',
		})
	})

	it('AC-T5: flag off does not probe, emit events, or write failover state', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: {
					primary: futureBlob(),
					backup: futureBlob({ encryptedAccessToken: encrypt('backup-plain') }),
					failover: { active_slot: 'primary' },
				},
			},
		})

		// Even a probe that would classify to failover must not affect anything.
		const probe = async (): Promise<ClassifierInput> => ({
			kind: 'http',
			status: 401,
			headers: headersFrom({}),
		})

		const result = await resolveClaudeCredentialsWithFailover({
			db,
			workspaceId: ws.id,
			actorId: actor.id,
			probe,
			env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'false' },
		})

		expect(result?.slot).toBe('primary')
		expect(await countFailoverEvents(ws.id)).toBe(0)

		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, ws.id)).limit(1)
		const settings = row.settings as Record<string, unknown>
		const claudeOAuth = settings.claude_oauth as Record<string, unknown>
		expect(claudeOAuth.failover).toEqual({ active_slot: 'primary' })
	})

	it('AC-U4: only primary connected — failover verdict does NOT emit an event', async () => {
		const actor = await insertActor(db)
		const ws = await insertWorkspace(db, actor.id, {
			settings: {
				enabled_modules: ['work'],
				claude_oauth: { primary: futureBlob() },
			},
		})

		const probe = async (): Promise<ClassifierInput> => ({
			kind: 'http',
			status: 401,
			headers: headersFrom({}),
		})

		const result = await resolveClaudeCredentialsWithFailover({
			db,
			workspaceId: ws.id,
			actorId: actor.id,
			probe,
			env: { MASKIN_CLAUDE_FAILOVER_ENABLED: 'true' },
		})

		expect(result?.slot).toBe('primary')
		expect(await countFailoverEvents(ws.id)).toBe(0)
	})
})
