import { agentEmailSends } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import {
	checkAgentEmailRateLimit,
	findExistingAgentEmailSend,
	isUniqueViolation,
	recordAgentEmailSend,
} from '../../lib/integrations/providers/email/hardening'
import { insertActor, insertWorkspace } from '../factories'
import { db } from './global-setup'

// Ledger + hardening primitives run against real Postgres so the migration
// semantics that the tool depends on — the partial UNIQUE index on
// (workspace_id, actor_id, idempotency_key) and the rolling-hour COUNT —
// are covered end-to-end. These cannot be verified in the mocked unit tests.

describe('agent_email_sends — hardening primitives against real Postgres', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		const actor = await insertActor(db)
		if (!actor) throw new Error('actor insert returned no row')
		const ws = await insertWorkspace(db, actor.id)
		if (!ws) throw new Error('workspace insert returned no row')
		actorId = actor.id
		workspaceId = ws.id
	})

	it('rate-limit COUNT respects the sliding one-hour window', async () => {
		// Three rows now, well under the default ceiling of 10 → allowed.
		for (let i = 0; i < 3; i++) {
			await recordAgentEmailSend(db, {
				workspaceId,
				actorId,
				idempotencyKey: null,
				providerMessageId: `msg_${i}`,
			})
		}

		const result = await checkAgentEmailRateLimit(db, actorId, { limitPerHour: 10 })
		expect(result.ok).toBe(true)
		if (!result.ok) throw new Error('expected allowed')
		expect(result.used).toBe(3)

		// Nudge one row's sent_at outside the window; the count should drop.
		await db
			.update(agentEmailSends)
			.set({ sentAt: new Date(Date.now() - 2 * 60 * 60 * 1000) })
			.where(eq(agentEmailSends.providerMessageId, 'msg_0'))

		const after = await checkAgentEmailRateLimit(db, actorId, { limitPerHour: 10 })
		expect(after.ok).toBe(true)
		if (!after.ok) throw new Error('expected allowed')
		expect(after.used).toBe(2)
	})

	it('blocks at the ceiling and returns a positive retryAfterSeconds', async () => {
		for (let i = 0; i < 3; i++) {
			await recordAgentEmailSend(db, {
				workspaceId,
				actorId,
				idempotencyKey: null,
				providerMessageId: `msg_ceiling_${i}`,
			})
		}
		const result = await checkAgentEmailRateLimit(db, actorId, { limitPerHour: 3 })
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected block')
		expect(result.error).toBe('rate_limit_exceeded')
		expect(result.limit).toBe(3)
		expect(result.used).toBe(3)
		expect(result.retryAfterSeconds).toBeGreaterThan(0)
	})

	it('rate-limit scoping is per-actor: a second actor is not affected', async () => {
		const other = await insertActor(db, { email: 'second@example.com' })
		if (!other) throw new Error('other actor insert returned no row')

		for (let i = 0; i < 5; i++) {
			await recordAgentEmailSend(db, {
				workspaceId,
				actorId,
				idempotencyKey: null,
				providerMessageId: `msg_actor1_${i}`,
			})
		}

		const own = await checkAgentEmailRateLimit(db, actorId, { limitPerHour: 5 })
		const others = await checkAgentEmailRateLimit(db, other.id, { limitPerHour: 5 })
		expect(own.ok).toBe(false)
		expect(others.ok).toBe(true)
	})

	it('partial UNIQUE index rejects a duplicate (workspace, actor, key) with 23505', async () => {
		await recordAgentEmailSend(db, {
			workspaceId,
			actorId,
			idempotencyKey: 'key-1',
			providerMessageId: 'msg_first',
		})

		let caught: unknown
		try {
			await recordAgentEmailSend(db, {
				workspaceId,
				actorId,
				idempotencyKey: 'key-1',
				providerMessageId: 'msg_second',
			})
		} catch (err) {
			caught = err
		}
		expect(caught).toBeDefined()
		expect(isUniqueViolation(caught)).toBe(true)

		// findExistingAgentEmailSend must return the ORIGINAL row's message id
		// — the second insert never landed, so the ledger contract is stable.
		const found = await findExistingAgentEmailSend(db, workspaceId, actorId, 'key-1')
		expect(found).toEqual({ providerMessageId: 'msg_first' })
	})

	it('the partial UNIQUE index does NOT deduplicate keyless (NULL) sends', async () => {
		await recordAgentEmailSend(db, {
			workspaceId,
			actorId,
			idempotencyKey: null,
			providerMessageId: 'msg_null_1',
		})
		await recordAgentEmailSend(db, {
			workspaceId,
			actorId,
			idempotencyKey: null,
			providerMessageId: 'msg_null_2',
		})
		const rows = await db
			.select()
			.from(agentEmailSends)
			.where(and(eq(agentEmailSends.actorId, actorId)))
		expect(rows.length).toBe(2)
	})

	it('idempotency key is scoped per (workspace, actor): the same string in a different workspace is a distinct send', async () => {
		const otherWs = await insertWorkspace(db, actorId, { name: 'Other workspace' })
		if (!otherWs) throw new Error('other workspace insert returned no row')

		await recordAgentEmailSend(db, {
			workspaceId,
			actorId,
			idempotencyKey: 'shared-key',
			providerMessageId: 'msg_ws1',
		})
		// Same key in a different workspace must NOT collide.
		await recordAgentEmailSend(db, {
			workspaceId: otherWs.id,
			actorId,
			idempotencyKey: 'shared-key',
			providerMessageId: 'msg_ws2',
		})

		expect(await findExistingAgentEmailSend(db, workspaceId, actorId, 'shared-key')).toEqual({
			providerMessageId: 'msg_ws1',
		})
		expect(await findExistingAgentEmailSend(db, otherWs.id, actorId, 'shared-key')).toEqual({
			providerMessageId: 'msg_ws2',
		})
	})
})
