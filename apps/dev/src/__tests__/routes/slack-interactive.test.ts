const mockGetProvider = vi.fn()
const mockListProviders = vi.fn()
vi.mock('../../lib/integrations/registry', () => ({
	getProvider: (...args: unknown[]) => mockGetProvider(...args),
	listProviders: (...args: unknown[]) => mockListProviders(...args),
}))

const mockVerify = vi.fn()
vi.mock('../../lib/integrations/webhooks/handler', () => ({
	WebhookHandler: vi.fn().mockImplementation(() => ({
		verify: (...args: unknown[]) => mockVerify(...args),
	})),
}))

const mockHandlePayload = vi.fn()
const mockParsePayload = vi.fn()
const mockDeliveryId = vi.fn()
const mockSendEphemeral = vi.fn()
vi.mock('../../lib/integrations/providers/slack/interactive', () => ({
	handleSlackInteractivePayload: (...args: unknown[]) => mockHandlePayload(...args),
	parseSlackInteractivePayload: (...args: unknown[]) => mockParsePayload(...args),
	slackInteractiveDeliveryId: (...args: unknown[]) => mockDeliveryId(...args),
	sendEphemeralResponse: (...args: unknown[]) => mockSendEphemeral(...args),
	SUPPORTED_ACTION_IDS: ['status_select', 'driver_select'],
}))

// Keep the real `ownsAccountLinkInteraction` (pure block-prefix predicate) but
// stub the dispatcher so these tests stay DB-free.
const mockDispatchAccountLink = vi.fn()
vi.mock('../../lib/integrations/providers/slack/account-link', async (importOriginal) => {
	const actual =
		await importOriginal<typeof import('../../lib/integrations/providers/slack/account-link')>()
	return {
		...actual,
		dispatchAccountLinkAction: (...args: unknown[]) => mockDispatchAccountLink(...args),
	}
})

const { webhookApp } = await import('../../routes/integrations')
const { createTestApp } = await import('../setup')

const SLACK_WEBHOOK_CONFIG = {
	signatureHeader: 'x-slack-signature',
	signatureScheme: 'timestamp',
	secretEnv: 'SLACK_SIGNING_SECRET',
	timestampHeader: 'x-slack-request-timestamp',
	timestampSignatureHeader: 'x-slack-signature',
	timestampBodyTemplate: 'v0:{timestamp}:{body}',
	timestampSignaturePrefix: 'v0=',
}

function makeInteractiveRequest(formBody: string, headers: Record<string, string> = {}) {
	return new Request('http://localhost/api/webhooks/slack-interactive', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/x-www-form-urlencoded',
			'x-slack-signature': 'v0=stub',
			'x-slack-request-timestamp': '1700000000',
			...headers,
		},
		body: formBody,
	})
}

