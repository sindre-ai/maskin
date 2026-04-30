import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/gmail/config'
import { resolveExternalId } from '../../../../lib/integrations/providers/gmail/resolve-id'
import {
	gmailEventNormalizer,
	gmailWebhookVerifier,
} from '../../../../lib/integrations/providers/gmail/webhooks'

describe('Gmail provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('gmail')
		expect(config.displayName).toBe('Gmail')
	})

	it('uses standard oauth2 with PKCE and offline access', () => {
		expect(config.auth.type).toBe('oauth2')
		if (config.auth.type === 'oauth2') {
			expect(config.auth.config.authorizationUrl).toBe(
				'https://accounts.google.com/o/oauth2/v2/auth',
			)
			expect(config.auth.config.tokenUrl).toBe('https://oauth2.googleapis.com/token')
			expect(config.auth.config.revokeUrl).toBe('https://oauth2.googleapis.com/revoke')
			expect(config.auth.config.clientIdEnv).toBe('GMAIL_CLIENT_ID')
			expect(config.auth.config.clientSecretEnv).toBe('GMAIL_CLIENT_SECRET')
			expect(config.auth.config.pkce).toBe(true)
			expect(config.auth.config.scopes).toContain('https://www.googleapis.com/auth/gmail.modify')
			expect(config.auth.config.scopes).toContain('https://www.googleapis.com/auth/gmail.compose')
			expect(config.auth.config.scopes).toContain('https://www.googleapis.com/auth/userinfo.email')
			expect(config.auth.config.extraAuthParams).toMatchObject({
				access_type: 'offline',
				prompt: 'consent',
			})
		}
	})

	it('uses custom webhook type for Pub/Sub push', () => {
		expect(config.webhook).toEqual({ type: 'custom' })
	})

	it('exposes GMAIL_TOKEN as MCP envKey', () => {
		expect(config.mcp?.envKey).toBe('GMAIL_TOKEN')
	})

	it('defines gmail.message and gmail.thread events', () => {
		const types = config.events?.definitions.map((d) => d.entityType)
		expect(types).toContain('gmail.message')
		expect(types).toContain('gmail.thread')
	})
})

describe('resolveExternalId', () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('returns email from Google userinfo', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({ email: 'magnus@example.com' }),
		} as Response)

		const id = await resolveExternalId({ accessToken: 'ya29.a0test' })
		expect(id).toBe('magnus@example.com')
		expect(globalThis.fetch).toHaveBeenCalledWith(
			'https://www.googleapis.com/oauth2/v2/userinfo',
			expect.objectContaining({
				headers: { Authorization: 'Bearer ya29.a0test' },
			}),
		)
	})

	it('throws when userinfo response is missing email', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			json: () => Promise.resolve({}),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'tok' })).rejects.toThrow(
			'Gmail userinfo response missing email',
		)
	})

	it('throws on HTTP error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: () => Promise.resolve('unauthorized'),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'expired' })).rejects.toThrow(
			'Failed to resolve Gmail email: HTTP 401',
		)
	})
})

function makeEnvelope(emailAddress: string, historyId: string): unknown {
	const data = Buffer.from(JSON.stringify({ emailAddress, historyId })).toString('base64')
	return {
		subscription: 'projects/sindre-430307/subscriptions/gmail-sub',
		message: { data, messageId: 'msg-1', publishTime: '2026-04-29T10:00:00Z' },
	}
}

describe('gmailEventNormalizer', () => {
	it('normalizes a valid Pub/Sub envelope into gmail.history.updated', () => {
		const result = gmailEventNormalizer(makeEnvelope('magnus@example.com', '987654321'), {})

		expect(result).toEqual({
			entityType: 'gmail.history',
			action: 'updated',
			installationId: 'magnus@example.com',
			data: {
				historyId: '987654321',
				emailAddress: 'magnus@example.com',
				subscription: 'projects/sindre-430307/subscriptions/gmail-sub',
			},
		})
	})

	it('coerces numeric historyId from decoded payload to string', () => {
		const data = Buffer.from(
			JSON.stringify({ emailAddress: 'a@b.com', historyId: 12345 }),
		).toString('base64')
		const envelope = {
			subscription: 'projects/x/subscriptions/y',
			message: { data },
		}
		const result = gmailEventNormalizer(envelope, {})
		expect(result?.data.historyId).toBe('12345')
	})

	it('returns null when envelope is malformed', () => {
		expect(gmailEventNormalizer({ foo: 'bar' }, {})).toBeNull()
	})

	it('returns null when message.data is not base64-decodable JSON', () => {
		const envelope = {
			subscription: 'projects/x/subscriptions/y',
			message: { data: 'not-base64-json!!' },
		}
		expect(gmailEventNormalizer(envelope, {})).toBeNull()
	})

	it('returns null when decoded payload is missing emailAddress', () => {
		const data = Buffer.from(JSON.stringify({ historyId: '1' })).toString('base64')
		const envelope = {
			subscription: 'projects/x/subscriptions/y',
			message: { data },
		}
		expect(gmailEventNormalizer(envelope, {})).toBeNull()
	})
})

