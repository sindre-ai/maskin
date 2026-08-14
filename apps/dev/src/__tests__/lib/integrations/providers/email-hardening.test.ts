import type { Database } from '@maskin/db'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	checkAgentEmailRateLimit,
	findExistingAgentEmailSend,
	isUniqueViolation,
	readAgentEmailRateLimitPerHour,
	recordAgentEmailSend,
} from '../../../../lib/integrations/providers/email/hardening'

function selectDb(row: { count: number; oldest: Date | null } | null): Database {
	// checkAgentEmailRateLimit awaits `db.select().from().where()` directly
	// (no `.limit()` in the chain), so `.where()` must resolve to the rows.
	const rows = row === null ? [] : [row]
	const where = vi.fn().mockResolvedValue(rows)
	const from = vi.fn().mockReturnValue({ where })
	const select = vi.fn().mockReturnValue({ from })
	return { select } as unknown as Database
}

function throwingSelectDb(err: unknown): Database {
	const from = vi.fn().mockImplementation(() => {
		throw err
	})
	const select = vi.fn().mockReturnValue({ from })
	return { select } as unknown as Database
}

describe('readAgentEmailRateLimitPerHour', () => {
	it('returns the default when the env var is unset', () => {
		expect(readAgentEmailRateLimitPerHour({})).toBe(10)
	})

	it('returns the parsed value when set to a positive integer', () => {
		expect(readAgentEmailRateLimitPerHour({ AGENT_EMAIL_RATE_LIMIT_PER_HOUR: '25' })).toBe(25)
	})

	it('falls back to the default for a non-numeric value', () => {
		expect(readAgentEmailRateLimitPerHour({ AGENT_EMAIL_RATE_LIMIT_PER_HOUR: 'unlimited' })).toBe(
			10,
		)
	})

	it('falls back to the default for zero or negative values', () => {
		expect(readAgentEmailRateLimitPerHour({ AGENT_EMAIL_RATE_LIMIT_PER_HOUR: '0' })).toBe(10)
		expect(readAgentEmailRateLimitPerHour({ AGENT_EMAIL_RATE_LIMIT_PER_HOUR: '-5' })).toBe(10)
	})

	it('falls back to the default for implausibly large values (sanity ceiling)', () => {
		expect(readAgentEmailRateLimitPerHour({ AGENT_EMAIL_RATE_LIMIT_PER_HOUR: '999999' })).toBe(10)
	})

	it('floors a fractional value rather than passing NaN downstream', () => {
		expect(readAgentEmailRateLimitPerHour({ AGENT_EMAIL_RATE_LIMIT_PER_HOUR: '3.9' })).toBe(3)
	})
})

