import type { NotificationResponse } from '@/lib/api'
import {
	extractNotificationObjectIds,
	resolveNavigationPath,
	resolveNavigationTarget,
} from '@/lib/navigation'
import { describe, expect, it } from 'vitest'

const VALID_UUID = '00000000-0000-0000-0000-000000000001'
const VALID_UUID_2 = '00000000-0000-0000-0000-000000000002'
const VALID_UUID_3 = '00000000-0000-0000-0000-000000000003'

function buildNotification(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
	return {
		id: 'n-1',
		workspaceId: 'ws-1',
		type: 'recommendation',
		title: 'Test',
		content: null,
		metadata: null,
		sourceActorId: 'actor-1',
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		createdAt: null,
		updatedAt: null,
		...overrides,
	}
}

describe('resolveNavigationPath', () => {
	const workspaceId = 'ws-1'

	describe('object navigation', () => {
		it('uses nav.id when provided', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'object', id: VALID_UUID },
				buildNotification(),
			)
			expect(result).toBe(`/ws-1/objects/${VALID_UUID}`)
		})

		it('falls back to notification.objectId', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'object' },
				buildNotification({ objectId: VALID_UUID_2 }),
			)
			expect(result).toBe(`/ws-1/objects/${VALID_UUID_2}`)
		})

		it('falls back to objects list when no id available', () => {
			const result = resolveNavigationPath(workspaceId, { to: 'object' }, buildNotification())
			expect(result).toBe('/ws-1/objects')
		})
	})

	it('returns objects list path', () => {
		const result = resolveNavigationPath(workspaceId, { to: 'objects' }, buildNotification())
		expect(result).toBe('/ws-1/objects')
	})

	it('returns activity path', () => {
		const result = resolveNavigationPath(workspaceId, { to: 'activity' }, buildNotification())
		expect(result).toBe('/ws-1/activity')
	})

	describe('agent navigation', () => {
		it('returns agent path with id', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'agent', id: VALID_UUID },
				buildNotification(),
			)
			expect(result).toBe(`/ws-1/agents/${VALID_UUID}`)
		})

		it('returns null without id', () => {
			const result = resolveNavigationPath(workspaceId, { to: 'agent' }, buildNotification())
			expect(result).toBeNull()
		})
	})

	describe('trigger navigation', () => {
		it('returns trigger path with id', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'trigger', id: VALID_UUID },
				buildNotification(),
			)
			expect(result).toBe(`/ws-1/triggers/${VALID_UUID}`)
		})

		it('returns null without id', () => {
			const result = resolveNavigationPath(workspaceId, { to: 'trigger' }, buildNotification())
			expect(result).toBeNull()
		})
	})

	it('returns null for unknown navigation targets', () => {
		const result = resolveNavigationPath(workspaceId, { to: 'unknown' }, buildNotification())
		expect(result).toBeNull()
	})

	describe('UUID validation', () => {
		it('ignores nav.id with path traversal', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'agent', id: '../../admin' },
				buildNotification(),
			)
			expect(result).toBeNull()
		})

		it('ignores nav.id that is not a valid UUID', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'object', id: 'not-a-uuid' },
				buildNotification(),
			)
			expect(result).toBe('/ws-1/objects')
		})

		it('ignores notification.objectId that is not a valid UUID', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'object' },
				buildNotification({ objectId: 'not-a-uuid' }),
			)
			expect(result).toBe('/ws-1/objects')
		})
	})
})

describe('extractNotificationObjectIds', () => {
	it('returns empty array for notification with no object references', () => {
		const result = extractNotificationObjectIds(buildNotification())
		expect(result).toEqual([])
	})

	it('extracts objectId', () => {
		const result = extractNotificationObjectIds(buildNotification({ objectId: VALID_UUID }))
		expect(result).toEqual([VALID_UUID])
	})

	it('extracts metadata _id fields', () => {
		const result = extractNotificationObjectIds(
			buildNotification({
				metadata: { bet_id: VALID_UUID_2, task_id: VALID_UUID_3 },
			}),
		)
		expect(result).toContain(VALID_UUID_2)
		expect(result).toContain(VALID_UUID_3)
	})

	it('combines objectId and metadata _id fields without duplicates', () => {
		const result = extractNotificationObjectIds(
			buildNotification({
				objectId: VALID_UUID,
				metadata: { bet_id: VALID_UUID, task_id: VALID_UUID_2 },
			}),
		)
		expect(result).toHaveLength(2)
		expect(result).toContain(VALID_UUID)
		expect(result).toContain(VALID_UUID_2)
	})

	it('excludes non-object id keys (source_actor_id, target_actor_id, session_id)', () => {
		const result = extractNotificationObjectIds(
			buildNotification({
				metadata: {
					source_actor_id: VALID_UUID,
					target_actor_id: VALID_UUID_2,
					session_id: VALID_UUID_3,
				},
			}),
		)
		expect(result).toEqual([])
	})

	it('excludes non-UUID values in _id fields', () => {
		const result = extractNotificationObjectIds(
			buildNotification({
				metadata: { bet_id: 'not-a-uuid' },
			}),
		)
		expect(result).toEqual([])
	})
})

describe('resolveNavigationTarget', () => {
	const workspaceId = 'ws-1'

	it('returns path and search with ids for objects navigation with referenced objects', () => {
		const notification = buildNotification({
			objectId: VALID_UUID,
			metadata: { bet_id: VALID_UUID_2 },
		})
		const target = resolveNavigationTarget(workspaceId, { to: 'objects' }, notification)
		expect(target).toEqual({
			path: '/ws-1/objects',
			search: { ids: `${VALID_UUID},${VALID_UUID_2}` },
		})
	})

	it('returns path without search for objects navigation with no referenced objects', () => {
		const target = resolveNavigationTarget(workspaceId, { to: 'objects' }, buildNotification())
		expect(target).toEqual({ path: '/ws-1/objects' })
	})

	it('returns path without search for object navigation', () => {
		const target = resolveNavigationTarget(
			workspaceId,
			{ to: 'object', id: VALID_UUID },
			buildNotification(),
		)
		expect(target).toEqual({ path: `/ws-1/objects/${VALID_UUID}` })
	})

	it('returns null for unknown targets', () => {
		const target = resolveNavigationTarget(workspaceId, { to: 'unknown' }, buildNotification())
		expect(target).toBeNull()
	})
})
