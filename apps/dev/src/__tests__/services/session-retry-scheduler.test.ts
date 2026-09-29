import { beforeEach, describe, expect, it, vi } from 'vitest'

import {
	KILLSWITCH_ENV_VAR,
	MAX_RETRY_ATTEMPTS,
	SessionRetryScheduler,
} from '../../services/session-retry-scheduler'

const NOW = new Date('2026-09-29T20:00:00Z')

vi.mock('../../services/session-lifecycle', () => ({
	startSession: vi.fn(async () => ({
		sessionId: 'retry-11111111-1111-1111-1111-111111111111',
		state: 'queued',
		createdAt: new Date(),
	})),
}))

vi.mock('../../lib/logger', () => ({
	logger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}))

vi.mock('../../config/chat-resume', () => ({
	CHAT_RESUME_INTERIM_MESSAGE_ENABLED: true,
}))

import { startSession } from '../../services/session-lifecycle'

interface FakeUpdateBuilder {
	set: (patch: Record<string, unknown>) => FakeUpdateBuilder
	where: (_: unknown) => FakeUpdateBuilder
	returning: () => Promise<Array<{ id: string }>>
}

function buildDueRow(overrides: Partial<Record<string, unknown>> = {}) {
	return {
		id: 'session-00000000-0000-0000-0000-000000000001',
		workspaceId: 'ws-00000000-0000-0000-0000-000000000001',
		actorId: 'actor-00000000-0000-0000-0000-000000000001',
		conversationId: null,
		triggerId: null,
		sourceCommentEventId: null,
		actionPrompt: 'do the thing',
		config: null,
		attemptNumber: 1,
		retryAt: new Date('2026-09-29T19:59:00Z'),
		...overrides,
	}
}

function fakeDb(dueRows: Array<Record<string, unknown>>) {
	const updates: Array<Record<string, unknown>> = []
	const inserts: Array<Record<string, unknown>> = []
	let claimAllowed = true

	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => dueRows,
				}),
			}),
		}),
		update: () => {
			const builder: FakeUpdateBuilder = {
				set(patch) {
					updates.push(patch)
					return builder
				},
				where() {
					return builder
				},
				async returning() {
					return claimAllowed ? [{ id: 'ok' }] : []
				},
			}
			return builder
		},
		insert: () => ({
			values: async (row: Record<string, unknown>) => {
				inserts.push(row)
			},
		}),
	}

	return {
		db,
		updates,
		inserts,
		setClaimAllowed(v: boolean) {
			claimAllowed = v
		},
	}
}

describe('SessionRetryScheduler', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	it('fires startSession with the retry-of + attemptNumber+1', async () => {
		const { db, updates, inserts } = fakeDb([buildDueRow()])
		const scheduler = new SessionRetryScheduler(db as never, {} as NodeJS.ProcessEnv)

		await scheduler.tick(NOW)

		expect(startSession).toHaveBeenCalledTimes(1)
		const call = vi.mocked(startSession).mock.calls[0][0]
		expect(call.retryOf).toBe('session-00000000-0000-0000-0000-000000000001')
		expect(call.attemptNumber).toBe(2)
		expect(call.callerKind).toBe('internal')

		// CAS-clear retry_at + link retried_session_id both happened
		expect(updates.some((u) => 'retryAt' in u && u.retryAt === null)).toBe(true)
		expect(updates.some((u) => 'retriedSessionId' in u)).toBe(true)

		// telemetry event emitted
		expect(inserts.some((r) => r.action === 'session_retry_scheduled')).toBe(true)
	})

	it('caps at MAX_RETRY_ATTEMPTS and emits session_retry_capped', async () => {
		const { db, inserts } = fakeDb([buildDueRow({ attemptNumber: MAX_RETRY_ATTEMPTS })])
		const scheduler = new SessionRetryScheduler(db as never, {} as NodeJS.ProcessEnv)

		await scheduler.tick(NOW)

		expect(startSession).not.toHaveBeenCalled()
		expect(inserts.some((r) => r.action === 'session_retry_capped')).toBe(true)
	})

	it('honours the FEATURE_RETRY_SCHEDULER=0 killswitch', async () => {
		const { db } = fakeDb([buildDueRow()])
		const scheduler = new SessionRetryScheduler(db as never, {
			[KILLSWITCH_ENV_VAR]: '0',
		} as NodeJS.ProcessEnv)

		await scheduler.tick(NOW)

		expect(startSession).not.toHaveBeenCalled()
	})

	it('emits chat_resume_interim_posted when the session had a conversationId', async () => {
		const { db, inserts } = fakeDb([
			buildDueRow({ conversationId: 'conv-00000000-0000-0000-0000-000000000001' }),
		])
		const scheduler = new SessionRetryScheduler(db as never, {} as NodeJS.ProcessEnv)

		await scheduler.tick(NOW)

		expect(inserts.some((r) => r.action === 'chat_resume_interim_posted')).toBe(true)
	})

	it('does not emit chat_resume_interim_posted for a triggered (non-chat) session', async () => {
		const { db, inserts } = fakeDb([
			buildDueRow({ triggerId: 'trig-00000000-0000-0000-0000-000000000001' }),
		])
		const scheduler = new SessionRetryScheduler(db as never, {} as NodeJS.ProcessEnv)

		await scheduler.tick(NOW)

		expect(inserts.some((r) => r.action === 'chat_resume_interim_posted')).toBe(false)
	})
})
