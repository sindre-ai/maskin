import { vi } from 'vitest'

vi.mock('../../lib/anthropic-api-key', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/anthropic-api-key')>()
	return {
		...actual,
		validateAnthropicApiKey: vi.fn(),
		encryptAnthropicApiKey: vi.fn(),
	}
})

import { encryptAnthropicApiKey, validateAnthropicApiKey } from '../../lib/anthropic-api-key'
import { buildWorkspace, buildWorkspaceMember } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: anthropicApiKeyRoutes } = await import('../../routes/anthropic-api-key')

const wsId = '00000000-0000-0000-0000-000000000001'
const headers = { 'x-workspace-id': wsId }

const mockValidate = validateAnthropicApiKey as ReturnType<typeof vi.fn>
const mockEncrypt = encryptAnthropicApiKey as ReturnType<typeof vi.fn>

describe('Anthropic API Key Routes', () => {
	beforeEach(() => {
		vi.clearAllMocks()
	})

	describe('GET /api/anthropic-api-key/status', () => {
		it('returns set=true with last4 when key is stored', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					anthropic_api_key: {
						encryptedKey: 'enc-key',
						last4: '1234',
						createdAt: 1700000000000,
					},
				},
			})
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonGet('/api/anthropic-api-key/status', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.set).toBe(true)
			expect(body.last4).toBe('1234')
			expect(body.created_at).toBe(1700000000000)
		})

		it('returns set=false when key is not stored', async () => {
			const workspace = buildWorkspace({ id: wsId, settings: {} })
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonGet('/api/anthropic-api-key/status', headers))

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.set).toBe(false)
		})

		it('never returns the full key', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					anthropic_api_key: {
						encryptedKey: 'enc-key',
						last4: '1234',
						createdAt: 1,
					},
				},
			})
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(jsonGet('/api/anthropic-api-key/status', headers))

			const body = await res.json()
			const serialized = JSON.stringify(body)
			expect(serialized).not.toContain('enc-key')
			expect(body).not.toHaveProperty('api_key')
			expect(body).not.toHaveProperty('encryptedKey')
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')

			const res = await app.request(jsonGet('/api/anthropic-api-key/status', headers))

			expect(res.status).toBe(403)
		})
	})

	describe('POST /api/anthropic-api-key', () => {
		it('validates and saves a valid key, returning only last4', async () => {
			mockValidate.mockResolvedValue({ ok: true, status: 200 })
			mockEncrypt.mockReturnValue({
				encryptedKey: 'enc-key',
				last4: 'abcd',
				createdAt: 1700000000000,
			})
			const workspace = buildWorkspace({ id: wsId, settings: {} })
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('POST', '/api/anthropic-api-key', { api_key: 'sk-ant-secret-abcd' }, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.success).toBe(true)
			expect(body.last4).toBe('abcd')
			expect(body.created_at).toBe(1700000000000)
			expect(mockValidate).toHaveBeenCalledWith('sk-ant-secret-abcd')
		})

		it('returns 400 when Anthropic validation fails', async () => {
			mockValidate.mockResolvedValue({
				ok: false,
				status: 401,
				message: 'invalid x-api-key',
			})
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()]]

			const res = await app.request(
				jsonRequest('POST', '/api/anthropic-api-key', { api_key: 'sk-bad' }, headers),
			)

			expect(res.status).toBe(400)
			const body = await res.json()
			expect(body.error.message).toBe('invalid x-api-key')
		})

		it('returns 400 when api_key is missing', async () => {
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()]]

			const res = await app.request(jsonRequest('POST', '/api/anthropic-api-key', {}, headers))

			expect(res.status).toBe(400)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')

			const res = await app.request(
				jsonRequest('POST', '/api/anthropic-api-key', { api_key: 'sk-x' }, headers),
			)

			expect(res.status).toBe(403)
		})
	})

	describe('DELETE /api/anthropic-api-key', () => {
		it('returns 200 when key is removed', async () => {
			const workspace = buildWorkspace({
				id: wsId,
				settings: {
					anthropic_api_key: { encryptedKey: 'enc', last4: '1234', createdAt: 1 },
				},
			})
			const { app, mockResults } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')
			mockResults.selectQueue = [[buildWorkspaceMember()], [workspace]]

			const res = await app.request(
				jsonRequest('DELETE', '/api/anthropic-api-key', undefined, headers),
			)

			expect(res.status).toBe(200)
			const body = await res.json()
			expect(body.success).toBe(true)
		})

		it('returns 403 when not a workspace member', async () => {
			const { app } = createTestApp(anthropicApiKeyRoutes, '/api/anthropic-api-key')

			const res = await app.request(
				jsonRequest('DELETE', '/api/anthropic-api-key', undefined, headers),
			)

			expect(res.status).toBe(403)
		})
	})
})
