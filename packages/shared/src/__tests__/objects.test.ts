import { describe, expect, it } from 'vitest'
import {
	SAFE_METADATA_FIELD_NAME_RE,
	TERMINAL_BET_STATUSES,
	createObjectSchema,
	loopTargetSchema,
	loopTargetSourceSchema,
	objectParamsSchema,
	objectQuerySchema,
	objectTypeSchema,
	searchObjectsSchema,
	updateObjectSchema,
} from '../schemas/objects'

const uuid = '550e8400-e29b-41d4-a716-446655440000'

describe('objectTypeSchema', () => {
	it('accepts valid lowercase slug types', () => {
		expect(objectTypeSchema.parse('insight')).toBe('insight')
		expect(objectTypeSchema.parse('bet')).toBe('bet')
		expect(objectTypeSchema.parse('task')).toBe('task')
		expect(objectTypeSchema.parse('meeting')).toBe('meeting')
		expect(objectTypeSchema.parse('contact')).toBe('contact')
		expect(objectTypeSchema.parse('my_custom_type')).toBe('my_custom_type')
	})

	it('rejects empty string', () => {
		expect(() => objectTypeSchema.parse('')).toThrow()
	})

	it('rejects invalid type formats', () => {
		expect(() => objectTypeSchema.parse('My Type')).toThrow()
		expect(() => objectTypeSchema.parse('UPPER')).toThrow()
		expect(() => objectTypeSchema.parse('has space')).toThrow()
		expect(() => objectTypeSchema.parse('has-dash')).toThrow()
		expect(() => objectTypeSchema.parse('123start')).toThrow()
		expect(() => objectTypeSchema.parse('_leading')).toThrow()
	})
})

describe('createObjectSchema', () => {
	it('accepts valid input with required fields', () => {
		const result = createObjectSchema.parse({ type: 'task', status: 'todo' })
		expect(result.type).toBe('task')
		expect(result.status).toBe('todo')
	})

	it('accepts all optional fields', () => {
		const result = createObjectSchema.parse({
			id: uuid,
			type: 'bet',
			title: 'My bet',
			content: 'Details',
			status: 'active',
			metadata: { priority: 'high' },
			driver: uuid,
		})
		expect(result.id).toBe(uuid)
		expect(result.title).toBe('My bet')
		expect(result.metadata).toEqual({ priority: 'high' })
	})

	it('rejects missing type', () => {
		expect(() => createObjectSchema.parse({ status: 'todo' })).toThrow()
	})

	it('rejects missing status', () => {
		expect(() => createObjectSchema.parse({ type: 'task' })).toThrow()
	})

	it('rejects invalid uuid for id', () => {
		expect(() =>
			createObjectSchema.parse({ type: 'task', status: 'todo', id: 'not-uuid' }),
		).toThrow()
	})

	it('rejects invalid uuid for owner', () => {
		expect(() =>
			createObjectSchema.parse({ type: 'task', status: 'todo', driver: 'not-uuid' }),
		).toThrow()
	})
})

describe('updateObjectSchema', () => {
	it('accepts empty object', () => {
		const result = updateObjectSchema.parse({})
		expect(result).toEqual({})
	})

	it('accepts partial fields', () => {
		const result = updateObjectSchema.parse({ title: 'Updated' })
		expect(result.title).toBe('Updated')
	})

	it('accepts null owner to clear assignment', () => {
		const result = updateObjectSchema.parse({ driver: null })
		expect(result.driver).toBeNull()
	})

	it('accepts uuid owner', () => {
		const result = updateObjectSchema.parse({ driver: uuid })
		expect(result.driver).toBe(uuid)
	})
})

