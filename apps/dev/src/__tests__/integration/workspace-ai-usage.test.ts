import { files, workspaceAiUsage, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { readUsageBreakdown } from '../../lib/billing-usage-breakdown'
import { debitCreditForSession } from '../../lib/credit-billing'
import {
	PlanCapExceededError,
	checkPlanCap,
	getWorkspacePlanUsdCentsUsage,
} from '../../lib/llm-routing'
import type { WorkspaceSettings } from '../../lib/types'
import { buildFile, insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const PERIOD_START_SEC = 1_700_000_000
const PERIOD_START_MS = PERIOD_START_SEC * 1000
const IN_PERIOD = new Date(PERIOD_START_MS + 60_000)
const BEFORE_PERIOD = new Date(PERIOD_START_MS - 60_000)
// $10.00 included per period.
const CAP_CENTS = 1_000
const MODEL = 'mistralai/voxtral-small-transcribe-3-0'

function billingSettings(creditBalanceCents = 0): WorkspaceSettings {
	return {
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: CAP_CENTS,
			period_start: PERIOD_START_SEC,
			stripe_customer_id: 'cus_test',
			credit_balance_cents: creditBalanceCents,
		},
	} as WorkspaceSettings
}

describe('workspace_ai_usage (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		// The factory grants enterprise by default, which is not metered at all.
		const ws = await insertWorkspace(db, actorId, {
			enterpriseGranted: false,
			settings: billingSettings(5_000),
		})
		workspaceId = ws.id
	})

	async function seedUsage(overrides: Record<string, unknown> = {}, forWorkspace = workspaceId) {
		const [row] = await db
			.insert(workspaceAiUsage)
			.values({
				workspaceId: forWorkspace,
				actorId,
				kind: 'transcription',
				model: MODEL,
				costUsd: '0.500000',
				audioSeconds: '180.00',
				createdAt: IN_PERIOD,
				...overrides,
			})
			.returning()
		if (!row) throw new Error('usage insert failed')
		return row
	}

	function seedSession(totalCostUsd: string) {
		return insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd,
			inputTokens: 0,
			outputTokens: 0,
			createdAt: IN_PERIOD,
		})
	}

	describe('plan usage', () => {
		it('adds transcription spend to the sessions already counted this period', async () => {
			await seedSession('0.50')
			await seedUsage({ costUsd: '0.250000' })

			expect(await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)).toBe(75)
		})

		it('counts transcription spend when the workspace has no sessions at all', async () => {
			await seedUsage({ costUsd: '1.230000' })

			expect(await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)).toBe(123)
		})

		it('leaves out spend from before the period and from other workspaces', async () => {
			const other = await insertWorkspace(db, actorId, { enterpriseGranted: false })
			await seedUsage({ costUsd: '0.100000' })
			await seedUsage({ costUsd: '9.000000', createdAt: BEFORE_PERIOD })
			await seedUsage({ costUsd: '9.000000' }, other.id)

			expect(await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)).toBe(10)
		})

		it('rounds up once on the total, so many tiny calls do not each cost a whole cent', async () => {
			await seedUsage({ costUsd: '0.004000' })
			await seedUsage({ costUsd: '0.004000' })
			await seedUsage({ costUsd: '0.004000' })

			// 1.2 cents in all rounds up to 2; rounding each call up would charge 3.
			expect(await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)).toBe(2)
		})
	})

	describe('plan cap', () => {
		it('refuses the next call once transcription spend alone has used the cap and no credit remains', async () => {
			await seedUsage({ costUsd: '10.000000' })

			const err = await checkPlanCap({
				db,
				workspaceId,
				wsSettings: billingSettings(0),
				enterprise: false,
			}).catch((e) => e)

			expect(err).toBeInstanceOf(PlanCapExceededError)
			expect(err.used).toBe(1_000)
			expect(err.cap).toBe(CAP_CENTS)
		})

		it('lets the call through over the cap while a prepaid balance remains', async () => {
			await seedUsage({ costUsd: '10.000000' })

			await expect(
				checkPlanCap({ db, workspaceId, wsSettings: billingSettings(500), enterprise: false }),
			).resolves.toBeUndefined()
		})

		it('lets the call through while the spend is under the cap', async () => {
			await seedUsage({ costUsd: '9.990000' })

			await expect(
				checkPlanCap({ db, workspaceId, wsSettings: billingSettings(0), enterprise: false }),
			).resolves.toBeUndefined()
		})
	})

	describe('prepaid credit overage', () => {
		it('takes transcription spend over the cap from the balance when the next session settles', async () => {
			// $15.00 of transcription against a $10.00 cap: $5.00 over.
			await seedUsage({ costUsd: '15.000000' })
			const session = await seedSession('0.00')
			if (!session) throw new Error('session insert failed')

			await debitCreditForSession({
				db,
				workspaceId,
				sessionId: session.id,
				actorId,
				wsSettings: billingSettings(5_000),
			})

			const [ws] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
			const settings = ws?.settings as WorkspaceSettings
			expect(settings.billing?.credit_balance_cents).toBe(4_500)
		})
	})

	describe('usage breakdown', () => {
		it('splits transcription spend by model and agent, and the parts add up to the total', async () => {
			const agent = await insertActor(db, { name: 'Note Taker', type: 'agent' })
			await seedSession('0.50')
			await seedUsage({ costUsd: '0.250000', actorId: agent.id })
			await seedUsage({ costUsd: '0.250000', actorId: agent.id })

			const breakdown = await readUsageBreakdown(db, workspaceId, PERIOD_START_MS)

			expect(breakdown.usd_cents_used).toBe(100)
			expect(breakdown.by_model.rows).toContainEqual({ id: MODEL, name: MODEL, usd_cents: 50 })
			expect(breakdown.by_agent.rows).toContainEqual({
				id: agent.id,
				name: 'Note Taker',
				usd_cents: 50,
			})
			for (const split of [breakdown.by_model, breakdown.by_agent, breakdown.by_flow]) {
				const parts = split.rows.reduce((a, r) => a + r.usd_cents, 0) + split.other_usd_cents
				expect(parts).toBe(breakdown.usd_cents_used)
			}
		})

		it('reads transcription spend with no sessions and no actor to name', async () => {
			await seedUsage({ costUsd: '0.400000', actorId: null })

			const breakdown = await readUsageBreakdown(db, workspaceId, PERIOD_START_MS)

			expect(breakdown.usd_cents_used).toBe(40)
			expect(breakdown.by_agent.rows).toEqual([{ id: null, name: 'Unknown agent', usd_cents: 40 }])
			expect(breakdown.by_flow.rows).toEqual([{ id: null, name: 'No flow', usd_cents: 40 }])
		})
	})

	describe('foreign keys', () => {
		it('keeps the spend when the transcribed file is deleted', async () => {
			const fileRow = buildFile({ workspaceId, createdBy: actorId, mimeType: 'audio/mpeg' })
			await db.insert(files).values(fileRow as typeof files.$inferInsert)
			const usage = await seedUsage({ fileId: fileRow.id })

			await db.delete(files).where(eq(files.id, fileRow.id))

			const [after] = await db
				.select()
				.from(workspaceAiUsage)
				.where(eq(workspaceAiUsage.id, usage.id))
			expect(after?.fileId).toBeNull()
			expect(Number(after?.costUsd)).toBe(0.5)
		})

		it('refuses a row for a workspace that does not exist', async () => {
			await expect(seedUsage({}, '00000000-0000-4000-8000-000000000000')).rejects.toThrow()
		})
	})
})
