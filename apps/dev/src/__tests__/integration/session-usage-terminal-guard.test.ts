import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
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

const RESULT_ENVELOPE = JSON.stringify({
	type: 'result',
	total_cost_usd: 0.5,
	duration_ms: 5000,
	usage: {
		input_tokens: 1000,
		output_tokens: 2000,
		cache_creation_input_tokens: 0,
		cache_read_input_tokens: 3000,
	},
})

// A usage write that lands after the session row is terminal must not add to
// the cumulative columns. Once the int4 columns are widened, a straggling
// writer would otherwise start accruing cost on a finished session.
describe('SessionManager.accumulateSessionUsage — terminal-state guard (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
	})

	async function accumulate(status: string) {
		const session = await insertSession(db, workspaceId, actorId, actorId, { status })
		await insertSessionLog(db, session.id, {
			stream: 'stdout',
			content: `${RESULT_ENVELOPE}\n`,
		})
		const manager = new SessionManager(db, stubStorage())
		try {
			await (
				manager as unknown as { accumulateSessionUsage(id: string): Promise<unknown> }
			).accumulateSessionUsage(session.id)
		} finally {
			await manager.stop()
		}
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		return row
	}

	it('adds usage to a running session', async () => {
		const row = await accumulate('running')
		expect(row?.inputTokens).toBe(1000)
		expect(row?.outputTokens).toBe(2000)
		expect(row?.cacheReadInputTokens).toBe(3000)
	})

	it('adds usage to a paused session (pause settles before it accumulates)', async () => {
		const row = await accumulate('paused')
		expect(row?.inputTokens).toBe(1000)
	})

	it.each(['completed', 'failed', 'timeout', 'user_stopped'])(
		'leaves a %s session untouched',
		async (status) => {
			const row = await accumulate(status)
			expect(row?.inputTokens).toBeNull()
			expect(row?.outputTokens).toBeNull()
			expect(row?.cacheReadInputTokens).toBeNull()
			expect(row?.totalCostUsd).toBeNull()
			expect(row?.durationMs).toBeNull()
		},
	)
})
