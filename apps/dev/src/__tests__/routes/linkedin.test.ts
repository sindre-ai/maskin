import { randomBytes } from 'node:crypto'
import { afterAll, beforeAll, vi } from 'vitest'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

vi.mock('../../lib/unipile/client', async () => {
	const actual = await vi.importActual<typeof import('../../lib/unipile/client')>(
		'../../lib/unipile/client',
	)
	return {
		...actual,
		readUnipileConfig: vi.fn(),
		createHostedAuthLink: vi.fn(),
		findAccountByName: vi.fn(),
		getAccountById: vi.fn(),
		sendChatMessage: vi.fn(),
	}
})

const { trackLinkedinAccountConnectedMock, trackLinkedinMessageSentMock } = vi.hoisted(() => ({
	trackLinkedinAccountConnectedMock: vi.fn().mockResolvedValue(undefined),
	trackLinkedinMessageSentMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/linkedin-events', () => ({
	trackLinkedinAccountConnected: trackLinkedinAccountConnectedMock,
	trackLinkedinMessageSent: trackLinkedinMessageSentMock,
}))

const unipile = await import('../../lib/unipile/client')
const { default: linkedinRoutes } = await import('../../routes/linkedin')
const { encrypt } = await import('../../lib/crypto')

const wsId = '00000000-0000-0000-0000-000000000001'
const agentId = '11111111-1111-1111-1111-111111111111'
const actorId = 'test-actor-id'

const originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY
const testEncryptionKey = randomBytes(32).toString('hex')

beforeAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = testEncryptionKey
})

afterAll(() => {
	process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
})

beforeEach(() => {
	vi.mocked(unipile.readUnipileConfig).mockReset()
	vi.mocked(unipile.createHostedAuthLink).mockReset()
	vi.mocked(unipile.findAccountByName).mockReset()
	vi.mocked(unipile.getAccountById).mockReset()
	vi.mocked(unipile.sendChatMessage).mockReset()
	trackLinkedinAccountConnectedMock.mockClear()
	trackLinkedinMessageSentMock.mockClear()
})

describe('POST /api/linkedin/connect', () => {
	it('returns 501 when UNIPILE_API_KEY / UNIPILE_DSN are missing', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue(null)
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/connect',
				{ agent_id: agentId },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(501)
		const body = (await res.json()) as { message?: string }
		expect(JSON.stringify(body).toLowerCase()).toContain('unipile')
	})

	it('returns the hosted-auth URL from Unipile on success', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		vi.mocked(unipile.createHostedAuthLink).mockResolvedValue({
			url: 'https://account.unipile.com/link/abc',
		})
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.insert = [{ id: 'row-id' }]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/connect',
				{ agent_id: agentId },
				{ 'x-workspace-id': wsId },
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { url: string }
		expect(body.url).toBe('https://account.unipile.com/link/abc')
		expect(unipile.createHostedAuthLink).toHaveBeenCalledOnce()
	})

	it('rejects a request with no agent_id', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request(
			jsonRequest('POST', '/api/linkedin/connect', {}, { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(400)
	})
})

describe('GET /api/linkedin/account', () => {
	it('returns null when no row exists for the workspace', async () => {
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request(jsonGet('/api/linkedin/account', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		expect(await res.json()).toBeNull()
	})

	it('returns the account row when one exists', async () => {
		const now = new Date()
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [
			{
				id: 'acc-1',
				workspaceId: wsId,
				state: 'syncing',
				unipileAccountId: 'unipile-1',
				sendingAsName: 'sindre',
				sendingAsProviderId: 'urn:li:1',
				connectedAt: now,
				createdAt: now,
				updatedAt: now,
			},
		]
		const res = await app.request(jsonGet('/api/linkedin/account', { 'x-workspace-id': wsId }))
		expect(res.status).toBe(200)
		const body = (await res.json()) as { state: string; unipileAccountId: string }
		expect(body.state).toBe('syncing')
		expect(body.unipileAccountId).toBe('unipile-1')
	})
})

describe('GET /api/linkedin/callback', () => {
	it('rejects a request with no state parameter', async () => {
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request('/api/linkedin/callback')
		// zod-openapi rejects missing required query param as 400.
		expect(res.status).toBe(400)
	})

	it('rejects an unparseable state parameter', async () => {
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request('/api/linkedin/callback?state=not-a-real-token')
		expect(res.status).toBe(400)
	})

	it('rejects an expired state', async () => {
		const state = encrypt(
			JSON.stringify({
				workspaceId: wsId,
				actorId,
				agentId,
				nonce: 'n',
				ts: Date.now() - 30 * 60 * 1000,
			}),
		)
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ workspaceId: wsId, actorId }]
		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)
		expect(res.status).toBe(400)
		expect(trackLinkedinAccountConnectedMock).not.toHaveBeenCalled()
	})

	it('emits `linkedin_account_connected` exactly once on the first successful callback', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		vi.mocked(unipile.findAccountByName).mockResolvedValueOnce({
			object: 'Account',
			id: 'unipile-acc-1',
			connection_params: { im: { username: 'sindre', provider_id: 'urn:li:1' } },
		})
		const state = encrypt(
			JSON.stringify({ workspaceId: wsId, actorId, agentId, nonce: 'n', ts: Date.now() }),
		)
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		// Queued selects: (1) workspace membership check, (2) prior row lookup — none exists yet.
		mockResults.selectQueue = [[{ workspaceId: wsId, actorId }], []]
		mockResults.insert = [{ id: 'row-1' }]

		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain('linkedin=connected')
		expect(trackLinkedinAccountConnectedMock).toHaveBeenCalledOnce()
		expect(trackLinkedinAccountConnectedMock).toHaveBeenCalledWith({
			workspaceId: wsId,
			actorId,
			unipileAccountId: 'unipile-acc-1',
		})
	})

	it('does not emit `linkedin_account_connected` on a state-replay when the row is already syncing', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		vi.mocked(unipile.findAccountByName).mockResolvedValueOnce({
			object: 'Account',
			id: 'unipile-acc-1',
			connection_params: { im: { username: 'sindre', provider_id: 'urn:li:1' } },
		})
		const state = encrypt(
			JSON.stringify({ workspaceId: wsId, actorId, agentId, nonce: 'n', ts: Date.now() }),
		)
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		// Prior row lookup returns an already-syncing account — replay of the same URL.
		mockResults.selectQueue = [[{ workspaceId: wsId, actorId }], [{ state: 'syncing' }]]
		mockResults.insert = [{ id: 'row-1' }]

		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)

		expect(res.status).toBe(302)
		expect(trackLinkedinAccountConnectedMock).not.toHaveBeenCalled()
	})

	it('does not emit `linkedin_account_connected` when Unipile bounces back with an error param', async () => {
		const state = encrypt(
			JSON.stringify({ workspaceId: wsId, actorId, agentId, nonce: 'n', ts: Date.now() }),
		)
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ workspaceId: wsId, actorId }]

		const res = await app.request(
			`/api/linkedin/callback?error=failed&state=${encodeURIComponent(state)}`,
		)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain('linkedin=failed')
		expect(trackLinkedinAccountConnectedMock).not.toHaveBeenCalled()
	})

	it('does not emit `linkedin_account_connected` when Unipile has no record of the account', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		vi.mocked(unipile.findAccountByName).mockResolvedValueOnce(null)
		vi.mocked(unipile.getAccountById).mockResolvedValueOnce(null)
		const state = encrypt(
			JSON.stringify({ workspaceId: wsId, actorId, agentId, nonce: 'n', ts: Date.now() }),
		)
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ workspaceId: wsId, actorId }]

		const res = await app.request(`/api/linkedin/callback?state=${encodeURIComponent(state)}`)

		expect(res.status).toBe(302)
		expect(res.headers.get('location')).toContain('linkedin=not_found')
		expect(trackLinkedinAccountConnectedMock).not.toHaveBeenCalled()
	})
})

