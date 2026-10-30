import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { afterEach, vi } from 'vitest'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertWorkspace } from '../factories'
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

// The text the CLI returned to the 26 Oct 2026 12:00 UTC cluster of helper and cron sessions.
const WEEKLY_LIMIT = "You've hit your weekly limit · resets 9pm (Europe/Copenhagen)"

// A helper that stops on the Claude limit used to settle as failed with no reset time,
// so sessions.retry_at stayed empty and the retry scheduler had nothing to fire.
describe('A helper that hits the Claude limit is stored with a retry time (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	afterEach(() => {
		vi.useRealTimers()
	})

	function helper() {
		return insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			interactive: true,
			conversationId: null,
			config: { interactive: true, stop_on_result: true },
		})
	}

	async function finish(sessionId: string, outcome: { isError: boolean; text: string }) {
		const manager = new SessionManager(db, stubStorage())
		try {
			await manager.finishHelperSession(sessionId, outcome)
		} finally {
			await manager.stop()
		}
		const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId))
		return row
	}

	it('stores the failure reason and the reset time for the weekly limit text', async () => {
		// Copenhagen is UTC+1 from 25 Oct, so 9pm there is 20:00 UTC the same day.
		vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-26T12:00:00Z') })
		const session = await helper()
		if (!session) throw new Error('no session')

		const row = await finish(session.id, { isError: true, text: WEEKLY_LIMIT })

		expect(row?.status).toBe('failed')
		expect(row?.retryAt?.toISOString()).toBe('2026-10-26T20:00:00.000Z')
		const failure = (row?.result as { failure_reason?: Record<string, unknown> } | null)
			?.failure_reason
		expect(failure?.reason_code).toBe('weekly_limit')
		expect(failure?.provider).toBe('anthropic')
	})

	it.each([
		['oauth_expired', 'Failed to authenticate: OAuth session expired and could not be refreshed'],
		['invalid_api_key', 'Invalid API key · Fix external API key'],
	])('stores %s as an auth failure with no retry time', async (code, text) => {
		const session = await helper()
		if (!session) throw new Error('no session')

		const row = await finish(session.id, { isError: true, text })

		expect(row?.status).toBe('failed')
		expect(row?.retryAt).toBeNull()
		const failure = (row?.result as { failure_reason?: Record<string, unknown> } | null)
			?.failure_reason
		expect(failure?.reason_code).toBe(code)
		expect(failure?.provider).toBe('anthropic')
		expect(failure?.reset_at).toBeNull()
	})

	it('does not name an auth failure when the helper returned a result', async () => {
		const session = await helper()
		if (!session) throw new Error('no session')

		const row = await finish(session.id, { isError: false, text: 'Invalid API key' })

		expect(row?.status).toBe('completed')
		const result = row?.result as { failure_reason?: unknown } | null
		expect(result?.failure_reason).toBeUndefined()
	})

	it('leaves any other helper failure without a failure reason or retry time', async () => {
		const session = await helper()
		if (!session) throw new Error('no session')

		const row = await finish(session.id, { isError: true, text: 'The tool call timed out' })

		expect(row?.status).toBe('failed')
		expect(row?.retryAt).toBeNull()
		const result = row?.result as { failure_reason?: unknown } | null
		expect(result?.failure_reason).toBeUndefined()
	})

	it('leaves a helper that returned a result unchanged, even if the text quotes the limit', async () => {
		const session = await helper()
		if (!session) throw new Error('no session')

		const row = await finish(session.id, { isError: false, text: WEEKLY_LIMIT })

		expect(row?.status).toBe('completed')
		expect(row?.retryAt).toBeNull()
		const result = row?.result as { failure_reason?: unknown } | null
		expect(result?.failure_reason).toBeUndefined()
	})
})
