import { sessions } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { resetPlanLimitEventsForTest } from '../../lib/analytics/plan-limit-events'
import { PlanCapExceededError, checkPlanCap } from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { SessionManager } from '../../services/session-manager'
import { SESSION_RESUMED_LOG } from '../../services/usage-parser'
import { insertSession, insertSessionLog, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn(async () => {}),
}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: capturePosthogEventMock }))

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
		capturePosthogEventMock.mockClear()
		resetPlanLimitEventsForTest()
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

	// The mid-run stop used to cover only Pro and Team. Every plan the Maskin-funded route
	// serves has the same 100% rule as the start check.
	it.each(['trial', 'starter', 'ultra'])(
		'stops a %s workspace that goes over its cap',
		async (plan) => {
			const ws = await insertWorkspace(db, actorId, {
				settings: { billing: { plan, hard_cap_usd_cents: 300 } },
			})
			workspaceId = ws.id
			const row = await runningSession()
			// Two turns of 200 cents each: 400, over the 300 cent cap.
			await insertSessionLog(db, row.id, { content: turn(2) })
			await insertSessionLog(db, row.id, { content: turn(4) })

			expect(await check(row)).toHaveBeenCalledWith(row.id)
		},
	)

	it('stops a workspace with no billing block (a trial) at the trial cap', async () => {
		const ws = await insertWorkspace(db, actorId, { settings: {} })
		workspaceId = ws.id
		const row = await runningSession()
		// 40M tokens are 200 cents on the legacy rate, 3 turns are 600: over the 286 cent trial cap.
		await insertSessionLog(db, row.id, { content: turn(2) })
		await insertSessionLog(db, row.id, { content: turn(4) })
		await insertSessionLog(db, row.id, { content: turn(6) })

		expect(await check(row)).toHaveBeenCalledWith(row.id)
	})

	it('keeps a session running while a credit balance covers the overage', async () => {
		const ws = await insertWorkspace(db, actorId, {
			settings: { billing: { plan: 'trial', hard_cap_usd_cents: 300, credit_balance_cents: 5000 } },
		})
		workspaceId = ws.id
		const row = await runningSession()
		// Two turns of 200 cents each: 400, over the 300 cent cap.
		await insertSessionLog(db, row.id, { content: turn(2) })
		await insertSessionLog(db, row.id, { content: turn(4) })

		expect(await check(row)).not.toHaveBeenCalled()
	})

	// A refused start and a mid-run stop in the same period are one event, also when the
	// workspace has a period start but no period end (both derive the same end).
	it('sends plan_limit_reached once for a refused start and a stop in one period', async () => {
		const settings: WorkspaceSettings = {
			billing: {
				plan: 'starter',
				hard_cap_usd_cents: 300,
				period_start: Math.floor(Date.now() / 1000) - 3600,
			},
		}
		const ws = await insertWorkspace(db, actorId, { settings })
		workspaceId = ws.id
		const row = await runningSession()
		await insertSessionLog(db, row.id, { content: turn(2) })
		await insertSessionLog(db, row.id, { content: turn(4) })

		expect(await check(row)).toHaveBeenCalledWith(row.id)
		// The refused start finds the same session usage (400 cents) over the cap.
		await expect(
			checkPlanCap({ db, workspaceId, wsSettings: settings, enterprise: false }),
		).rejects.toBeInstanceOf(PlanCapExceededError)

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
	})
})
