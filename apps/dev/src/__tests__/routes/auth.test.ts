import { buildActor } from '../factories'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// Mock verifyPassword before importing the route
const mockVerifyPassword = vi.fn()
vi.mock('@maskin/auth', async (importOriginal) => {
	const actual = await importOriginal<typeof import('@maskin/auth')>()
	return {
		...actual,
		verifyPassword: mockVerifyPassword,
	}
})

const { default: authRoutes } = await import('../../routes/auth')

describe('Auth Routes', () => {
	beforeEach(() => {
		mockVerifyPassword.mockReset()
	})

	describe('POST /api/auth/login', () => {
		it('returns 200 on successful login', async () => {
			const actor = buildActor({ passwordHash: 'hashed-password' })
			const { app, mockResults } = createTestApp(authRoutes, '/api/auth')
			mockResults.select = [actor]
			mockVerifyPassword.mockResolvedValue(true)

			const res = await app.request(
				jsonRequest('POST', '/api/auth/login', {
					email: actor.email,
					password: 'correct-password',
				}),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.api_key).toBeDefined()
			// Ensure passwordHash is not leaked
			expect(body.passwordHash).toBeUndefined()
			expect(body.password_hash).toBeUndefined()
		})

		it('returns 401 when actor not found', async () => {
			const { app } = createTestApp(authRoutes, '/api/auth')

			const res = await app.request(
				jsonRequest('POST', '/api/auth/login', {
					email: 'nonexistent@test.com',
					password: 'any-password',
				}),
			)

			expect(res.status).toBe(401)
			const body = await res.json()
			expect(body.error.code).toBe('UNAUTHORIZED')
			expect(body.error.message).toBe('Invalid credentials')
		})

		it('returns 401 when actor has no password hash', async () => {
			const actor = buildActor({ passwordHash: null })
			const { app, mockResults } = createTestApp(authRoutes, '/api/auth')
			mockResults.select = [actor]

			const res = await app.request(
				jsonRequest('POST', '/api/auth/login', {
					email: actor.email,
					password: 'any-password',
				}),
			)

			expect(res.status).toBe(401)
			const body = await res.json()
			expect(body.error.code).toBe('UNAUTHORIZED')
		})

		it('returns 401 when password is wrong', async () => {
			const actor = buildActor({ passwordHash: 'hashed-password' })
			const { app, mockResults } = createTestApp(authRoutes, '/api/auth')
			mockResults.select = [actor]
			mockVerifyPassword.mockResolvedValue(false)

			const res = await app.request(
				jsonRequest('POST', '/api/auth/login', {
					email: actor.email,
					password: 'wrong-password',
				}),
			)

			expect(res.status).toBe(401)
			const body = await res.json()
			expect(body.error.code).toBe('UNAUTHORIZED')
		})

		it('returns 400 for validation errors (empty body)', async () => {
			const { app } = createTestApp(authRoutes, '/api/auth')

			const res = await app.request(jsonRequest('POST', '/api/auth/login', {}))

			expect(res.status).toBe(400)
		})

		it('returns 400 for invalid email format', async () => {
			const { app } = createTestApp(authRoutes, '/api/auth')

			const res = await app.request(
				jsonRequest('POST', '/api/auth/login', {
					email: 'not-an-email',
					password: 'testpassword',
				}),
			)

			expect(res.status).toBe(400)
		})
	})
})
