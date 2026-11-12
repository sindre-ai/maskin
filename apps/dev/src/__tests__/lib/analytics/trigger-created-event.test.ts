import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackTriggerCreated } from '../../../lib/analytics/trigger-created-event'

const base = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	actorType: 'human',
	triggerId: 'trg-1',
	triggerType: 'cron',
	createdVia: 'ui' as const,
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackTriggerCreated', () => {
	it('sends trigger_created keyed by the actor, with the ids, the kind and a person actor type', async () => {
		await trackTriggerCreated(base)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('trigger_created', 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			actor_type: 'human',
			entity_id: 'trg-1',
			entity_type: 'trigger',
			trigger_type: 'cron',
			created_via: 'ui',
		})
	})

	it('marks a trigger made by an agent over MCP as the agent', async () => {
		await trackTriggerCreated({ ...base, actorType: 'agent', createdVia: 'mcp' })

		expect(capturePosthogEventMock.mock.calls[0][2]).toMatchObject({
			actor_type: 'agent',
			created_via: 'mcp',
		})
	})

	it('sends no names, prompts or addresses', async () => {
		await trackTriggerCreated(base)

		const keys = Object.keys(capturePosthogEventMock.mock.calls[0][2])
		expect(keys.filter((k) => /name|prompt|email|text|content/.test(k))).toEqual([])
	})

	it('never throws when the capture does', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('boom'))

		await expect(trackTriggerCreated(base)).resolves.toBeUndefined()
	})
})
