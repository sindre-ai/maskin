import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi'
import {
	ApiErrorCode,
	apiErrorSchema,
	createApiError,
	formatZodError,
	mapStatusToCode,
} from '../lib/errors'

// Create a test app with the same defaultHook and onError as index.ts
function createErrorTestApp() {
	const app = new OpenAPIHono({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	app.onError((err, c) => {
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		return c.json(createApiError(ApiErrorCode.INTERNAL_ERROR, 'An unexpected error occurred'), 500)
	})

	// Test route with typed body validation
	const testRoute = createRoute({
		method: 'post',
		path: '/test',
		request: {
			body: {
				content: {
					'application/json': {
						schema: z.object({
							title: z.string().min(1),
							type: z.enum(['task', 'bet', 'insight']),
							source_id: z.string().uuid(),
							count: z.number().int(),
						}),
					},
				},
			},
		},
		responses: {
			200: {
				description: 'OK',
				content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
			},
		},
	})

	app.openapi(testRoute, (c) => c.json({ ok: true }))

	// Route that throws an unhandled error
	app.get('/crash', () => {
		throw new Error('Something broke internally')
	})

	// Route that throws an HTTP-like error
	app.get('/http-error', () => {
		const err = new Error('Not Found') as Error & { status: number }
		err.status = 404
		throw err
	})

	return app
}

describe('Error Handling', () => {
	const app = createErrorTestApp()

	function postJson(body: unknown) {
		return app.request('/test', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(body),
		})
	}

	describe('Zod validation errors', () => {
		it('returns structured error with field paths for invalid type', async () => {
			const res = await postJson({
				title: 123,
				type: 'task',
				source_id: '550e8400-e29b-41d4-a716-446655440000',
				count: 1,
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
			expect(body.error.details).toBeDefined()
			const titleDetail = body.error.details.find((d: { field: string }) => d.field === 'title')
			expect(titleDetail).toBeDefined()
			expect(titleDetail.expected).toBe('string')
			expect(titleDetail.received).toBe('number')
		})

		it('returns structured error for invalid UUID', async () => {
			const res = await postJson({
				title: 'Test',
				type: 'task',
				source_id: 'not-a-uuid',
				count: 1,
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			const detail = body.error.details.find((d: { field: string }) => d.field === 'source_id')
			expect(detail).toBeDefined()
			expect(detail.expected).toContain('UUID')
		})

		it('returns structured error for invalid enum with options', async () => {
			const res = await postJson({
				title: 'Test',
				type: 'invalid_type',
				source_id: '550e8400-e29b-41d4-a716-446655440000',
				count: 1,
			})

			expect(res.status).toBe(400)
			const body = await res.json()
			const detail = body.error.details.find((d: { field: string }) => d.field === 'type')
			expect(detail).toBeDefined()
			expect(detail.expected).toContain('task')
			expect(detail.expected).toContain('bet')
			expect(detail.expected).toContain('insight')
		})

		it('returns structured error for missing required fields', async () => {
			const res = await postJson({})

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.code).toBe('VALIDATION_ERROR')
			expect(body.error.details.length).toBeGreaterThanOrEqual(1)
		})
	})

	describe('Global error handler', () => {
		it('returns 500 without stack trace for unhandled errors', async () => {
			const res = await app.request('/crash')

			expect(res.status).toBe(500)
			const body = await res.json()
			expect(body.error.code).toBe('INTERNAL_ERROR')
			expect(body.error.message).toBe('An unexpected error occurred')
			expect(JSON.stringify(body)).not.toContain('stack')
			expect(JSON.stringify(body)).not.toContain('Something broke internally')
		})

		it('maps HTTP status errors correctly', async () => {
			const res = await app.request('/http-error')

			expect(res.status).toBe(404)
			const body = await res.json()
			expect(body.error.code).toBe('NOT_FOUND')
		})
	})

	describe('mapStatusToCode', () => {
		it('maps 400 to BAD_REQUEST', () => {
			expect(mapStatusToCode(400)).toBe('BAD_REQUEST')
		})

		it('maps 401 to UNAUTHORIZED', () => {
			expect(mapStatusToCode(401)).toBe('UNAUTHORIZED')
		})

		it('maps 403 to FORBIDDEN', () => {
			expect(mapStatusToCode(403)).toBe('FORBIDDEN')
		})

		it('maps 404 to NOT_FOUND', () => {
			expect(mapStatusToCode(404)).toBe('NOT_FOUND')
		})

		it('maps 409 to CONFLICT', () => {
			expect(mapStatusToCode(409)).toBe('CONFLICT')
		})

		it('maps unknown status to INTERNAL_ERROR', () => {
			expect(mapStatusToCode(503)).toBe('INTERNAL_ERROR')
		})
	})

	describe('apiErrorSchema', () => {
		it('validates a minimal error response', () => {
			const result = apiErrorSchema.safeParse(createApiError('BAD_REQUEST', 'Something went wrong'))
			expect(result.success).toBe(true)
		})

		it('validates an error response with details', () => {
			const result = apiErrorSchema.safeParse(
				createApiError('VALIDATION_ERROR', 'Validation failed', [
					{ field: 'title', message: 'Required', expected: 'string', received: 'undefined' },
					{ field: 'type', message: 'Invalid enum value' },
				]),
			)
			expect(result.success).toBe(true)
		})

		it('validates an error response with suggestion', () => {
			const result = apiErrorSchema.safeParse(
				createApiError('BAD_REQUEST', 'Invalid status', undefined, 'Use one of: todo, done'),
			)
			expect(result.success).toBe(true)
			if (result.success) {
				expect(result.data.error.suggestion).toBe('Use one of: todo, done')
			}
		})

		it('rejects a response missing required fields', () => {
			expect(apiErrorSchema.safeParse({ error: { code: 'X' } }).success).toBe(false)
			expect(apiErrorSchema.safeParse({ error: { message: 'X' } }).success).toBe(false)
			expect(apiErrorSchema.safeParse({}).success).toBe(false)
		})
	})
})