describe('objectQuerySchema', () => {
	it('provides default limit and offset', () => {
		const result = objectQuerySchema.parse({})
		expect(result.limit).toBe(50)
		expect(result.offset).toBe(0)
	})

	it('coerces string numbers', () => {
		const result = objectQuerySchema.parse({ limit: '25', offset: '10' })
		expect(result.limit).toBe(25)
		expect(result.offset).toBe(10)
	})

	it('rejects limit above 100', () => {
		expect(() => objectQuerySchema.parse({ limit: 101 })).toThrow()
	})

	it('rejects limit below 1', () => {
		expect(() => objectQuerySchema.parse({ limit: 0 })).toThrow()
	})

	it('rejects negative offset', () => {
		expect(() => objectQuerySchema.parse({ offset: -1 })).toThrow()
	})

	it('accepts optional type filter', () => {
		const result = objectQuerySchema.parse({ type: 'bet' })
		expect(result.type).toBe('bet')
	})

	it('accepts optional owner filter', () => {
		const result = objectQuerySchema.parse({ driver: uuid })
		expect(result.driver).toBe(uuid)
	})

	it('accepts ISO-8601 updated_before and updated_after', () => {
		const result = objectQuerySchema.parse({
			updated_before: '2026-06-30T00:00:00.000Z',
			updated_after: '2026-06-01T00:00:00.000Z',
		})
		expect(result.updated_before).toBe('2026-06-30T00:00:00.000Z')
		expect(result.updated_after).toBe('2026-06-01T00:00:00.000Z')
	})

	it('rejects malformed updated_before (AC-T6)', () => {
		expect(() => objectQuerySchema.parse({ updated_before: 'not-a-date' })).toThrow()
		expect(() => objectQuerySchema.parse({ updated_before: '2026-06-30' })).toThrow()
	})

	it('rejects malformed updated_after (AC-T6)', () => {
		expect(() => objectQuerySchema.parse({ updated_after: 'yesterday' })).toThrow()
	})
})

describe('searchObjectsSchema', () => {
	it('requires q with min 1 char', () => {
		const result = searchObjectsSchema.parse({ q: 'test' })
		expect(result.q).toBe('test')
	})

	it('rejects empty q', () => {
		expect(() => searchObjectsSchema.parse({ q: '' })).toThrow()
	})

	it('rejects missing q', () => {
		expect(() => searchObjectsSchema.parse({})).toThrow()
	})

	it('defaults limit to 20', () => {
		const result = searchObjectsSchema.parse({ q: 'test' })
		expect(result.limit).toBe(20)
	})

	it('defaults offset to 0', () => {
		const result = searchObjectsSchema.parse({ q: 'test' })
		expect(result.offset).toBe(0)
	})
})

describe('objectParamsSchema', () => {
	it('accepts valid uuid', () => {
		const result = objectParamsSchema.parse({ id: uuid })
		expect(result.id).toBe(uuid)
	})

	it('rejects non-uuid string', () => {
		expect(() => objectParamsSchema.parse({ id: 'abc' })).toThrow()
	})

	it('rejects missing id', () => {
		expect(() => objectParamsSchema.parse({})).toThrow()
	})
})

describe('TERMINAL_BET_STATUSES', () => {
	it('is exactly succeeded/failed/paused — archived is silent, must stay excluded', () => {
		// Locks the invariant that drives the retro fan-out gate
		// (apps/dev/src/routes/objects.ts) and the unread-feed join
		// (apps/dev/src/routes/subscriptions.ts). If `archived` slips in here,
		// archiving a bet fires a retro and posts an unread — which is the
		// exact behaviour the archived-status bet exists to prevent.
		expect([...TERMINAL_BET_STATUSES]).toEqual(['succeeded', 'failed', 'paused'])
		expect((TERMINAL_BET_STATUSES as readonly string[]).includes('archived')).toBe(false)
	})
})

describe('SAFE_METADATA_FIELD_NAME_RE', () => {
	it('accepts letters, numbers, and underscores starting with a letter', () => {
		expect(SAFE_METADATA_FIELD_NAME_RE.test('segment')).toBe(true)
		expect(SAFE_METADATA_FIELD_NAME_RE.test('deal_size_2')).toBe(true)
		expect(SAFE_METADATA_FIELD_NAME_RE.test('A1')).toBe(true)
	})

	it('rejects names with spaces, punctuation, or a leading digit', () => {
		expect(SAFE_METADATA_FIELD_NAME_RE.test('deal size')).toBe(false)
		expect(SAFE_METADATA_FIELD_NAME_RE.test('cost-per-lead')).toBe(false)
		expect(SAFE_METADATA_FIELD_NAME_RE.test('2024_target')).toBe(false)
		expect(SAFE_METADATA_FIELD_NAME_RE.test("bad'field")).toBe(false)
		expect(SAFE_METADATA_FIELD_NAME_RE.test('')).toBe(false)
	})
})

