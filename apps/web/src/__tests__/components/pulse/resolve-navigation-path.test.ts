import type { NotificationResponse } from '@/lib/api'
import { resolveNavigationPath } from '@/routes/_authed/$workspaceId/index'
import { describe, expect, it } from 'vitest'

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
				{ to: 'object', id: 'obj-explicit' },
				buildNotification(),
			)
			expect(result).toBe('/ws-1/objects/obj-explicit')
		})

		it('falls back to notification.objectId', () => {
			const result = resolveNavigationPath(
				workspaceId,
				{ to: 'object' },
				buildNotification({ objectId: 'obj-fallback' }),
			)
			expect(result).toBe('/ws-1/objects/obj-fallback')
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
				{ to: 'agent', id: 'agent-1' },
				buildNotification(),
			)
			expect(result).toBe('/ws-1/agents/agent-1')
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
				{ to: 'trigger', id: 'trigger-1' },
				buildNotification(),
			)
			expect(result).toBe('/ws-1/triggers/trigger-1')
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
})
