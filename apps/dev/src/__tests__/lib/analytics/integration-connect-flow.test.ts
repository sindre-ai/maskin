import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	trackConnectError,
	trackConnectStep,
} from '../../../lib/analytics/integration-connect-flow'

const base = { provider: 'notion', workspaceId: 'ws-1', actorId: 'actor-1' }

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

describe('trackConnectStep', () => {
	it('sends flow_step on the integration_connect flow with the provider', async () => {
		trackConnectStep({ ...base, flowId: 'flow-a', step: 'connect_started' })
		await vi.waitFor(() => expect(capturePosthogEventMock).toHaveBeenCalledOnce())

		expect(capturePosthogEventMock).toHaveBeenCalledWith('flow_step', 'actor-1', {
			flow: 'integration_connect',
			step: 'connect_started',
			flow_id: 'flow-a',
			surface: 'backend',
			duration_ms: null,
			provider: 'notion',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})

	it('sends nothing without a flow_id (a state minted before this shipped)', async () => {
		trackConnectStep({ ...base, flowId: undefined, step: 'returned' })
		trackConnectError({
			...base,
			flowId: undefined,
			step: 'returned',
			errorCategory: 'timeout',
		})
		await Promise.resolve()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})

describe('trackConnectError', () => {
	it('sends flow_error with a category from the list', async () => {
		trackConnectError({
			...base,
			flowId: 'flow-b',
			step: 'returned',
			errorCategory: 'provider_error',
		})
		await vi.waitFor(() => expect(capturePosthogEventMock).toHaveBeenCalledOnce())

		expect(capturePosthogEventMock).toHaveBeenCalledWith('flow_error', 'actor-1', {
			flow: 'integration_connect',
			step: 'returned',
			flow_id: 'flow-b',
			surface: 'backend',
			error_category: 'provider_error',
			provider: 'notion',
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
		})
	})
})
