import { researchRuns } from '@maskin/db/schema'
import { PlanCapExceededError, getWorkspacePlanUsdCentsUsage } from '../../lib/llm-routing'
import { resolveResearchRunCapCents } from '../../lib/research-cap'
import type { WorkspaceSettings } from '../../lib/types'
import { insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const PERIOD_START_SEC = 1_700_000_000
const PERIOD_START_MS = PERIOD_START_SEC * 1000
const CAP_CENTS = 1_000

function proSettings(): WorkspaceSettings {
	return {
		billing: {
			plan: 'pro',
			status: 'active',
			hard_cap_usd_cents: CAP_CENTS,
			period_start: PERIOD_START_SEC,
		},
	} as WorkspaceSettings
}

describe('research_runs and the plan usage sum (Integration)', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		// enterpriseGranted defaults to true in the factory; the cap does not apply to those.
		const ws = await insertWorkspace(db, actorId, { enterpriseGranted: false })
		workspaceId = ws.id
	})

	async function insertRun(overrides: Partial<typeof researchRuns.$inferInsert> = {}) {
		const rows = await db
			.insert(researchRuns)
			.values({
				workspaceId,
				actorId,
				question: 'What does the Danish bookkeeping act require?',
				effort: 'simple',
				capCents: 100,
				costCents: 500,
				llmRoute: 'maskin_plan',
				createdAt: new Date(PERIOD_START_MS + 1_000),
				...overrides,
			})
			.returning()
		return rows[0]
	}

	it('raises the reported usage by the cost of a run', async () => {
		const before = await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)
		await insertRun({ costCents: 500 })
		const after = await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)
		expect(before).toBe(0)
		expect(after - before).toBe(500)
	})

	it('adds research cost to session cost and ignores other routes, periods and workspaces', async () => {
		await insertSession(db, workspaceId, actorId, actorId, {
			status: 'completed',
			config: { llm_route: 'maskin_plan' },
			totalCostUsd: '1.00',
			createdAt: new Date(PERIOD_START_MS + 1_000),
		})
		await insertRun({ costCents: 300 })
		await insertRun({ costCents: 900, llmRoute: 'api_key' })
		await insertRun({ costCents: 900, createdAt: new Date(PERIOD_START_MS - 86_400_000) })
		const other = await insertWorkspace(db, actorId, { enterpriseGranted: false })
		await insertRun({ workspaceId: other.id, costCents: 900 })

		expect(await getWorkspacePlanUsdCentsUsage(db, workspaceId, PERIOD_START_MS)).toBe(400)
	})

	it('clamps a new run to the headroom left after research cost', async () => {
		await insertRun({ costCents: 750 })
		const cap = await resolveResearchRunCapCents({
			db,
			workspaceId,
			wsSettings: proSettings(),
			enterprise: false,
			effort: 'broad',
		})
		expect(cap).toBe(250)
	})

	it('refuses a run when only 30 cents of headroom are left', async () => {
		await insertRun({ costCents: 970 })
		await expect(
			resolveResearchRunCapCents({
				db,
				workspaceId,
				wsSettings: proSettings(),
				enterprise: false,
				effort: 'simple',
			}),
		).rejects.toBeInstanceOf(PlanCapExceededError)
	})

	it('rejects a status or effort outside the allowed values', async () => {
		await expect(insertRun({ status: 'weird' })).rejects.toThrow()
		await expect(insertRun({ effort: 'huge' })).rejects.toThrow()
	})
})
