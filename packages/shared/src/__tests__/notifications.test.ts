import { describe, expect, it } from 'vitest'
import {
	createNotificationSchema,
	notificationQuerySchema,
	notificationStatusSchema,
	notificationTypeSchema,
	respondNotificationSchema,
	updateNotificationSchema,
} from '../schemas/notifications'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('notificationTypeSchema', () => {
	it('accepts all notification types', () => {
		expect(notificationTypeSchema.parse('needs_input')).toBe('needs_input')
		expect(notificationTypeSchema.parse('recommendation')).toBe('recommendation')
		expect(notificationTypeSchema.parse('good_news')).toBe('good_news')
		expect(notificationTypeSchema.parse('alert')).toBe('alert')
	})

	it('rejects unknown type', () => {
		expect(() => notificationTypeSchema.parse('warning')).toThrow()
	})
})

describe('notificationStatusSchema', () => {
	it('accepts all statuses', () => {
		expect(notificationStatusSchema.parse('pending')).toBe('pending')
		expect(notificationStatusSchema.parse('seen')).toBe('seen')
		expect(notificationStatusSchema.parse('resolved')).toBe('resolved')
		expect(notificationStatusSchema.parse('dismissed')).toBe('dismissed')
	})

	it('rejects unknown status', () => {
		expect(() => notificationStatusSchema.parse('read')).toThrow()
	})
})

describe('createNotificationSchema', () => {
	it('accepts valid notification', () => {
		const result = createNotificationSchema.parse({
			type: 'needs_input',
			title: 'Review needed',
			source_actor_id: uuid,
		})
		expect(result.type).toBe('needs_input')
		expect(result.title).toBe('Review needed')
	})

	it('accepts all optional fields', () => {
		const result = createNotificationSchema.parse({
			type: 'alert',
			title: 'Alert',
			content: 'Something happened',
			metadata: { severity: 'high' },
			source_actor_id: uuid,
			target_actor_id: uuid,
			object_id: uuid,
			session_id: uuid,
		})
		expect(result.content).toBe('Something happened')
		expect(result.object_id).toBe(uuid)
	})

	it('rejects missing type', () => {
		expect(() => createNotificationSchema.parse({ title: 'Test', source_actor_id: uuid })).toThrow()
	})

	it('rejects missing title', () => {
		expect(() => createNotificationSchema.parse({ type: 'alert', source_actor_id: uuid })).toThrow()
	})

	it('rejects empty title', () => {
		expect(() =>
			createNotificationSchema.parse({ type: 'alert', title: '', source_actor_id: uuid }),
		).toThrow()
	})

	it('rejects missing source_actor_id', () => {
		expect(() => createNotificationSchema.parse({ type: 'alert', title: 'Test' })).toThrow()
	})
})

describe('updateNotificationSchema', () => {
	it('accepts empty object', () => {
		expect(updateNotificationSchema.parse({})).toEqual({})
	})

	it('accepts status update', () => {
		const result = updateNotificationSchema.parse({ status: 'resolved' })
		expect(result.status).toBe('resolved')
	})

	it('accepts metadata update', () => {
		const result = updateNotificationSchema.parse({ metadata: { resolved_by: 'admin' } })
		expect(result.metadata).toEqual({ resolved_by: 'admin' })
	})
})

describe('respondNotificationSchema', () => {
	it('accepts string response', () => {
		const result = respondNotificationSchema.parse({ response: 'approved' })
		expect(result.response).toBe('approved')
	})

	it('accepts number response', () => {
		const result = respondNotificationSchema.parse({ response: 42 })
		expect(result.response).toBe(42)
	})

	it('accepts boolean response', () => {
		const result = respondNotificationSchema.parse({ response: true })
		expect(result.response).toBe(true)
	})

	it('accepts null response', () => {
		const result = respondNotificationSchema.parse({ response: null })
		expect(result.response).toBeNull()
	})

	it('rejects missing response', () => {
		expect(() => respondNotificationSchema.parse({})).toThrow()
	})
})

describe('notificationQuerySchema', () => {
	it('provides default limit and offset', () => {
		const result = notificationQuerySchema.parse({})
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(0)
	})

	it('accepts optional filters', () => {
		const result = notificationQuerySchema.parse({
			status: 'pending',
			type: 'alert',
			object_id: uuid,
		})
		expect(result.status).toBe('pending')
		expect(result.type).toBe('alert')
	})

	it('coerces limit and offset from strings', () => {
		const result = notificationQuerySchema.parse({ limit: '10', offset: '5' })
		expect(result.limit).toBe(10)
		expect(result.offset).toBe(5)
	})
})
