import { describe, expect, it } from 'vitest'
import {
	bulkRespondNotificationSchema,
	createNotificationSchema,
	isValidRequestDecisionMetadata,
	notificationMetadataSchema,
	notificationOptionSchema,
	notificationQuerySchema,
	notificationStatusSchema,
	notificationTypeSchema,
	requestDecisionMetadataSchema,
	respondNotificationSchema,
	reverseNotificationSchema,
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

	it('accepts expired for auto-resolved notifications', () => {
		expect(notificationStatusSchema.parse('expired')).toBe('expired')
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

	it('accepts single status filter', () => {
		const result = notificationQuerySchema.parse({
			status: 'pending',
			type: 'alert',
			object_id: uuid,
		})
		expect(result.status).toEqual(['pending'])
		expect(result.type).toBe('alert')
	})

	it('accepts comma-separated status filter', () => {
		const result = notificationQuerySchema.parse({ status: 'pending,seen' })
		expect(result.status).toEqual(['pending', 'seen'])
	})

	it('rejects invalid status in comma-separated list', () => {
		expect(() => notificationQuerySchema.parse({ status: 'pending,invalid' })).toThrow()
	})

	it('coerces limit and offset from strings', () => {
		const result = notificationQuerySchema.parse({ limit: '10', offset: '5' })
		expect(result.limit).toBe(10)
		expect(result.offset).toBe(5)
	})

	it('parses attention_needed=true from a query string', () => {
		const result = notificationQuerySchema.parse({ attention_needed: 'true' })
		expect(result.attention_needed).toBe(true)
	})

	it('parses attention_needed=false from a query string', () => {
		const result = notificationQuerySchema.parse({ attention_needed: 'false' })
		expect(result.attention_needed).toBe(false)
	})

	it('accepts a native boolean for attention_needed and leaves it unset when omitted', () => {
		expect(notificationQuerySchema.parse({ attention_needed: true }).attention_needed).toBe(true)
		expect(notificationQuerySchema.parse({}).attention_needed).toBeUndefined()
	})
})

describe('notificationMetadataSchema', () => {
	it('accepts a native actions array of objects', () => {
		const result = notificationMetadataSchema.parse({
			actions: [
				{ label: 'Merged, continue', response: 'merged_continue' },
				{ label: 'Not ready yet', response: 'not_ready' },
			],
		})
		expect(result.actions).toHaveLength(2)
		expect(result.actions?.[0]).toEqual({
			label: 'Merged, continue',
			response: 'merged_continue',
		})
	})

	it('coerces a JSON-stringified actions array into a native array', () => {
		const result = notificationMetadataSchema.parse({
			actions: JSON.stringify([{ label: 'Approve', response: 'approved' }]),
		})
		expect(Array.isArray(result.actions)).toBe(true)
		expect(result.actions).toEqual([{ label: 'Approve', response: 'approved' }])
	})

	it('rejects a malformed actions string', () => {
		expect(() => notificationMetadataSchema.parse({ actions: 'not json' })).toThrow()
	})

	it('rejects an actions string that parses to a non-array JSON value', () => {
		expect(() =>
			notificationMetadataSchema.parse({ actions: '{"label":"x","response":"y"}' }),
		).toThrow()
	})

	it('accepts a native options array for structured input', () => {
		const result = notificationMetadataSchema.parse({
			input_type: 'single_choice',
			options: [
				{ label: 'Yes', value: 'yes' },
				{ label: 'No', value: 'no' },
			],
		})
		expect(result.options).toHaveLength(2)
	})

	it('coerces a JSON-stringified options array', () => {
		const result = notificationMetadataSchema.parse({
			input_type: 'single_choice',
			options: JSON.stringify([{ label: 'Yes', value: 'yes' }]),
		})
		expect(result.options).toEqual([{ label: 'Yes', value: 'yes' }])
	})

	it('accepts native actions array when composed inside createNotificationSchema', () => {
		const result = createNotificationSchema.parse({
			type: 'needs_input',
			title: 'test',
			source_actor_id: '00000000-0000-0000-0000-000000000001',
			metadata: {
				actions: [
					{ label: 'Merged, continue', response: 'merged_continue' },
					{ label: 'Not ready yet', response: 'not_ready' },
				],
			},
		})
		expect(Array.isArray(result.metadata?.actions)).toBe(true)
		expect(result.metadata?.actions).toHaveLength(2)
	})

	it('allows unknown keys to pass through', () => {
		const result = notificationMetadataSchema.parse({
			blocked_by_pr: 'https://github.com/x/y/pull/1',
			urgency_label: 'Blocking next task',
		})
		expect(result.urgency_label).toBe('Blocking next task')
		expect((result as Record<string, unknown>).blocked_by_pr).toBe('https://github.com/x/y/pull/1')
	})

	it('accepts decision-support fields within their length caps', () => {
		const result = notificationMetadataSchema.parse({
			asked: 'a'.repeat(120),
			found: 'b'.repeat(280),
			recommendation: 'c'.repeat(160),
			attention_needed: true,
			reversibility: 'reversible',
			blast_radius: 'workspace',
			group_key: 'object-42',
		})
		expect(result.asked).toHaveLength(120)
		expect(result.found).toHaveLength(280)
		expect(result.recommendation).toHaveLength(160)
		expect(result.attention_needed).toBe(true)
		expect(result.reversibility).toBe('reversible')
		expect(result.blast_radius).toBe('workspace')
		expect(result.group_key).toBe('object-42')
	})

	it('rejects asked longer than 120 chars', () => {
		expect(() => notificationMetadataSchema.parse({ asked: 'a'.repeat(121) })).toThrow()
	})

	it('rejects found longer than 280 chars', () => {
		expect(() => notificationMetadataSchema.parse({ found: 'b'.repeat(281) })).toThrow()
	})

	it('rejects recommendation longer than 160 chars', () => {
		expect(() => notificationMetadataSchema.parse({ recommendation: 'c'.repeat(161) })).toThrow()
	})

	it('rejects unknown reversibility values', () => {
		expect(() => notificationMetadataSchema.parse({ reversibility: 'maybe' })).toThrow()
	})

	it('rejects unknown blast_radius values', () => {
		expect(() => notificationMetadataSchema.parse({ blast_radius: 'galactic' })).toThrow()
	})

	it('accepts a native artifacts array', () => {
		const result = notificationMetadataSchema.parse({
			artifacts: [{ kind: 'diff', fileId: uuid, title: 'PR #123 diff' }],
		})
		expect(result.artifacts).toHaveLength(1)
		expect(result.artifacts?.[0]?.fileId).toBe(uuid)
	})

	it('coerces a JSON-stringified artifacts array', () => {
		const result = notificationMetadataSchema.parse({
			artifacts: JSON.stringify([{ kind: 'metric', fileId: uuid, title: 'CTR' }]),
		})
		expect(result.artifacts).toHaveLength(1)
		expect(result.artifacts?.[0]?.kind).toBe('metric')
	})

	it('rejects an artifact with a non-UUID fileId', () => {
		expect(() =>
			notificationMetadataSchema.parse({
				artifacts: [{ kind: 'diff', fileId: 'not-a-uuid', title: 'x' }],
			}),
		).toThrow()
	})
})

describe('notificationOptionSchema', () => {
	it('accepts an option without the default marker', () => {
		const result = notificationOptionSchema.parse({ label: 'Yes', value: 'yes' })
		expect(result.default).toBeUndefined()
	})

	it('accepts an option marked as the expiry default', () => {
		const result = notificationOptionSchema.parse({
			label: 'Skip',
			value: 'skip',
			default: true,
		})
		expect(result.default).toBe(true)
	})

	it('rejects a non-boolean default marker', () => {
		expect(() =>
			notificationOptionSchema.parse({ label: 'Yes', value: 'yes', default: 'yes' }),
		).toThrow()
	})
})

describe('bulkRespondNotificationSchema', () => {
	it('accepts a non-empty id list with a response', () => {
		const result = bulkRespondNotificationSchema.parse({
			ids: [uuid],
			response: 'approved',
		})
		expect(result.ids).toEqual([uuid])
		expect(result.response).toBe('approved')
	})

	it('rejects an empty id list', () => {
		expect(() => bulkRespondNotificationSchema.parse({ ids: [], response: 'x' })).toThrow()
	})

	it('rejects a non-UUID id', () => {
		expect(() =>
			bulkRespondNotificationSchema.parse({ ids: ['not-a-uuid'], response: 'x' }),
		).toThrow()
	})

	it('rejects a missing response', () => {
		expect(() => bulkRespondNotificationSchema.parse({ ids: [uuid] })).toThrow()
	})
})

describe('reverseNotificationSchema', () => {
	it('accepts an empty body (server enforces the 6s window)', () => {
		expect(reverseNotificationSchema.parse({})).toEqual({})
	})
})

describe('requestDecisionMetadataSchema / isValidRequestDecisionMetadata', () => {
	const valid = {
		asked: 'Ship checkout v2?',
		found: 'Green across staging; zero open bugs; feature flag rollout ready.',
		recommendation: 'Ship — reversible in 24h via the kill switch.',
		options: [
			{ label: 'Ship', value: 'ship', default: true },
			{ label: 'Hold', value: 'hold' },
		],
	}

	it('accepts a complete request_decision payload', () => {
		expect(() => requestDecisionMetadataSchema.parse(valid)).not.toThrow()
		expect(isValidRequestDecisionMetadata(valid)).toBe(true)
	})

	it('passes through unrelated metadata keys', () => {
		expect(
			isValidRequestDecisionMetadata({
				...valid,
				attention_needed: true,
				group_key: 'onboarding',
				tags: ['ship-review'],
			}),
		).toBe(true)
	})

	it('rejects when a decision-support field is missing', () => {
		const { asked, ...missingAsked } = valid
		void asked
		expect(isValidRequestDecisionMetadata(missingAsked)).toBe(false)

		const { found, ...missingFound } = valid
		void found
		expect(isValidRequestDecisionMetadata(missingFound)).toBe(false)

		const { recommendation, ...missingRec } = valid
		void recommendation
		expect(isValidRequestDecisionMetadata(missingRec)).toBe(false)

		const { options, ...missingOptions } = valid
		void options
		expect(isValidRequestDecisionMetadata(missingOptions)).toBe(false)
	})

	it('rejects an empty options[] (there must be at least one option to pick)', () => {
		expect(isValidRequestDecisionMetadata({ ...valid, options: [] })).toBe(false)
	})

	it('rejects when a decision-support field violates its length cap', () => {
		expect(isValidRequestDecisionMetadata({ ...valid, asked: 'a'.repeat(121) })).toBe(false)
		expect(isValidRequestDecisionMetadata({ ...valid, found: 'b'.repeat(281) })).toBe(false)
		expect(isValidRequestDecisionMetadata({ ...valid, recommendation: 'c'.repeat(161) })).toBe(
			false,
		)
	})

	it('rejects empty-string values (agents must actually fill each field)', () => {
		expect(isValidRequestDecisionMetadata({ ...valid, asked: '' })).toBe(false)
		expect(isValidRequestDecisionMetadata({ ...valid, found: '' })).toBe(false)
		expect(isValidRequestDecisionMetadata({ ...valid, recommendation: '' })).toBe(false)
	})

	it('returns false for null, undefined, or a non-object payload — the pre-Stage-1 baseline', () => {
		expect(isValidRequestDecisionMetadata(null)).toBe(false)
		expect(isValidRequestDecisionMetadata(undefined)).toBe(false)
		expect(isValidRequestDecisionMetadata('request_decision')).toBe(false)
		expect(isValidRequestDecisionMetadata(42)).toBe(false)
	})
})