describe('loopTargetSourceSchema', () => {
	// Bet D5 SPEC: `source` is a plain string OR a `metric:<ns>.<key>` OR an
	// `event:<slug>` reference. All three shapes must round-trip; anything else
	// is rejected so an ad-hoc metadata write can't drift a fourth kind in.
	it('accepts a plain-string source (human label before wiring)', () => {
		expect(loopTargetSourceSchema.parse('posts published this month')).toBe(
			'posts published this month',
		)
	})

	it('accepts a metric: reference in the metric:<namespace>.<key> shape', () => {
		expect(loopTargetSourceSchema.parse('metric:linkedin.impressions')).toBe(
			'metric:linkedin.impressions',
		)
		expect(loopTargetSourceSchema.parse('metric:sales.pipeline.opps_open')).toBe(
			'metric:sales.pipeline.opps_open',
		)
	})

	it('accepts an event: reference in the event:<slug> shape', () => {
		expect(loopTargetSourceSchema.parse('event:cycle_closed')).toBe('event:cycle_closed')
		expect(loopTargetSourceSchema.parse('event:demo-booked')).toBe('event:demo-booked')
	})

	it('rejects an empty string', () => {
		expect(() => loopTargetSourceSchema.parse('')).toThrow()
	})

	it('rejects non-string inputs', () => {
		expect(() => loopTargetSourceSchema.parse(42)).toThrow()
		expect(() => loopTargetSourceSchema.parse(null)).toThrow()
	})
})

describe('loopTargetSchema', () => {
	it('accepts a well-formed target with a plain-string source', () => {
		const parsed = loopTargetSchema.parse({
			label: 'Posts published',
			source: 'posts published this month',
			actual: 6,
			target: 8,
		})
		expect(parsed.label).toBe('Posts published')
		expect(parsed.source).toBe('posts published this month')
		expect(parsed.actual).toBe(6)
		expect(parsed.target).toBe(8)
	})

	it('accepts a target with a metric: source', () => {
		const parsed = loopTargetSchema.parse({
			label: 'LinkedIn impressions',
			source: 'metric:linkedin.impressions',
			actual: 4200,
			target: 5000,
			ownerActorId: '550e8400-e29b-41d4-a716-446655440000',
		})
		expect(parsed.source).toBe('metric:linkedin.impressions')
		expect(parsed.ownerActorId).toBe('550e8400-e29b-41d4-a716-446655440000')
	})

	it('accepts a target with an event: source and a pace_policy', () => {
		const parsed = loopTargetSchema.parse({
			label: 'Cycles closed this week',
			source: 'event:cycle_closed',
			actual: 12,
			target: 20,
			pace_policy: 'strict',
		})
		expect(parsed.source).toBe('event:cycle_closed')
		expect(parsed.pace_policy).toBe('strict')
	})

	it('strips a persisted pace field — pace is only ever derived on read', () => {
		// pace is derived on read from actual/target — never persisted. The
		// schema is `.object({...})` (not `.passthrough()`) so an extra key
		// causes strict Zod parsing to strip it, not error. Verify it's dropped.
		const input: Record<string, unknown> = {
			label: 'Posts',
			source: 'posts',
			actual: 3,
			target: 5,
			pace: 'behind',
		}
		const parsed = loopTargetSchema.parse(input)
		expect('pace' in parsed).toBe(false)
	})

	it('rejects a target with a missing required field', () => {
		expect(() => loopTargetSchema.parse({ label: 'Posts', source: 'posts', target: 5 })).toThrow()
	})

	it('rejects an ownerActorId that is not a uuid', () => {
		expect(() =>
			loopTargetSchema.parse({
				label: 'Posts',
				source: 'posts',
				actual: 3,
				target: 5,
				ownerActorId: 'not-a-uuid',
			}),
		).toThrow()
	})
})
