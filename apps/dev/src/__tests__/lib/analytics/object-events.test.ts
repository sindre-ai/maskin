import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackObjectCreated } from '../../../lib/analytics/object-events'

const base = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	objectId: 'obj-1',
	objectType: 'bet',
	createdVia: 'ui' as const,
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackObjectCreated', () => {
	it('sends object_created keyed by the actor, with the object type and the feature area', async () => {
		await trackObjectCreated(base)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('object_created', 'actor-1', {
			workspace_id: 'ws-1',
			actor_id: 'actor-1',
			object_id: 'obj-1',
			object_type: 'bet',
			created_via: 'ui',
			feature_area: 'objects',
		})
	})

	it('also sends loop_created for a loop, under the loops feature area', async () => {
		await trackObjectCreated({ ...base, objectType: 'loop', createdVia: 'agent' })

		const events = capturePosthogEventMock.mock.calls.map(([event]) => event)
		expect(events).toEqual(['object_created', 'loop_created'])
		for (const [, , props] of capturePosthogEventMock.mock.calls) {
			expect(props).toMatchObject({ object_type: 'loop', feature_area: 'loops' })
		}
	})

	it('sends no titles or text', async () => {
		await trackObjectCreated(base)

		const props = capturePosthogEventMock.mock.calls[0]?.[2] as Record<string, unknown>
		expect(Object.keys(props).sort()).toEqual([
			'actor_id',
			'created_via',
			'feature_area',
			'object_id',
			'object_type',
			'workspace_id',
		])
	})

	it('never throws when the capture fails', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('boom'))

		await expect(trackObjectCreated(base)).resolves.toBeUndefined()
	})
})