describe('POST /api/webhooks/slack-interactive', () => {
	beforeEach(() => {
		mockGetProvider.mockReset()
		mockListProviders.mockReset()
		mockVerify.mockReset()
		mockHandlePayload.mockReset()
		mockParsePayload.mockReset()
		mockDeliveryId.mockReset()
		mockSendEphemeral.mockReset()
		mockDispatchAccountLink.mockReset()
		mockGetProvider.mockReturnValue({ config: { webhook: SLACK_WEBHOOK_CONFIG } })
	})

	it('returns 401 when signature verification fails', async () => {
		mockVerify.mockReturnValue(false)
		const { app } = createTestApp(webhookApp, '/api/webhooks')

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(401)
		const body = (await res.json()) as { error: { code: string; message: string } }
		expect(body.error.code).toBe('UNAUTHORIZED')
		expect(mockHandlePayload).not.toHaveBeenCalled()
	})

	it('returns 200 + unparseable when payload cannot be parsed', async () => {
		mockVerify.mockReturnValue(true)
		mockParsePayload.mockReturnValue(null)
		const { app } = createTestApp(webhookApp, '/api/webhooks')

		const res = await app.request(makeInteractiveRequest('payload=not-json'))

		expect(res.status).toBe(200)
		const body = (await res.json()) as { skipped?: string }
		expect(body.skipped).toBe('unparseable')
		expect(mockHandlePayload).not.toHaveBeenCalled()
	})

	it('dispatches valid payloads to the handler and acks 200', async () => {
		mockVerify.mockReturnValue(true)
		const payload = {
			type: 'block_actions',
			team: { id: 'T1' },
			user: { id: 'U1' },
			trigger_id: 'trg-1',
		}
		mockParsePayload.mockReturnValue(payload)
		mockDeliveryId.mockReturnValue('T1:trg-1')
		mockHandlePayload.mockResolvedValue({
			updated: true,
			actorId: 'actor-1',
			workspaceId: 'ws-1',
			objectId: 'obj-1',
		})

		const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
		// `webhook_deliveries` claim returns a new row (no dedup hit).
		mockResults.insert = [{ id: 'claim-1' }]

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(200)
		const body = (await res.json()) as { ok: boolean }
		expect(body.ok).toBe(true)
		expect(mockHandlePayload).toHaveBeenCalledTimes(1)
		expect(mockHandlePayload.mock.calls[0]?.[1]).toEqual(payload)
	})

	it('short-circuits on duplicate trigger_id without calling the handler', async () => {
		mockVerify.mockReturnValue(true)
		mockParsePayload.mockReturnValue({
			type: 'block_actions',
			team: { id: 'T1' },
			user: { id: 'U1' },
			trigger_id: 'trg-1',
		})
		mockDeliveryId.mockReturnValue('T1:trg-1')

		const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
		// Second click with the same trigger_id: claim returns no rows.
		mockResults.insert = []

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(200)
		const body = (await res.json()) as { skipped?: string }
		expect(body.skipped).toBe('duplicate')
		expect(mockHandlePayload).not.toHaveBeenCalled()
	})

	it('routes account-link picker actions to the link dispatcher, not the object-edit handler', async () => {
		mockVerify.mockReturnValue(true)
		const payload = {
			type: 'block_actions',
			team: { id: 'T1' },
			user: { id: 'U1' },
			trigger_id: 'trg-link-1',
			response_url: 'https://hooks.slack.test/response/xyz',
			actions: [
				{
					action_id: 'maskin_account_link:confirm',
					block_id: 'maskin_account_link:confirm:T1:U1',
				},
			],
		}
		mockParsePayload.mockReturnValue(payload)
		mockDeliveryId.mockReturnValue('T1:trg-link-1')
		mockDispatchAccountLink.mockResolvedValue({ kind: 'linked' })

		const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
		mockResults.insert = [{ id: 'claim-link-1' }]

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(200)
		expect(mockDispatchAccountLink).toHaveBeenCalledTimes(1)
		expect(mockHandlePayload).not.toHaveBeenCalled()
		expect(mockSendEphemeral).toHaveBeenCalledWith('https://hooks.slack.test/response/xyz', {
			text: 'Linked your Maskin account.',
		})
	})

	it('sends no ephemeral feedback for pre-confirm picker interactions (noop)', async () => {
		mockVerify.mockReturnValue(true)
		mockParsePayload.mockReturnValue({
			type: 'block_actions',
			team: { id: 'T1' },
			user: { id: 'U1' },
			trigger_id: 'trg-link-2',
			response_url: 'https://hooks.slack.test/response/xyz',
			actions: [
				{
					action_id: 'maskin_account_link:workspace_select',
					block_id: 'maskin_account_link:picker:T1:U1',
				},
			],
		})
		mockDeliveryId.mockReturnValue('T1:trg-link-2')
		mockDispatchAccountLink.mockResolvedValue({ kind: 'noop' })

		const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
		mockResults.insert = [{ id: 'claim-link-2' }]

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(200)
		expect(mockDispatchAccountLink).toHaveBeenCalledTimes(1)
		expect(mockSendEphemeral).not.toHaveBeenCalled()
		expect(mockHandlePayload).not.toHaveBeenCalled()
	})

	it('still acks 200 when the account-link dispatcher throws', async () => {
		mockVerify.mockReturnValue(true)
		mockParsePayload.mockReturnValue({
			type: 'block_actions',
			team: { id: 'T1' },
			user: { id: 'U1' },
			trigger_id: 'trg-link-3',
			actions: [{ action_id: 'maskin_account_link:confirm', block_id: 'maskin_account_link:x' }],
		})
		mockDeliveryId.mockReturnValue('T1:trg-link-3')
		mockDispatchAccountLink.mockRejectedValue(new Error('link boom'))

		const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
		mockResults.insert = [{ id: 'claim-link-3' }]

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(200)
		expect(mockHandlePayload).not.toHaveBeenCalled()
	})

	it('still acks 200 when the handler throws so Slack does not retry the same crash', async () => {
		mockVerify.mockReturnValue(true)
		mockParsePayload.mockReturnValue({
			type: 'block_actions',
			team: { id: 'T1' },
			user: { id: 'U1' },
			trigger_id: 'trg-2',
		})
		mockDeliveryId.mockReturnValue('T1:trg-2')
		mockHandlePayload.mockRejectedValue(new Error('downstream boom'))

		const { app, mockResults } = createTestApp(webhookApp, '/api/webhooks')
		mockResults.insert = [{ id: 'claim-2' }]

		const res = await app.request(makeInteractiveRequest('payload=%7B%7D'))

		expect(res.status).toBe(200)
	})
})
