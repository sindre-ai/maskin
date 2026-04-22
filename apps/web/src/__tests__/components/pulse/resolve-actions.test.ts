import { resolveActions } from '@/components/pulse/pulse-card'
import type { NotificationResponse } from '@/lib/api'
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

describe('resolveActions', () => {
	it('returns metadata-defined actions when present', () => {
		const customActions = [{ label: 'Custom', response: 'custom_response' }]
		const result = resolveActions(buildNotification(), { actions: customActions })
		expect(result).toEqual(customActions)
	})

	it('returns empty when input_type is set', () => {
		const result = resolveActions(buildNotification({ type: 'recommendation' }), {
			input_type: 'text',
		})
		expect(result).toEqual([])
	})

	describe('recommendation type', () => {
		it('returns "View objects" without objectId', () => {
			const result = resolveActions(buildNotification({ type: 'recommendation' }), {})
			expect(result).toEqual([
				{ label: 'View objects', response: 'view_object', navigate: { to: 'objects' } },
			])
		})

		it('returns "View object" with objectId', () => {
			const result = resolveActions(
				buildNotification({ type: 'recommendation', objectId: 'obj-1' }),
				{},
			)
			expect(result).toEqual([
				{ label: 'View object', response: 'view_object', navigate: { to: 'object' } },
			])
		})
	})

	describe('alert type', () => {
		it('returns "Review tasks" without objectId', () => {
			const result = resolveActions(buildNotification({ type: 'alert' }), {})
			expect(result).toEqual([
				{ label: 'Review tasks', response: 'acknowledged', navigate: { to: 'objects' } },
			])
		})

		it('returns "Review" with objectId', () => {
			const result = resolveActions(buildNotification({ type: 'alert', objectId: 'obj-1' }), {})
			expect(result).toEqual([
				{ label: 'Review', response: 'acknowledged', navigate: { to: 'object' } },
			])
		})
	})

	describe('good_news type', () => {
		it('returns "View" with objectId', () => {
			const result = resolveActions(buildNotification({ type: 'good_news', objectId: 'obj-1' }), {})
			expect(result).toEqual([
				{ label: 'View', response: 'acknowledged', navigate: { to: 'object' } },
			])
		})

		it('returns empty without objectId', () => {
			const result = resolveActions(buildNotification({ type: 'good_news' }), {})
			expect(result).toEqual([])
		})
	})

	it('returns empty for unknown notification types', () => {
		const result = resolveActions(buildNotification({ type: 'unknown_type' }), {})
		expect(result).toEqual([])
	})

	it('prefers metadata actions over defaults', () => {
		const customActions = [{ label: 'Override', response: 'override' }]
		const result = resolveActions(buildNotification({ type: 'alert', objectId: 'obj-1' }), {
			actions: customActions,
		})
		expect(result).toEqual(customActions)
	})

	it('falls back to defaults when metadata actions is empty array', () => {
		const result = resolveActions(buildNotification({ type: 'alert' }), { actions: [] })
		expect(result).toEqual([
			{ label: 'Review tasks', response: 'acknowledged', navigate: { to: 'objects' } },
		])
	})

	describe('stringified actions (defensive coercion)', () => {
		it('parses a JSON-stringified actions array', () => {
			const stringified = JSON.stringify([
				{ label: 'Merged, continue', response: 'merged_continue' },
				{ label: 'Not ready yet', response: 'not_ready' },
			])
			const result = resolveActions(buildNotification(), { actions: stringified })
			expect(result).toEqual([
				{ label: 'Merged, continue', response: 'merged_continue' },
				{ label: 'Not ready yet', response: 'not_ready' },
			])
		})

		it('falls back to defaults when actions string is malformed JSON', () => {
			const result = resolveActions(buildNotification({ type: 'alert', objectId: 'obj-1' }), {
				actions: 'not valid json',
			})
			expect(result).toEqual([
				{ label: 'Review', response: 'acknowledged', navigate: { to: 'object' } },
			])
		})

		it('falls back to defaults when parsed value is not an array', () => {
			const result = resolveActions(buildNotification({ type: 'alert' }), {
				actions: '{"label":"not an array"}',
			})
			expect(result).toEqual([
				{ label: 'Review tasks', response: 'acknowledged', navigate: { to: 'objects' } },
			])
		})
	})
})
