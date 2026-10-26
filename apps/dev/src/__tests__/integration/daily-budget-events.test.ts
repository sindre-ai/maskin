import { events, workspaces } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	DAILY_BUDGET_SUMMARY_ACTION,
	DailyBudgetSummaryScheduler,
	SESSION_ADMISSION_ACTION,
	median,
	writeDailySummary,
} from '../../services/daily-budget-events'
import { configureSessionLifecycle, startSession } from '../../services/session-lifecycle'
import type { SessionManager } from '../../services/session-manager'
import { ensureWorkspaceMember, insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Daily budget 1a: the admission event written by startSession() and the once-a-day summary event.
// Real Postgres: the once-per-day claim is an advisory lock plus an existence check, which only a
// real database can show holding under concurrent callers.

const NOW = new Date('2026-10-26T00:05:00.000Z')
const YESTERDAY = '2026-10-25'
const YESTERDAY_NOON = new Date('2026-10-25T12:00:00.000Z')

describe('daily budget events (Integration)', () => {
	let workspaceId: string
	let agentId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		await ensureWorkspaceMember(db, workspaceId, agentId)
	})

	async function summaries() {
		return db
			.select()
			.from(events)
			.where(
				and(eq(events.workspaceId, workspaceId), eq(events.action, DAILY_BUDGET_SUMMARY_ACTION)),
			)
	}

	async function finishedSession(overrides: Record<string, unknown>) {
		return insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'completed',
			completedAt: YESTERDAY_NOON,
			...overrides,
		})
	}

	describe('session_admission', () => {
		// A stand-in for SessionManager.createSession(): inserts the real row, like the real one does.
		function configureLifecycle() {
			const createSession = vi.fn(() =>
				insertSession(db, workspaceId, agentId, getTestActorId(), { status: 'pending' }),
			)
			const sessionManager = { createSession } as unknown as SessionManager
			configureSessionLifecycle({ db, sessionManager })
		}

		async function admissionFor(sessionId: string) {
			return db
				.select()
				.from(events)
				.where(and(eq(events.entityId, sessionId), eq(events.action, SESSION_ADMISSION_ACTION)))
		}

		it('writes one admitted event per start, normal priority, estimate unknown without history', async () => {
			configureLifecycle()
			const handle = await startSession({
				workspaceId,
				actorId: agentId,
				callerKind: 'internal',
				initiatedFromObjectId: null,
			})
			const rows = await admissionFor(handle.sessionId)
			expect(rows).toHaveLength(1)
			expect(rows[0]?.data).toMatchObject({
				decision: 'admitted',
				priority: 'normal',
				estimated_cost_usd: null,
				caller_kind: 'internal',
			})
		})

		it('marks chat starts urgent and estimates cost from the median of earlier runs', async () => {
			for (const cost of ['1.00', '3.00', '2.00']) {
				await finishedSession({ totalCostUsd: cost })
			}

			configureLifecycle()
			const handle = await startSession({
				workspaceId,
				actorId: agentId,
				callerKind: 'chat',
				initiatedFromObjectId: null,
			})
			const [row] = await admissionFor(handle.sessionId)
			const data = row?.data as { priority: string; estimated_cost_usd: number }
			expect(data.priority).toBe('urgent')
			// The three earlier runs share the agent and a null trigger: median of 1, 2, 3.
			expect(data.estimated_cost_usd).toBe(2)
		})
	})

	describe('daily_budget_summary', () => {
		it('writes yesterday once for a workspace that ran something, and not again on the next tick', async () => {
			await finishedSession({
				totalCostUsd: '1.500000',
				inputTokens: 1000,
				outputTokens: 500,
				cacheCreationInputTokens: 100,
				cacheReadInputTokens: 9000,
			})
			await finishedSession({ totalCostUsd: '0.500000', inputTokens: 200, outputTokens: 100 })
			// Completed today: belongs to the next summary.
			await finishedSession({
				totalCostUsd: '9',
				completedAt: new Date('2026-10-26T00:01:00.000Z'),
			})

			const scheduler = new DailyBudgetSummaryScheduler(db)
			expect(await scheduler.tick(NOW)).toBeGreaterThanOrEqual(1)
			expect(await scheduler.tick(new Date(NOW.getTime() + 10 * 60_000))).toBe(0)

			const rows = await summaries()
			expect(rows).toHaveLength(1)
			expect(rows[0]?.entityId).toBe(workspaceId)
			expect(rows[0]?.data).toMatchObject({
				day: YESTERDAY,
				target: null,
				unit: null,
				spent: null,
				deferred: 0,
				spent_usd: 2,
				spent_tokens: 1900,
				cache_read_tokens: 9000,
				sessions: 2,
			})
		})

		it('does not write twice when a fresh scheduler (a restart or a second replica) runs the same day', async () => {
			await finishedSession({ totalCostUsd: '1' })
			await new DailyBudgetSummaryScheduler(db).tick(NOW)
			await new DailyBudgetSummaryScheduler(db).tick(NOW)
			expect(await summaries()).toHaveLength(1)
		})

		it('writes once when two callers claim the same day at the same moment', async () => {
			await finishedSession({ totalCostUsd: '1' })
			const results = await Promise.all([
				writeDailySummary(db, workspaceId, YESTERDAY),
				writeDailySummary(db, workspaceId, YESTERDAY),
				writeDailySummary(db, workspaceId, YESTERDAY),
			])
			expect(results.filter(Boolean)).toHaveLength(1)
			expect(await summaries()).toHaveLength(1)
		})

		it('reports spent in the unit of the workspace target', async () => {
			await db
				.update(workspaces)
				.set({ settings: { daily_budget: { unit: 'tokens', amount: 2000 } } })
				.where(eq(workspaces.id, workspaceId))
			await finishedSession({ totalCostUsd: '4', inputTokens: 1000, outputTokens: 500 })

			await writeDailySummary(db, workspaceId, YESTERDAY)
			const [row] = await summaries()
			expect(row?.data).toMatchObject({ target: 2000, unit: 'tokens', spent: 1500, spent_usd: 4 })
		})

		it('counts deferred admissions of the day', async () => {
			await finishedSession({ totalCostUsd: '1' })
			await db.insert(events).values([
				{
					workspaceId,
					actorId: agentId,
					action: SESSION_ADMISSION_ACTION,
					entityType: 'session',
					entityId: agentId,
					data: { decision: 'deferred' },
					createdAt: YESTERDAY_NOON,
				},
				{
					workspaceId,
					actorId: agentId,
					action: SESSION_ADMISSION_ACTION,
					entityType: 'session',
					entityId: agentId,
					data: { decision: 'admitted' },
					createdAt: YESTERDAY_NOON,
				},
			])
			await writeDailySummary(db, workspaceId, YESTERDAY)
			const [row] = await summaries()
			expect(row?.data).toMatchObject({ deferred: 1 })
		})

		it('writes nothing for a workspace with no sessions and no target', async () => {
			await new DailyBudgetSummaryScheduler(db).tick(NOW)
			expect(await summaries()).toHaveLength(0)
		})

		it('writes a zero-spend summary for a workspace that has a target but ran nothing', async () => {
			await db
				.update(workspaces)
				.set({ settings: { daily_budget: { unit: 'usd', amount: 20 } } })
				.where(eq(workspaces.id, workspaceId))
			await new DailyBudgetSummaryScheduler(db).tick(NOW)
			const [row] = await summaries()
			expect(row?.data).toMatchObject({ target: 20, unit: 'usd', spent: 0, sessions: 0 })
		})
	})

	describe('median', () => {
		it('handles empty, odd and even lists', () => {
			expect(median([])).toBeNull()
			expect(median([5])).toBe(5)
			expect(median([3, 1, 2])).toBe(2)
			expect(median([4, 1, 2, 3])).toBe(2.5)
		})
	})
})