describe('gmailWebhookVerifier', () => {
	const ORIGINAL_AUDIENCE = process.env.GMAIL_PUBSUB_AUDIENCE
	const ORIGINAL_SA = process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT

	beforeEach(() => {
		process.env.GMAIL_PUBSUB_AUDIENCE = 'https://maskin.example/api/webhooks/gmail'
		process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT = 'gmail-push@sindre-430307.iam.gserviceaccount.com'
	})

	afterEach(() => {
		process.env.GMAIL_PUBSUB_AUDIENCE = ORIGINAL_AUDIENCE
		process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT = ORIGINAL_SA
		vi.restoreAllMocks()
	})

	it('rejects requests without a Bearer token', async () => {
		expect(await gmailWebhookVerifier('{}', {})).toBe(false)
	})

	it('rejects requests when GMAIL_PUBSUB_AUDIENCE is not configured', async () => {
		process.env.GMAIL_PUBSUB_AUDIENCE = ''
		expect(await gmailWebhookVerifier('{}', { authorization: 'Bearer fake.jwt.token' })).toBe(false)
	})

	it('rejects requests when GMAIL_PUBSUB_SERVICE_ACCOUNT is not configured', async () => {
		process.env.GMAIL_PUBSUB_SERVICE_ACCOUNT = ''
		expect(await gmailWebhookVerifier('{}', { authorization: 'Bearer fake.jwt.token' })).toBe(false)
	})

	it('rejects requests with an invalid JWT', async () => {
		// google-auth-library will fail to verify a fake token
		const result = await gmailWebhookVerifier('{}', {
			authorization: 'Bearer not.a.real.jwt.token',
		})
		expect(result).toBe(false)
	})

	it('rejects when JWT email claim does not match configured push service account', async () => {
		const oauth2 = await import('google-auth-library')
		vi.spyOn(oauth2.OAuth2Client.prototype, 'verifyIdToken').mockResolvedValueOnce({
			getPayload: () => ({
				iss: 'https://accounts.google.com',
				email: 'attacker@evil.iam.gserviceaccount.com',
				email_verified: true,
				aud: 'https://maskin.example/api/webhooks/gmail',
			}),
		} as unknown as Awaited<ReturnType<typeof oauth2.OAuth2Client.prototype.verifyIdToken>>)

		const result = await gmailWebhookVerifier('{}', {
			authorization: 'Bearer signed.but.wrong.caller',
		})
		expect(result).toBe(false)
	})

	it('rejects when email_verified is not true', async () => {
		const oauth2 = await import('google-auth-library')
		vi.spyOn(oauth2.OAuth2Client.prototype, 'verifyIdToken').mockResolvedValueOnce({
			getPayload: () => ({
				iss: 'https://accounts.google.com',
				aud: 'https://maskin.example/api/webhooks/gmail',
				email: 'gmail-push@sindre-430307.iam.gserviceaccount.com',
				email_verified: false,
			}),
		} as unknown as Awaited<ReturnType<typeof oauth2.OAuth2Client.prototype.verifyIdToken>>)

		const result = await gmailWebhookVerifier('{}', { authorization: 'Bearer x.y.z' })
		expect(result).toBe(false)
	})

	it('accepts a valid JWT from the configured push service account', async () => {
		const oauth2 = await import('google-auth-library')
		vi.spyOn(oauth2.OAuth2Client.prototype, 'verifyIdToken').mockResolvedValueOnce({
			getPayload: () => ({
				iss: 'https://accounts.google.com',
				email: 'gmail-push@sindre-430307.iam.gserviceaccount.com',
				email_verified: true,
				aud: 'https://maskin.example/api/webhooks/gmail',
			}),
		} as unknown as Awaited<ReturnType<typeof oauth2.OAuth2Client.prototype.verifyIdToken>>)

		const result = await gmailWebhookVerifier('{}', {
			authorization: 'Bearer signed.legit.token',
		})
		expect(result).toBe(true)
	})
})
