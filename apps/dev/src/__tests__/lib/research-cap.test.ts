import type { Database } from '@maskin/db'
import { researchRuns } from '@maskin/db/schema'
import { describe, expect, it, vi } from 'vitest'
import { PlanCapExceededError, getWorkspacePlanUsdCentsUsage } from '../../lib/llm-routing'
import {
	RESEARCH_EFFORT_DEFAULT_CAP_CENTS,
	researchHardCeilingCents,
	resolveResearchRunCapCents,
} from '../../lib/research-cap'
import type { WorkspaceSettings } from '../../lib/types'

/** A db whose session query returns `sessionRows` and whose research query sums to `researchCents`. */
function dbWithUsage(opts: {
	sessionCostUsd?: string[]
	researchCents?: number | null
}): Database {
	const sessionRows = (opts.sessionCostUsd ?? []).map((totalCostUsd) => ({
		totalCostUsd,
		inputTokens: 0,
		outputTokens: 0,
	}))
	return {
		select: vi.fn(() => ({
			from: vi.fn((table: unknown) => ({
				where: vi.fn(async () =>
					table === researchRuns ? [{ costCents: opts.researchCents ?? null }] : sessionRows,
				),
			})),
		})),
	} as unknown as Database
}

function proSettings(hardCapCents = 1_000): WorkspaceSettings {
	return {
		billing: { plan: 'pro', status: 'active', hard_cap_usd_cents: hardCapCents, period_start: 0 },
	} as WorkspaceSettings
}

const base = { workspaceId: 'ws-1', enterprise: false } as const

describe('getWorkspacePlanUsdCentsUsage with research runs', () => {
	it('adds research cost_cents to the session total', async () => {
		const sessionsOnly = await getWorkspacePlanUsdCentsUsage(
			dbWithUsage({ sessionCostUsd: ['1.00'] }),
			'ws-1',
			0,
		)
		const withResearch = await getWorkspacePlanUsdCentsUsage(
			dbWithUsage({ sessionCostUsd: ['1.00'], researchCents: 500 }),
			'ws-1',
			0,
		)
		expect(sessionsOnly).toBe(100)
		expect(withResearch - sessionsOnly).toBe(500)
	})

	it('counts research cost when the workspace has no sessions', async () => {
		const db = dbWithUsage({ researchCents: 500 })
		expect(await getWorkspacePlanUsdCentsUsage(db, 'ws-1', 0)).toBe(500)
	})
})

describe('resolveResearchRunCapCents', () => {
	it('returns the effort default when there is plenty of headroom', async () => {
		const cap = await resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({}),
			wsSettings: proSettings(),
			effort: 'comparison',
		})
		expect(cap).toBe(RESEARCH_EFFORT_DEFAULT_CAP_CENTS.comparison)
	})

	it('clamps to the headroom left under the plan cap, counting research cost', async () => {
		// Cap $10.00, $5.00 in sessions + 250 cents of research: 250 cents left.
		const cap = await resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({ sessionCostUsd: ['5.00'], researchCents: 250 }),
			wsSettings: proSettings(),
			effort: 'broad',
		})
		expect(cap).toBe(250)
	})

	it('never returns more than 30 cents of headroom: it refuses', async () => {
		// Cap $10.00, 970 cents used: 30 cents left, below the $1 simple default.
		const run = resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({ sessionCostUsd: ['9.70'] }),
			wsSettings: proSettings(),
			effort: 'simple',
		})
		await expect(run).rejects.toBeInstanceOf(PlanCapExceededError)
	})

	it('refuses with the plan, usage and cap the 402 carries when headroom is zero', async () => {
		const err = await resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({ sessionCostUsd: ['4.00'], researchCents: 700 }),
			wsSettings: proSettings(),
			effort: 'simple',
		}).catch((e) => e)
		expect(err).toBeInstanceOf(PlanCapExceededError)
		expect(err.plan).toBe('pro')
		expect(err.used).toBe(1_100)
		expect(err.cap).toBe(1_000)
	})

	it('refuses an over-cap workspace even with a prepaid credit balance', async () => {
		const settings = proSettings()
		settings.billing = { ...settings.billing, credit_balance_cents: 5_000 } as never
		const run = resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({ sessionCostUsd: ['20.00'] }),
			wsSettings: settings,
			effort: 'simple',
		})
		await expect(run).rejects.toBeInstanceOf(PlanCapExceededError)
	})

	it('lets an enterprise workspace run at the effort default without reading usage', async () => {
		const db = dbWithUsage({ sessionCostUsd: ['999.00'] })
		const cap = await resolveResearchRunCapCents({
			...base,
			enterprise: true,
			db,
			wsSettings: proSettings(),
			effort: 'broad',
		})
		expect(cap).toBe(RESEARCH_EFFORT_DEFAULT_CAP_CENTS.broad)
		expect(db.select).not.toHaveBeenCalled()
	})

	it('lets a workspace on a non-metered plan run at the effort default', async () => {
		const cap = await resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({ sessionCostUsd: ['999.00'] }),
			wsSettings: { billing: { plan: 'enterprise' } } as WorkspaceSettings,
			effort: 'comparison',
		})
		expect(cap).toBe(RESEARCH_EFFORT_DEFAULT_CAP_CENTS.comparison)
	})

	it('lets the caller lower the cap but not raise it', async () => {
		const common = { ...base, db: dbWithUsage({}), wsSettings: proSettings(5_000) }
		expect(
			await resolveResearchRunCapCents({
				...common,
				effort: 'comparison',
				callerMaxCostUsd: 2.5,
			}),
		).toBe(250)
		expect(
			await resolveResearchRunCapCents({
				...common,
				effort: 'comparison',
				callerMaxCostUsd: 50,
			}),
		).toBe(RESEARCH_EFFORT_DEFAULT_CAP_CENTS.comparison)
	})

	it('rejects a non-positive max_cost_usd', async () => {
		const run = resolveResearchRunCapCents({
			...base,
			db: dbWithUsage({}),
			wsSettings: proSettings(),
			effort: 'simple',
			callerMaxCostUsd: 0,
		})
		await expect(run).rejects.toBeInstanceOf(RangeError)
	})

	it('applies RESEARCH_MAX_CAP_USD as a ceiling over the effort default', async () => {
		const cap = await resolveResearchRunCapCents({
			...base,
			enterprise: true,
			db: dbWithUsage({}),
			wsSettings: proSettings(),
			effort: 'broad',
			env: { RESEARCH_MAX_CAP_USD: '3' },
		})
		expect(cap).toBe(300)
	})
})

describe('researchHardCeilingCents', () => {
	it('defaults to $15 and ignores junk values', () => {
		expect(researchHardCeilingCents({})).toBe(1_500)
		expect(researchHardCeilingCents({ RESEARCH_MAX_CAP_USD: 'abc' })).toBe(1_500)
		expect(researchHardCeilingCents({ RESEARCH_MAX_CAP_USD: '-2' })).toBe(1_500)
		expect(researchHardCeilingCents({ RESEARCH_MAX_CAP_USD: '8.5' })).toBe(850)
	})
})
