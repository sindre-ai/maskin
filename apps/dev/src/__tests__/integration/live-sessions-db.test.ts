import { liveSessions, workspaceMembers, workspaces } from '@maskin/db/schema'
import { workspaceSettingsSchema } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { PlanCapExceededError, checkPlanCap } from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const PERIOD_START_SEC = 1_700_000_000
const CAP_CENTS = 1_000

const billing = (): WorkspaceSettings =>
	({
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: CAP_CENTS,
			period_start: PERIOD_START_SEC,
			stripe_customer_id: 'cus_test',
			credit_balance_cents: 0,
		},
	}) as WorkspaceSettings

async function liveRow(
	workspaceId: string,
	humanId: string,
	agentId: string,
	overrides: Partial<typeof liveSessions.$inferInsert> = {},
) {
	const [row] = await db
		.insert(liveSessions)
		.values({
			workspaceId,
			agentActorId: agentId,
			humanActorId: humanId,
			status: 'pending',
			inputMode: 'audio',
			timeoutAt: new Date(Date.now() + 15 * 60_000),
			...overrides,
		})
		.returning()
	return row
}

describe('live_sessions (Integration)', () => {
	let workspaceId: string
	let humanId: string
	let agentId: string

	beforeEach(async () => {
		humanId = getTestActorId()
		const ws = await insertWorkspace(db, humanId, { enterpriseGranted: false })
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
	})

	it('applies column defaults for a freshly minted row', async () => {
		const row = await liveRow(workspaceId, humanId, agentId)
		expect(row.provider).toBe('openrouter')
		expect(row.turnCount).toBe(0)
		expect(Number(row.totalCostUsd)).toBe(0)
		expect(row.endedAt).toBeNull()
	})

	it('allows only one live call per human, and a new one after the first ends', async () => {
		const first = await liveRow(workspaceId, humanId, agentId)
		await expect(liveRow(workspaceId, humanId, agentId)).rejects.toMatchObject({
			cause: { code: '23505' },
		})
		await db
			.update(liveSessions)
			.set({ status: 'ended', endedAt: new Date() })
			.where(eq(liveSessions.id, first.id))
		const second = await liveRow(workspaceId, humanId, agentId)
		expect(second.id).not.toBe(first.id)
	})

	it('lets two different humans be live at the same time', async () => {
		const other = await insertActor(db, { type: 'human' })
		await liveRow(workspaceId, humanId, agentId)
		await expect(liveRow(workspaceId, other.id, agentId)).resolves.toBeTruthy()
	})

	it('rejects an input_mode outside text and audio', async () => {
		await expect(
			liveRow(workspaceId, humanId, agentId, { inputMode: 'video' }),
		).rejects.toBeTruthy()
	})

	it('cascades when the workspace is deleted', async () => {
		const row = await liveRow(workspaceId, humanId, agentId)
		// workspace_members does not cascade, so it goes first.
		await db.delete(workspaceMembers).where(eq(workspaceMembers.workspaceId, workspaceId))
		await db.delete(workspaces).where(eq(workspaces.id, workspaceId))
		const left = await db.select().from(liveSessions).where(eq(liveSessions.id, row.id))
		expect(left).toHaveLength(0)
	})

	describe('plan cap', () => {
		it('counts maskin_plan live spend toward the cap', async () => {
			await liveRow(workspaceId, humanId, agentId, {
				status: 'ended',
				llmRoute: 'maskin_plan',
				totalCostUsd: '20.000000',
				startedAt: new Date(PERIOD_START_SEC * 1000 + 1000),
			})
			await expect(
				checkPlanCap({ db, workspaceId, wsSettings: billing(), enterprise: false }),
			).rejects.toThrow(PlanCapExceededError)
		})

		it('ignores live spend on a workspace-owned route', async () => {
			await liveRow(workspaceId, humanId, agentId, {
				status: 'ended',
				llmRoute: 'workspace_openrouter_key',
				totalCostUsd: '20.000000',
				startedAt: new Date(PERIOD_START_SEC * 1000 + 1000),
			})
			await expect(
				checkPlanCap({ db, workspaceId, wsSettings: billing(), enterprise: false }),
			).resolves.toBeUndefined()
		})

		it('ignores live spend from before the billing period', async () => {
			await liveRow(workspaceId, humanId, agentId, {
				status: 'ended',
				llmRoute: 'maskin_plan',
				totalCostUsd: '20.000000',
				startedAt: new Date(PERIOD_START_SEC * 1000 - 86_400_000),
			})
			await expect(
				checkPlanCap({ db, workspaceId, wsSettings: billing(), enterprise: false }),
			).resolves.toBeUndefined()
		})
	})

	describe('workspace settings schema', () => {
		it('keeps stored llm_keys.openrouter and live settings parseable', async () => {
			const settings = {
				llm_keys: { openrouter: 'sk-or-test' },
				live: { persist_transcripts: false, daily_minutes_cap: 30 },
			}
			await db.update(workspaces).set({ settings }).where(eq(workspaces.id, workspaceId))
			const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
			expect(workspaceSettingsSchema.partial().safeParse(row.settings).success).toBe(true)
		})
	})
})