describe('POST /api/linkedin/messages', () => {
	it('sends via Unipile and emits `linkedin_message_sent` on success', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		vi.mocked(unipile.sendChatMessage).mockResolvedValue({
			chatId: 'chat-1',
			messageId: 'msg-1',
		})
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ id: 'acc-1', state: 'healthy', unipileAccountId: 'unipile-acc-1' }]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] },
				{ 'x-workspace-id': wsId },
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { chat_id: string; message_id: string }
		expect(body).toEqual({ chat_id: 'chat-1', message_id: 'msg-1' })
		expect(unipile.sendChatMessage).toHaveBeenCalledWith(
			{ apiKey: 'k', dsn: 'https://unipile.test' },
			{
				accountId: 'unipile-acc-1',
				chatId: undefined,
				attendeesProviderIds: ['urn:li:person:xyz'],
				text: 'hi',
			},
		)
		expect(trackLinkedinMessageSentMock).toHaveBeenCalledOnce()
		expect(trackLinkedinMessageSentMock).toHaveBeenCalledWith({
			workspaceId: wsId,
			actorId,
			unipileAccountId: 'unipile-acc-1',
			chatId: 'chat-1',
			messageId: 'msg-1',
		})
	})

	it('returns 501 when Unipile is not configured', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue(null)
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(501)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 404 when no LinkedIn account exists for the workspace', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		// Default mockResults.select is [] — no account row.

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] },
				{ 'x-workspace-id': wsId },
			),
		)

		expect(res.status).toBe(404)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 409 when the account is in `restricted` state', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ id: 'acc-1', state: 'restricted', unipileAccountId: 'unipile-acc-1' }]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: 'hi', attendees_provider_ids: ['urn:li:person:xyz'] },
				{ 'x-workspace-id': wsId },
			),
		)

		expect(res.status).toBe(409)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 409 when the account is in `reconnect` state', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ id: 'acc-1', state: 'reconnect', unipileAccountId: 'unipile-acc-1' }]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: 'hi', chat_id: 'chat-1' },
				{ 'x-workspace-id': wsId },
			),
		)

		expect(res.status).toBe(409)
		expect(unipile.sendChatMessage).not.toHaveBeenCalled()
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('returns 502 and does NOT emit when Unipile rejects the send', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		vi.mocked(unipile.sendChatMessage).mockRejectedValue(
			new unipile.UnipileApiError(500, '/api/v1/chats', 'boom'),
		)
		const { app, mockResults } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		mockResults.select = [{ id: 'acc-1', state: 'syncing', unipileAccountId: 'unipile-acc-1' }]

		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: 'hi', chat_id: 'chat-1' },
				{ 'x-workspace-id': wsId },
			),
		)

		expect(res.status).toBe(502)
		expect(trackLinkedinMessageSentMock).not.toHaveBeenCalled()
	})

	it('rejects a request with neither chat_id nor attendees_provider_ids', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request(
			jsonRequest('POST', '/api/linkedin/messages', { text: 'hi' }, { 'x-workspace-id': wsId }),
		)
		expect(res.status).toBe(400)
	})

	it('rejects a request with empty text', async () => {
		vi.mocked(unipile.readUnipileConfig).mockReturnValue({
			apiKey: 'k',
			dsn: 'https://unipile.test',
		})
		const { app } = createTestApp(linkedinRoutes, '/api/linkedin', actorId)
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/linkedin/messages',
				{ text: '', attendees_provider_ids: ['x'] },
				{ 'x-workspace-id': wsId },
			),
		)
		expect(res.status).toBe(400)
	})
})
