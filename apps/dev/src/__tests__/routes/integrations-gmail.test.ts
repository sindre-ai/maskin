import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/logger', () => ({
	logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}))

const { getIntegrationCredential, getValidToken, getDraftSummary, sendDraft, recordEvent } =
	vi.hoisted(() => ({
		getIntegrationCredential: vi.fn(),
		getValidToken: vi.fn(),
		getDraftSummary: vi.fn(),
		sendDraft: vi.fn(),
		recordEvent: vi.fn(),
	}))

vi.mock('../../lib/integrations/lookup', () => ({ getIntegrationCredential }))

vi.mock('../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidToken
	},
}))

vi.mock('../../lib/integrations/registry', () => ({ getProvider: vi.fn(() => ({})) }))

vi.mock('../../lib/integrations/providers/gmail/send', async () => {
	const actual = await vi.importActual<
		typeof import('../../lib/integrations/providers/gmail/send')
	>('../../lib/integrations/providers/gmail/send')
	return { ...actual, getDraftSummary, sendDraft }
})

vi.mock('../../lib/events/record-event', () => ({ recordEvent }))

import { IntegrationAuthRevokedError } from '../../lib/integrations/errors'
import { GmailSendError } from '../../lib/integrations/providers/gmail/send'
import { jsonGet, jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

const { default: routes } = await import('../../routes/integrations-gmail')

const WORKSPACE = '3f7c1e2a-9b4d-4f21-8c6e-5a0d7b91e442'
const INTEGRATION = 'c1d2e3f4-a5b6-4c7d-8e9f-0a1b2c3d4e5f'
const HEADERS = { 'X-Workspace-Id': WORKSPACE }

function app(actorType = 'human') {
	return createTestApp(routes, '/api/integrations/gmail', 'actor-1', actorType).app
}

beforeEach(() => {
	for (const fn of [
		getIntegrationCredential,
		getValidToken,
		getDraftSummary,
		sendDraft,
		recordEvent,
	]) {
		fn.mockReset()
	}
	getIntegrationCredential.mockResolvedValue({ id: INTEGRATION })
	getValidToken.mockResolvedValue('tok')
	recordEvent.mockResolvedValue(undefined)
})

const sendRequest = (body: unknown = { message_id: 'm1' }) =>
	jsonRequest('POST', '/api/integrations/gmail/drafts/d1/send', body, HEADERS)

describe('POST /api/integrations/gmail/drafts/:draftId/send', () => {
	it('sends the draft and records who sent it', async () => {
		sendDraft.mockResolvedValue({ messageId: 'sent-1', threadId: 't1' })

		const res = await app().request(sendRequest())

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ message_id: 'sent-1', thread_id: 't1' })
		expect(sendDraft).toHaveBeenCalledWith('tok', 'd1', 'm1')
		expect(recordEvent).toHaveBeenCalledWith(
			expect.anything(),
			expect.objectContaining({
				workspaceId: WORKSPACE,
				actorId: 'actor-1',
				entityType: 'integration',
				entityId: INTEGRATION,
				data: expect.objectContaining({ gmail_action: 'draft_sent', message_id: 'sent-1' }),
			}),
		)
	})

	it('refuses an agent and never touches Gmail', async () => {
		const res = await app('agent').request(sendRequest())

		expect(res.status).toBe(403)
		expect(sendDraft).not.toHaveBeenCalled()
		expect(getIntegrationCredential).not.toHaveBeenCalled()
	})

	it('returns 409 when the draft changed after it was shown', async () => {
		sendDraft.mockRejectedValue(new GmailSendError('DRAFT_CHANGED', 'edited', 409))

		const res = await app().request(sendRequest())

		expect(res.status).toBe(409)
		expect(recordEvent).not.toHaveBeenCalled()
	})

	it('returns 404 when the draft is gone', async () => {
		sendDraft.mockRejectedValue(new GmailSendError('DRAFT_NOT_FOUND', 'gone', 404))

		expect((await app().request(sendRequest())).status).toBe(404)
	})

	it('returns 404 when Gmail is not connected', async () => {
		getIntegrationCredential.mockResolvedValue(null)

		expect((await app().request(sendRequest())).status).toBe(404)
		expect(sendDraft).not.toHaveBeenCalled()
	})

	it('asks for a reconnect when the Gmail grant was revoked', async () => {
		getValidToken.mockRejectedValue(new IntegrationAuthRevokedError('revoked'))

		const res = await app().request(sendRequest())

		expect(res.status).toBe(409)
		expect(sendDraft).not.toHaveBeenCalled()
	})

	it('still reports success when only the audit event fails', async () => {
		sendDraft.mockResolvedValue({ messageId: 'sent-1', threadId: null })
		recordEvent.mockRejectedValue(new Error('db down'))

		const res = await app().request(sendRequest())

		expect(res.status).toBe(200)
	})

	it('rejects a body without message_id', async () => {
		const res = await app().request(sendRequest({}))

		expect(res.status).toBe(400)
		expect(sendDraft).not.toHaveBeenCalled()
	})
})

describe('GET /api/integrations/gmail/drafts/:draftId', () => {
	it('returns the draft for review', async () => {
		getDraftSummary.mockResolvedValue({
			draftId: 'd1',
			messageId: 'm1',
			threadId: 't1',
			to: 'ada@example.com',
			cc: '',
			subject: 'Intro',
			snippet: 'Hi',
		})

		const res = await app().request(jsonGet('/api/integrations/gmail/drafts/d1', HEADERS))

		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({
			draft_id: 'd1',
			message_id: 'm1',
			to: 'ada@example.com',
		})
	})

	it('refuses an agent', async () => {
		const res = await app('agent').request(jsonGet('/api/integrations/gmail/drafts/d1', HEADERS))

		expect(res.status).toBe(403)
		expect(getDraftSummary).not.toHaveBeenCalled()
	})
})
