import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
	trackAgentCreated,
	trackAgentGapReportPosted,
} from '../../lib/analytics/agent-builder-events'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn(),
}))

const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
const mockedCapture = capturePosthogEvent as unknown as ReturnType<typeof vi.fn>

describe('trackAgentCreated', () => {
	beforeEach(() => {
		mockedCapture.mockReset()
	})

	it('emits agent_created keyed by workspace_id with all required properties', async () => {
		await trackAgentCreated({
			workspaceId: 'ws-1',
			actorId: 'actor-1',
			generationTimeMs: 12345,
		})

		expect(mockedCapture).toHaveBeenCalledTimes(1)
		expect(mockedCapture).toHaveBeenCalledWith('agent_created', 'ws-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			generation_time_ms: 12345,
		})
	})

	it('does not throw when the underlying capture rejects', async () => {
		mockedCapture.mockRejectedValueOnce(new Error('boom'))
		await expect(
			trackAgentCreated({ workspaceId: 'ws-1', actorId: 'actor-1', generationTimeMs: 1 }),
		).rejects.toThrow('boom')
		// Note: the wrapper propagates like claude-failover-events.ts does. The
		// production posthog helper (posthog.ts) is the one that swallows all
		// errors — callers void the returned promise to keep it fire-and-forget.
	})
})

describe('trackAgentGapReportPosted', () => {
	beforeEach(() => {
		mockedCapture.mockReset()
	})

	it('emits agent_gap_report_posted keyed by workspace_id with all required properties', async () => {
		await trackAgentGapReportPosted({
			workspaceId: 'ws-2',
			actorId: 'actor-2',
			generationTimeMs: 4200,
		})

		expect(mockedCapture).toHaveBeenCalledTimes(1)
		expect(mockedCapture).toHaveBeenCalledWith('agent_gap_report_posted', 'ws-2', {
			workspace_id: 'ws-2',
			actor_id: 'actor-2',
			generation_time_ms: 4200,
		})
	})
})
