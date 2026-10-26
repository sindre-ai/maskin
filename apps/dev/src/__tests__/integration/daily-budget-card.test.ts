/**
 * Morning budget card scheduler against real Postgres.
 * Proves the DB semantics it depends on: the per-workspace day claim (two replicas send ONE
 * card per owner), a deleted card is not sent again, the next local day sends again, and a
 * workspace with no target gets nothing.
 */
import { events, notifications } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { and, eq, sql } from 'drizzle-orm'
import { DailyBudgetCardScheduler } from '../../services/daily-budget-card-scheduler'
import {
	ensureWorkspaceMember,
	insertActor,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

// 00:30 on 10 March in Oslo (CET, UTC+1), so yesterday is 9 March local.
const day1 = new Date('2026-03-09T23:30:00Z')
const day2 = new Date('2026-03-10T23:30:00Z')
const yesterdayNoon = new Date('2026-03-09T11:00:00Z')

async function setup(settings: Record<string, unknown> | null) {
	const owner = await insertActor(db, { type: 'human' })
	const ownerId = owner?.id as string
	const ws = await insertWorkspace(db, ownerId, settings ? { settings } : undefined)
	const workspaceId = ws?.id as string
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
	const agentId = agent?.id as string
	await ensureWorkspaceMember(db, workspaceId, agentId)
	return { ownerId, workspaceId, agentId }
}

const target = { unit: 'usd', amount: 10, stop_at_share: 100, timezone: 'Europe/Oslo' }

async function cards(workspaceId: string) {
	return db
		.select()
		.from(notifications)
		.where(
			and(
				eq(notifications.workspaceId, workspaceId),
				sql`${notifications.metadata}->>'source' = 'daily_budget_card'`,
			),
		)
}

describe('daily budget card scheduler', () => {
	it('writes one For You card per owner at the day start, and not again the same day', async () => {
		const { ownerId, workspaceId, agentId } = await setup({ daily_budget: target })
		const trigger = await insertTrigger(db, workspaceId, ownerId, agentId, {
			name: 'Nightly draft',
		})
		for (const cost of ['2.000000', '2.000000']) {
			await insertSession(db, workspaceId, agentId, ownerId, {
				status: 'completed',
				triggerId: trigger?.id,
				totalCostUsd: cost,
				createdAt: yesterdayNoon,
			})
		}
		await insertSession(db, workspaceId, agentId, ownerId, {
			status: 'completed',
			totalCostUsd: null,
			createdAt: yesterdayNoon,
		})

		const a = new DailyBudgetCardScheduler(db)
		const b = new DailyBudgetCardScheduler(db)
		await Promise.all([a.tick(day1), b.tick(day1)])

		const rows = await cards(workspaceId)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			type: 'needs_input',
			status: 'pending',
			targetActorId: ownerId,
			sourceActorId: agentId,
			objectId: null,
			title: 'Yesterday: 3 runs, $4.00 (cost unknown for 1).',
		})
		expect(rows[0]?.metadata).toMatchObject({
			kind: FOR_YOU_KIND,
			push_category: 'digest',
			budget_date: '2026-03-10',
		})
		expect(rows[0]?.metadata).not.toHaveProperty('push_force')
		// 2 runs in 14 days at $2 each, projected over the 31 days of March.
		expect(rows[0]?.content).toContain('Today: ░░░░░░░░░░ $0.00 of $10.00 so far.')
		expect(rows[0]?.content).toContain('Month forecast (approximate): $8.86 of $310.00 (3%).')
		expect(rows[0]?.content).toContain('Heaviest triggers:')
		expect(rows[0]?.content).toContain('- Nightly draft: $8.86')
		expect(rows[0]?.content).toContain('- Not started by a trigger: Estimate unknown')

		// A fresh process (empty memory) a minute later still finds the day taken.
		await new DailyBudgetCardScheduler(db).tick(new Date(day1.getTime() + 60_000))
		expect(await cards(workspaceId)).toHaveLength(1)
	})

	it('does not send a card someone deleted again, and sends again the next local day', async () => {
		const { workspaceId } = await setup({ daily_budget: target })
		await new DailyBudgetCardScheduler(db).tick(day1)
		const [first] = await cards(workspaceId)
		await db.delete(notifications).where(eq(notifications.id, first?.id as string))

		await new DailyBudgetCardScheduler(db).tick(new Date(day1.getTime() + 60_000))
		expect(await cards(workspaceId)).toHaveLength(0)

		await new DailyBudgetCardScheduler(db).tick(day2)
		const next = await cards(workspaceId)
		expect(next).toHaveLength(1)
		expect(next[0]?.metadata).toMatchObject({ budget_date: '2026-03-11' })
	})

	it('says Estimate unknown, never zero, when nothing has a recorded cost', async () => {
		const { ownerId, workspaceId, agentId } = await setup({ daily_budget: target })
		await insertSession(db, workspaceId, agentId, ownerId, {
			status: 'completed',
			totalCostUsd: '0',
			createdAt: yesterdayNoon,
		})
		await new DailyBudgetCardScheduler(db).tick(day1)
		const [row] = await cards(workspaceId)
		expect(row?.title).toBe('Yesterday: 1 run. Estimate unknown.')
		expect(row?.content).toContain('Month forecast (approximate): Estimate unknown')
	})

	it('sends nothing without a target, without a timezone, or outside the day start', async () => {
		const none = await setup(null)
		const noTimezone = await setup({ daily_budget: { unit: 'usd', amount: 10 } })
		const outside = await setup({ daily_budget: target })
		await new DailyBudgetCardScheduler(db).tick(day1)
		// 05:30 local: the three hour catch-up window after the day start is over.
		await new DailyBudgetCardScheduler(db).tick(new Date('2026-03-10T04:30:00Z'))

		expect(await cards(none.workspaceId)).toHaveLength(0)
		expect(await cards(noTimezone.workspaceId)).toHaveLength(0)
		// Only the day1 tick sent to the valid workspace; the late tick added nothing.
		expect(await cards(outside.workspaceId)).toHaveLength(1)
	})

	it('records the card in the audit events that carry the claim', async () => {
		const { workspaceId } = await setup({ daily_budget: target })
		await new DailyBudgetCardScheduler(db).tick(day1)
		const created = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, workspaceId),
					eq(events.entityType, 'notification'),
					eq(events.action, 'created'),
				),
			)
		expect(created).toHaveLength(1)
		// Guards the claim query: it reads this shape.
		expect(created[0]?.data).toMatchObject({ metadata: { source: 'daily_budget_card' } })
	})
})
