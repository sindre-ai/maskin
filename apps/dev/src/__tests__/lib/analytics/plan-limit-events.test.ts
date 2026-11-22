import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	resetPlanLimitEventsForTest,
	trackPlanLimitReached,
} from '../../../lib/analytics/plan-limit-events'

beforeEach(() => {
	capturePosthogEventMock.mockClear()
	resetPlanLimitEventsForTest()
})

describe('trackPlanLimitReached', () => {
	it('sends the plan and the workspace id when no usage is given', async () => {
		await trackPlanLimitReached({ workspaceId: 'ws-1', plan: 'pro', periodEnd: 1_800_000_000_000 })

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith('plan_limit_reached', 'ws-1', {
			workspace_id: 'ws-1',
			plan: 'pro',
		})
	})

	it('adds the percent of the plan and the tokens used', async () => {
		await trackPlanLimitReached({
			workspaceId: 'ws-1',
			plan: 'pro',
			periodEnd: 1,
			usedCents: 1_000,
			capCents: 1_000,
			readTokens: async () => ({ inputTokens: 1_200, outputTokens: 300 }),
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('plan_limit_reached', 'ws-1', {
			workspace_id: 'ws-1',
			plan: 'pro',
			usage_percent: 100,
			input_tokens: 1_200,
			output_tokens: 300,
		})
	})

	it.each([
		[0, 1_000, 0],
		[420, 1_000, 42],
		[1_500, 1_000, 100],
	])('reports %i of %i cents as %i percent, the number the app shows', async (used, cap, want) => {
		await trackPlanLimitReached({
			workspaceId: 'ws-1',
			plan: 'pro',
			periodEnd: 1,
			usedCents: used,
			capCents: cap,
		})

		expect(capturePosthogEventMock.mock.calls[0]?.[2]).toMatchObject({ usage_percent: want })
	})

	it('leaves the percent out when the plan has no limit', async () => {
		await trackPlanLimitReached({
			workspaceId: 'ws-1',
			plan: 'pro',
			periodEnd: 1,
			usedCents: 500,
			capCents: null,
		})

		expect(capturePosthogEventMock.mock.calls[0]?.[2]).not.toHaveProperty('usage_percent')
	})

	it('still sends the event when the tokens cannot be read', async () => {
		await trackPlanLimitReached({
			workspaceId: 'ws-1',
			plan: 'pro',
			periodEnd: 1,
			usedCents: 1_000,
			capCents: 1_000,
			readTokens: async () => {
				throw new Error('db down')
			},
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith('plan_limit_reached', 'ws-1', {
			workspace_id: 'ws-1',
			plan: 'pro',
			usage_percent: 100,
		})
	})

	it('does not read the tokens for a repeat of the same period', async () => {
		const readTokens = vi.fn(async () => ({ inputTokens: 1, outputTokens: 2 }))
		const p = { workspaceId: 'ws-1', plan: 'pro', periodEnd: 1, readTokens }
		await trackPlanLimitReached(p)
		await trackPlanLimitReached(p)

		expect(readTokens).toHaveBeenCalledTimes(1)
	})

	it('sends once per workspace, plan and period, however many starts are refused', async () => {
		const p = { workspaceId: 'ws-1', plan: 'trial', periodEnd: 1_800_000_000_000 }
		await trackPlanLimitReached(p)
		await trackPlanLimitReached(p)
		await trackPlanLimitReached(p)

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
	})

	it('sends again for the next period and for another workspace', async () => {
		await trackPlanLimitReached({ workspaceId: 'ws-1', plan: 'pro', periodEnd: 1 })
		await trackPlanLimitReached({ workspaceId: 'ws-1', plan: 'pro', periodEnd: 2 })
		await trackPlanLimitReached({ workspaceId: 'ws-2', plan: 'pro', periodEnd: 1 })

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(3)
	})
})
