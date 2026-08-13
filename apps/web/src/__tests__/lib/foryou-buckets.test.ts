import { describe, expect, it } from 'vitest'

import type { NotificationResponse } from '@/lib/api'
import { bulkResponseFor, classifyNotification, groupNotifications } from '@/lib/foryou-buckets'

const NOW = Date.parse('2026-08-13T12:00:00Z')

function buildNotification(overrides: Partial<NotificationResponse> = {}): NotificationResponse {
	return {
		id: crypto.randomUUID(),
		workspaceId: 'ws-1',
		type: 'needs_input',
		title: 'Untitled',
		content: null,
		metadata: null,
		sourceActorId: crypto.randomUUID(),
		targetActorId: null,
		objectId: null,
		sessionId: null,
		status: 'pending',
		resolvedAt: null,
		expiresAt: null,
		defaultAction: null,
		dispatchAt: null,
		wakeDispatched: false,
		createdAt: '2026-08-13T10:00:00Z',
		updatedAt: '2026-08-13T10:00:00Z',
		...overrides,
	}
}

describe('classifyNotification', () => {
	it('routes pending notifications with metadata.options to Decision needed', () => {
		const notification = buildNotification({
			metadata: { options: [{ label: 'Yes', value: 'yes' }] },
		})
		expect(classifyNotification(notification, { now: NOW })).toBe('decision')
	})

	it('routes needs_input notifications to Decision needed even when metadata.options is empty', () => {
		expect(classifyNotification(buildNotification({ type: 'needs_input' }), { now: NOW })).toBe(
			'decision',
		)
	})

	it('routes resolved notifications with a pending dispatch to Waiting on agents', () => {
		const notification = buildNotification({
			status: 'resolved',
			resolvedAt: '2026-08-13T11:59:55Z',
			dispatchAt: '2026-08-13T12:00:05Z',
			wakeDispatched: false,
		})
		expect(classifyNotification(notification, { now: NOW })).toBe('waiting')
	})

	it('routes resolved notifications whose wake has already fired to Handled today', () => {
		const notification = buildNotification({
			status: 'resolved',
			resolvedAt: '2026-08-13T09:00:00Z',
			dispatchAt: '2026-08-13T09:00:06Z',
			wakeDispatched: true,
		})
		expect(classifyNotification(notification, { now: NOW })).toBe('handled')
	})

	it('routes good_news and alerts to FYI', () => {
		expect(classifyNotification(buildNotification({ type: 'good_news' }), { now: NOW })).toBe('fyi')
		expect(classifyNotification(buildNotification({ type: 'alert' }), { now: NOW })).toBe('fyi')
	})
})

describe('groupNotifications', () => {
	it('collapses same-objectId notifications inside their bucket, newest primary first', () => {
		const objectId = 'obj-1'
		const older = buildNotification({
			id: 'older',
			objectId,
			type: 'needs_input',
			updatedAt: '2026-08-13T09:00:00Z',
		})
		const newer = buildNotification({
			id: 'newer',
			objectId,
			type: 'needs_input',
			updatedAt: '2026-08-13T11:00:00Z',
		})

		const grouped = groupNotifications([older, newer], { now: NOW })

		expect(grouped.decision).toHaveLength(1)
		expect(grouped.decision[0].items.map((i) => i.id)).toEqual(['newer', 'older'])
		expect(grouped.decision[0].primary.id).toBe('newer')
	})

	it('keeps notifications without an objectId as their own standalone groups', () => {
		const first = buildNotification({ id: 'a', type: 'needs_input' })
		const second = buildNotification({ id: 'b', type: 'needs_input' })

		const grouped = groupNotifications([first, second], { now: NOW })

		expect(grouped.decision).toHaveLength(2)
		expect(grouped.decision.every((g) => g.items.length === 1)).toBe(true)
	})

	it('separates the same objectId into different buckets when their statuses diverge', () => {
		const objectId = 'obj-mixed'
		const pending = buildNotification({
			id: 'p',
			objectId,
			type: 'needs_input',
		})
		const resolved = buildNotification({
			id: 'r',
			objectId,
			status: 'resolved',
			resolvedAt: '2026-08-13T11:00:00Z',
			wakeDispatched: true,
		})

		const grouped = groupNotifications([pending, resolved], { now: NOW })

		expect(grouped.decision.map((g) => g.primary.id)).toEqual(['p'])
		expect(grouped.handled.map((g) => g.primary.id)).toEqual(['r'])
	})
})

describe('bulkResponseFor', () => {
	it('uses metadata.recommendation when present', () => {
		const group = {
			key: 'k',
			bucket: 'decision' as const,
			objectId: 'obj',
			primary: buildNotification({
				metadata: { recommendation: 'send-it' },
			}),
			items: [buildNotification()],
		}
		expect(bulkResponseFor(group)).toEqual({ response: 'send-it' })
	})

	it('falls back to defaultAction when there is no recommendation', () => {
		const group = {
			key: 'k',
			bucket: 'decision' as const,
			objectId: 'obj',
			primary: buildNotification({ defaultAction: 'approve' }),
			items: [buildNotification()],
		}
		expect(bulkResponseFor(group)).toEqual({ response: 'approve' })
	})

	it('returns null when neither recommendation nor defaultAction is set', () => {
		const group = {
			key: 'k',
			bucket: 'decision' as const,
			objectId: 'obj',
			primary: buildNotification(),
			items: [buildNotification()],
		}
		expect(bulkResponseFor(group)).toBeNull()
	})
})
