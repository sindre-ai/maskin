import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	FIRST_AGENT_CREATED,
	trackFirstAgentCreated,
} from '../../../lib/analytics/first-agent-events'

describe('first agent events', () => {
	beforeEach(() => capturePosthogEventMock.mockClear())

	it('sends ids and the source only', async () => {
		await trackFirstAgentCreated({
			workspaceId: 'ws-1',
			distinctId: 'actor-1',
			agentId: 'agent-1',
			source: 'onboarding',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(FIRST_AGENT_CREATED, 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			agent_id: 'agent-1',
			source: 'onboarding',
		})
	})
})
