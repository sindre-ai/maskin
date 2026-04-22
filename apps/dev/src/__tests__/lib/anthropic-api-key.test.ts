import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
	decryptAnthropicApiKey,
	encryptAnthropicApiKey,
	maskAnthropicKey,
	validateAnthropicApiKey,
} from '../../lib/anthropic-api-key'

const KEY_HEX = 'a'.repeat(64)

describe('anthropic-api-key lib', () => {
	const originalKey = process.env.INTEGRATION_ENCRYPTION_KEY
	beforeEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = KEY_HEX
	})
	afterEach(() => {
		process.env.INTEGRATION_ENCRYPTION_KEY = originalKey
	})

	describe('maskAnthropicKey', () => {
		it('returns only the last 4 characters', () => {
			expect(maskAnthropicKey('sk-ant-very-long-secret-wxyz')).toBe('wxyz')
		})

		it('returns the whole string when shorter than 4', () => {
			expect(maskAnthropicKey('abc')).toBe('abc')
		})
	})

	describe('encryptAnthropicApiKey / decryptAnthropicApiKey', () => {
		it('round-trips a plaintext key', () => {
			const encrypted = encryptAnthropicApiKey('sk-ant-plaintext-1234')
			expect(encrypted.last4).toBe('1234')
			expect(encrypted.encryptedKey).not.toContain('sk-ant-plaintext')
			expect(encrypted.createdAt).toBeGreaterThan(0)
			expect(decryptAnthropicApiKey(encrypted)).toBe('sk-ant-plaintext-1234')
		})

		it('uses a fresh IV so ciphertexts differ between calls', () => {
			const a = encryptAnthropicApiKey('same-key')
			const b = encryptAnthropicApiKey('same-key')
			expect(a.encryptedKey).not.toBe(b.encryptedKey)
		})
	})

	describe('validateAnthropicApiKey', () => {
		it('returns ok=true on 200', async () => {
			const fetchImpl = vi.fn().mockResolvedValue({ ok: true, status: 200, json: async () => ({}) })
			const result = await validateAnthropicApiKey(
				'sk-ant-xxx',
				fetchImpl as unknown as typeof fetch,
			)
			expect(result.ok).toBe(true)
			expect(fetchImpl).toHaveBeenCalledWith(
				'https://api.anthropic.com/v1/models',
				expect.objectContaining({
					method: 'GET',
					headers: expect.objectContaining({ 'x-api-key': 'sk-ant-xxx' }),
				}),
			)
		})

		it('returns ok=false with the upstream error message on 401', async () => {
			const fetchImpl = vi.fn().mockResolvedValue({
				ok: false,
				status: 401,
				json: async () => ({ error: { message: 'invalid x-api-key' } }),
			})
			const result = await validateAnthropicApiKey('sk-bad', fetchImpl as unknown as typeof fetch)
			expect(result.ok).toBe(false)
			expect(result.status).toBe(401)
			expect(result.message).toBe('invalid x-api-key')
		})

		it('returns ok=false when fetch throws (network error)', async () => {
			const fetchImpl = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
			const result = await validateAnthropicApiKey(
				'sk-whatever',
				fetchImpl as unknown as typeof fetch,
			)
			expect(result.ok).toBe(false)
			expect(result.message).toContain('ECONNREFUSED')
		})
	})
})
