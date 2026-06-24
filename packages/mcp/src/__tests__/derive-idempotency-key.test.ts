import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deriveIdempotencyKey } from '../server'

describe('deriveIdempotencyKey', () => {
	beforeEach(() => {
		vi.stubEnv('SESSION_ID', 'sess-abc-123')
	})

	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('returns undefined outside a session (no SESSION_ID)', () => {
		vi.stubEnv('SESSION_ID', '')
		const key = deriveIdempotencyKey('POST', '/api/events', { content: 'hi' })
		expect(key).toBeUndefined()
	})

	it('returns undefined for safe methods', () => {
		expect(deriveIdempotencyKey('GET', '/api/objects', undefined)).toBeUndefined()
		expect(deriveIdempotencyKey('HEAD', '/api/objects', undefined)).toBeUndefined()
		expect(deriveIdempotencyKey('OPTIONS', '/api/objects', undefined)).toBeUndefined()
	})

	it('returns a stable key for the same (method, path, body)', () => {
		const body = { entity_id: 'obj-1', content: 'hi' }
		const k1 = deriveIdempotencyKey('POST', '/api/events', body)
		const k2 = deriveIdempotencyKey('POST', '/api/events', body)
		expect(k1).toBeDefined()
		expect(k1).toBe(k2)
		expect(k1?.startsWith('mcp:sess-abc-123:')).toBe(true)
	})

	it('produces different keys for different bodies (snapshot replay safety)', () => {
		const k1 = deriveIdempotencyKey('POST', '/api/events', { content: 'a' })
		const k2 = deriveIdempotencyKey('POST', '/api/events', { content: 'b' })
		expect(k1).not.toBe(k2)
	})

	it('produces different keys per session id', () => {
		vi.stubEnv('SESSION_ID', 'sess-1')
		const k1 = deriveIdempotencyKey('POST', '/api/events', { content: 'x' })
		vi.stubEnv('SESSION_ID', 'sess-2')
		const k2 = deriveIdempotencyKey('POST', '/api/events', { content: 'x' })
		expect(k1).not.toBe(k2)
	})

	it('produces different keys per path (same body, different tool)', () => {
		const body = { foo: 'bar' }
		const k1 = deriveIdempotencyKey('POST', '/api/events', body)
		const k2 = deriveIdempotencyKey('POST', '/api/triggers', body)
		expect(k1).not.toBe(k2)
	})

	it('covers POST, PATCH, DELETE, PUT', () => {
		for (const method of ['POST', 'PATCH', 'DELETE', 'PUT']) {
			const key = deriveIdempotencyKey(method, '/api/objects/1', undefined)
			expect(key).toBeDefined()
		}
	})
})
