import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { capturePosthogEventMock } = vi.hoisted(() => ({
	capturePosthogEventMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../../lib/analytics/posthog', () => ({
	capturePosthogEvent: capturePosthogEventMock,
}))

import { trackCreateNotificationCalled } from '../../../lib/analytics/notification-events'

function stubDb(agentName: string | null): Database {
	const rows = agentName === null ? [] : [{ name: agentName }]
	return {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: async () => rows,
				}),
			}),
		}),
	} as unknown as Database
}

beforeEach(() => {
	capturePosthogEventMock.mockClear()
})

afterEach(() => {
	vi.restoreAllMocks()
})

describe('trackCreateNotificationCalled', () => {
	it('emits with agent identity when the caller is an agent', async () => {
		await trackCreateNotificationCalled({
			db: stubDb('Bet Strategist'),
			workspaceId: 'ws-1',
			actorId: 'agent-1',
			actorType: 'agent',
			notificationId: 'notif-1',
			notificationType: 'decision_required',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith('create_notification_called', 'agent-1', {
			workspace_id: 'ws-1',
			agent_id: 'agent-1',
			agent_name: 'Bet Strategist',
			notification_id: 'notif-1',
			notification_type: 'decision_required',
		})
	})

	it('skips the emit when the caller is a human', async () => {
		await trackCreateNotificationCalled({
			db: stubDb('Sindre'),
			workspaceId: 'ws-1',
			actorId: 'human-1',
			actorType: 'human',
			notificationId: 'notif-2',
			notificationType: 'info',
		})

		expect(capturePosthogEventMock).not.toHaveBeenCalled()
	})

	it("falls back to 'unknown' when the actor row can't be found", async () => {
		await trackCreateNotificationCalled({
			db: stubDb(null),
			workspaceId: 'ws-1',
			actorId: 'agent-orphan',
			actorType: 'agent',
			notificationId: 'notif-3',
			notificationType: 'info',
		})

		expect(capturePosthogEventMock).toHaveBeenCalledOnce()
		expect(capturePosthogEventMock).toHaveBeenCalledWith(
			'create_notification_called',
			'agent-orphan',
			expect.objectContaining({ agent_name: 'unknown' }),
		)
	})

	it('swallows capture failures so notification create is never blocked', async () => {
		capturePosthogEventMock.mockRejectedValueOnce(new Error('posthog down'))

		await expect(
			trackCreateNotificationCalled({
				db: stubDb('Any Agent'),
				workspaceId: 'ws-1',
				actorId: 'agent-1',
				actorType: 'agent',
				notificationId: 'notif-4',
				notificationType: 'info',
			}),
		).resolves.toBeUndefined()
	})
})
