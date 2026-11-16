import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackFlowError, trackFlowStep } from '../../../lib/analytics/flow-events'

const base = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	flow: 'signup_to_first_result',
	flowId: 'flow-1',
} as const

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackFlowStep', () => {
	it('sends flow_step with the agreed shape, null duration on the first step', async () => {
		await trackFlowStep({ ...base, step: 'workspace_ready' })

		expect(capturePosthogEventMock).toHaveBeenCalledWith('flow_step', 'actor-1', {
			flow: 'signup_to_first_result',
			step: 'workspace_ready',
			flow_id: 'flow-1',
			surface: 'backend',
			duration_ms: null,
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})

	it('sets duration_ms on the next step of the same flow_id, and honours an explicit one', async () => {
		await trackFlowStep({ ...base, flowId: 'flow-2', step: 'workspace_ready' })
		await trackFlowStep({ ...base, flowId: 'flow-2', step: 'first_agent' })
		const second = capturePosthogEventMock.mock.calls[1][2]
		expect(typeof second.duration_ms).toBe('number')

		await trackFlowStep({ ...base, flowId: 'flow-2', step: 'intro_shown', durationMs: 1234 })
		expect(capturePosthogEventMock.mock.calls[2][2].duration_ms).toBe(1234)
	})

	it('sends nothing for a step outside the vocabulary', async () => {
		// @ts-expect-error unknown step names fail the type check
		await trackFlowStep({ ...base, step: 'not_a_step' })
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('never throws when the capture fails', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('down'))
		await expect(trackFlowStep({ ...base, step: 'workspace_ready' })).resolves.toBeUndefined()
	})
})

describe('trackFlowError', () => {
	it('sends flow_error with a category and no message text', async () => {
		await trackFlowError({ ...base, step: 'first_run_started', errorCategory: 'provider_error' })

		expect(capturePosthogEventMock).toHaveBeenCalledWith('flow_error', 'actor-1', {
			flow: 'signup_to_first_result',
			step: 'first_run_started',
			flow_id: 'flow-1',
			surface: 'backend',
			error_category: 'provider_error',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})
