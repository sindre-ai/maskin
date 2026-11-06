import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	FIRST_AGENT_CREATED,
	isFirstAgentInWorkspace,
	trackFirstAgentCreated,
} from '../../../lib/analytics/first-agent-events'

function dbWithOtherAgents(n: number) {
	const chain: Record<string, unknown> = {}
	for (const m of ['select', 'from', 'innerJoin']) chain[m] = () => chain
	chain.where = () => Promise.resolve([{ n }])
	return chain as unknown as Parameters<typeof isFirstAgentInWorkspace>[0]
}

describe('first agent events', () => {
	beforeEach(() => capturePosthogEventMock.mockClear())

	it('sends ids and the source only', async () => {
		await trackFirstAgentCreated({
			workspaceId: 'ws-1',
			distinctId: 'actor-1',
			agentId: 'agent-1',
			source: 'person',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledWith(FIRST_AGENT_CREATED, 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			agent_id: 'agent-1',
			source: 'person',
		})
	})

	it('is the first agent only when the workspace has no other agent', async () => {
		expect(await isFirstAgentInWorkspace(dbWithOtherAgents(0), 'ws-1', 'agent-1')).toBe(true)
		expect(await isFirstAgentInWorkspace(dbWithOtherAgents(3), 'ws-1', 'agent-1')).toBe(false)
	})
})