describe('checkAgentEmailRateLimit', () => {
	const NOW = new Date('2026-08-13T20:00:00.000Z')

	it('allows the send when the actor is under the ceiling', async () => {
		const db = selectDb({ count: 3, oldest: new Date(NOW.getTime() - 30 * 60 * 1000) })
		const result = await checkAgentEmailRateLimit(db, 'actor-1', { now: NOW, limitPerHour: 10 })
		expect(result).toEqual({ ok: true, limit: 10, used: 3 })
	})

	it('blocks the send when the ceiling has been reached', async () => {
		const oldest = new Date(NOW.getTime() - 40 * 60 * 1000)
		const db = selectDb({ count: 10, oldest })
		const result = await checkAgentEmailRateLimit(db, 'actor-1', { now: NOW, limitPerHour: 10 })
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected block')
		expect(result.error).toBe('rate_limit_exceeded')
		expect(result.limit).toBe(10)
		expect(result.used).toBe(10)
		// Oldest at NOW-40min → next free is 20min from now → ~1200s.
		expect(result.retryAfterSeconds).toBeGreaterThanOrEqual(1199)
		expect(result.retryAfterSeconds).toBeLessThanOrEqual(1201)
	})

	it('fails closed when the DB errors: no send counts as blocked', async () => {
		const db = throwingSelectDb(new Error('connection refused'))
		const result = await checkAgentEmailRateLimit(db, 'actor-1', { now: NOW, limitPerHour: 10 })
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected block')
		expect(result.error).toBe('rate_limit_exceeded')
		expect(result.retryAfterSeconds).toBeGreaterThan(0)
	})

	it('falls back to a full-window retry hint when no oldest is available', async () => {
		const db = selectDb({ count: 10, oldest: null })
		const result = await checkAgentEmailRateLimit(db, 'actor-1', { now: NOW, limitPerHour: 10 })
		expect(result.ok).toBe(false)
		if (result.ok) throw new Error('expected block')
		expect(result.retryAfterSeconds).toBe(60 * 60)
	})

	it('reads the env-configured ceiling when limitPerHour is not passed', async () => {
		const previous = process.env.AGENT_EMAIL_RATE_LIMIT_PER_HOUR
		process.env.AGENT_EMAIL_RATE_LIMIT_PER_HOUR = '2'
		try {
			const db = selectDb({ count: 2, oldest: new Date(NOW.getTime() - 10 * 60 * 1000) })
			const result = await checkAgentEmailRateLimit(db, 'actor-1', { now: NOW })
			expect(result.ok).toBe(false)
			if (result.ok) throw new Error('expected block')
			expect(result.limit).toBe(2)
		} finally {
			if (previous === undefined)
				Reflect.deleteProperty(process.env, 'AGENT_EMAIL_RATE_LIMIT_PER_HOUR')
			else process.env.AGENT_EMAIL_RATE_LIMIT_PER_HOUR = previous
		}
	})
})

describe('findExistingAgentEmailSend', () => {
	function findDb(row: { providerMessageId: string } | null): Database {
		const limit = vi.fn().mockResolvedValue(row === null ? [] : [row])
		const where = vi.fn().mockReturnValue({ limit })
		const from = vi.fn().mockReturnValue({ where })
		const select = vi.fn().mockReturnValue({ from })
		return { select } as unknown as Database
	}

	it('returns null when no prior send matches the key', async () => {
		const db = findDb(null)
		const result = await findExistingAgentEmailSend(db, 'ws-1', 'actor-1', 'key-a')
		expect(result).toBeNull()
	})

	it('returns the prior provider message id when a match exists', async () => {
		const db = findDb({ providerMessageId: 'msg_prior' })
		const result = await findExistingAgentEmailSend(db, 'ws-1', 'actor-1', 'key-a')
		expect(result).toEqual({ providerMessageId: 'msg_prior' })
	})
})

describe('recordAgentEmailSend', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('inserts a row with all fields populated', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const insert = vi.fn().mockReturnValue({ values })
		const db = { insert } as unknown as Database

		await recordAgentEmailSend(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			idempotencyKey: 'key-a',
			providerMessageId: 'msg_1',
		})

		expect(values).toHaveBeenCalledWith({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			idempotencyKey: 'key-a',
			providerMessageId: 'msg_1',
		})
	})

	it('accepts a null idempotencyKey for keyless sends', async () => {
		const values = vi.fn().mockResolvedValue(undefined)
		const insert = vi.fn().mockReturnValue({ values })
		const db = { insert } as unknown as Database

		await recordAgentEmailSend(db, {
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			idempotencyKey: null,
			providerMessageId: 'msg_2',
		})

		expect(values).toHaveBeenCalledWith(
			expect.objectContaining({ idempotencyKey: null, providerMessageId: 'msg_2' }),
		)
	})
})

describe('isUniqueViolation', () => {
	it('matches Postgres 23505', () => {
		expect(isUniqueViolation({ code: '23505' })).toBe(true)
	})

	it('rejects other error shapes', () => {
		expect(isUniqueViolation({ code: '23503' })).toBe(false)
		expect(isUniqueViolation(new Error('boom'))).toBe(false)
		expect(isUniqueViolation(null)).toBe(false)
		expect(isUniqueViolation(undefined)).toBe(false)
	})
})
