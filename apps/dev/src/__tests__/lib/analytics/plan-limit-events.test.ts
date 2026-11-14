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
	it('sends the plan and the workspace id and nothing else', async () => {
		await trackPlanLimitReached({ workspaceId: 'ws-1', plan: 'pro', periodEnd: 1_800_000_000_000 })

		expect(capturePosthogEventMock).toHaveBeenCalledTimes(1)
		expect(capturePosthogEventMock).toHaveBeenCalledWith('plan_limit_reached', 'ws-1', {
			workspace_id: 'ws-1',
			plan: 'pro',
		})
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
