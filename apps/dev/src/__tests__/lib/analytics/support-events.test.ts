import { beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import {
	trackSupportItemOpened,
	trackSupportItemResolved,
} from '../../../lib/analytics/support-events'

const opened = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	objectId: 'insight-1',
	objectType: 'insight',
	metadata: { source: 'customer_feedback' },
}

// A db whose selects resolve in order: the task's edges, then the linked objects.
function dbWith(edges: unknown[], insights: unknown[]) {
	const queue = [edges, insights]
	const chain = () => {
		const rows = queue.shift() ?? []
		const q: Record<string, unknown> = {}
		q.from = () => q
		q.where = () => Promise.resolve(rows)
		return q
	}
	return { select: vi.fn(chain) } as never
}

const resolved = {
	workspaceId: 'ws-1',
	actorId: 'actor-1',
	taskId: 'task-1',
	fromStatus: 'in_review',
	toStatus: 'done',
	resolvedAt: new Date('2026-11-11T12:00:00Z'),
}

beforeEach(() => {
	capturePosthogEventMock.mockReset()
	capturePosthogEventMock.mockResolvedValue(undefined)
})

describe('trackSupportItemOpened', () => {
	it('sends support_item_opened for a customer feedback insight, with ids and the source only', async () => {
		await trackSupportItemOpened(opened)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('support_item_opened', 'actor-1', {
			workspace_id: 'ws-1',
			insight_id: 'insight-1',
			source: 'customer_feedback',
		})
	})

	it('sends nothing for internal feedback, other sources or other object types', async () => {
		await trackSupportItemOpened({ ...opened, metadata: { source: 'internal_feedback' } })
		await trackSupportItemOpened({ ...opened, metadata: null })
		await trackSupportItemOpened({ ...opened, objectType: 'task' })

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('never throws when the capture fails', async () => {
		capturePosthogEventMock.mockRejectedValue(new Error('boom'))
		await expect(trackSupportItemOpened(opened)).resolves.toBeUndefined()
	})
})

describe('trackSupportItemResolved', () => {
	const insight = {
		id: 'insight-1',
		createdAt: new Date('2026-11-11T06:00:00Z'),
		metadata: { source: 'customer_feedback' },
	}

	it('sends support_item_resolved with the hours since the insight was created', async () => {
		const db = dbWith([{ sourceId: 'task-1', targetId: 'insight-1' }], [insight])
		await trackSupportItemResolved(db, resolved)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('support_item_resolved', 'actor-1', {
			workspace_id: 'ws-1',
			insight_id: 'insight-1',
			task_id: 'task-1',
			source: 'customer_feedback',
			hours_to_resolve: 6,
		})
	})

	it('finds the insight when the edge points from the insight to the task', async () => {
		const db = dbWith([{ sourceId: 'insight-1', targetId: 'task-1' }], [insight])
		await trackSupportItemResolved(db, resolved)

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
	})

	it('sends nothing for a task with no linked insight', async () => {
		await trackSupportItemResolved(dbWith([], []), resolved)

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('sends nothing when the linked insight is not customer feedback', async () => {
		const internal = { ...insight, metadata: { source: 'internal_feedback' } }
		const db = dbWith([{ sourceId: 'task-1', targetId: 'insight-1' }], [internal])
		await trackSupportItemResolved(db, resolved)

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('sends nothing unless the task moves into done', async () => {
		const db = dbWith([{ sourceId: 'task-1', targetId: 'insight-1' }], [insight])
		await trackSupportItemResolved(db, { ...resolved, toStatus: 'in_review' })
		await trackSupportItemResolved(db, { ...resolved, fromStatus: 'done' })

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it('never throws when the lookup fails', async () => {
		const db = {
			select: () => {
				throw new Error('db down')
			},
		} as never
		await expect(trackSupportItemResolved(db, resolved)).resolves.toBeUndefined()
		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})
})
