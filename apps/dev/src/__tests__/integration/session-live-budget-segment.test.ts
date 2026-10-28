import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { SessionManager } from '../../services/session-manager'
import { SESSION_RESUMED_LOG } from '../../services/usage-parser'
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

// 200,000 tokens bill as one cent on the legacy rate, so 40M tokens are 200 cents.
const TURN_TOKENS = 40_000_000

// One turn's result line. The CLI reports tokens for the turn alone and
// total_cost_usd as the running total of the process.
function turn(costSoFar: number) {
	return `${JSON.stringify({
		type: 'result',
		subtype: 'success',
		is_error: false,
		result: 'ok',
		duration_ms: 1000,
		total_cost_usd: costSoFar,
		usage: { input_tokens: TURN_TOKENS, output_tokens: 0 },
	})}\n`
}

// The live budget check runs every minute on a running plan session. It must
// count the tokens of the current CLI process once: the segment before a pause
// is already saved on the row, and the check adds the row's saved usage itself.
describe('SessionManager.enforceRunningSessionBudget — live usage (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, {
			settings: { billing: { plan: 'pro', hard_cap_usd_cents: 500 } },
		})
		workspaceId = ws.id
	})

	async function runningSession(overrides: Record<string, unknown> = {}) {
		const session = await insertSession(db, workspaceId, actorId, actorId, {
			status: 'running',
			config: { llm_route: 'maskin_plan' },
			containerId: 'sandbox-live-budget',
			...overrides,
		})
		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		if (!row) throw new Error('no session')
		return row
	}

	async function check(row: typeof sessions.$inferSelect) {
		const manager = new SessionManager(db, stubStorage())
		const stop = vi.spyOn(manager, 'stopSession').mockResolvedValue()
		try {
			await (
				manager as unknown as {
					enforceRunningSessionBudget(s: typeof sessions.$inferSelect): Promise<void>
				}
			).enforceRunningSessionBudget(row)
			return stop
		} finally {
			await manager.stop()
		}
	}

	it('does not count a segment that was saved at pause a second time', async () => {
		// Segment one (200 cents) was saved at pause. Segment two has run 200 cents so far.
		const row = await runningSession({ inputTokens: TURN_TOKENS, totalCostUsd: '2' })
		await insertSessionLog(db, row.id, { content: turn(2) })
		await insertSessionLog(db, row.id, { stream: 'system', content: SESSION_RESUMED_LOG })
		await insertSessionLog(db, row.id, { content: turn(2) })

		// 200 saved + 200 live = 400 cents, under the 500 cent cap.
		expect(await check(row)).not.toHaveBeenCalled()
	})

	it('still stops a session whose current segment goes over the cap', async () => {
		const row = await runningSession({ inputTokens: TURN_TOKENS, totalCostUsd: '2' })
		await insertSessionLog(db, row.id, { stream: 'system', content: SESSION_RESUMED_LOG })
		await insertSessionLog(db, row.id, { content: turn(2) })
		await insertSessionLog(db, row.id, { content: turn(4) })

		// 200 saved + 400 over two turns of the live segment = 600 cents, over the cap.
		expect(await check(row)).toHaveBeenCalledWith(row.id)
	})
})
