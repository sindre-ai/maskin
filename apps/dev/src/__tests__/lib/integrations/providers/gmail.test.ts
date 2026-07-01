import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { config } from '../../../../lib/integrations/providers/gmail/config'
import { resolveExternalId } from '../../../../lib/integrations/providers/gmail/resolve-id'
import {
	gmailEventNormalizer,
	gmailWebhookVerifier,
} from '../../../../lib/integrations/providers/gmail/webhooks'
import type { StoredCredentials } from '../../../../lib/integrations/types'

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
			expect(config.auth.config.scopes).toContain('https://www.googleapis.com/auth/gmail.readonly')
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

	it('defines gmail.message events with sent/received/drafted actions', () => {
		const types = config.events?.definitions.map((d) => d.entityType)
		expect(types).toContain('gmail.message')
		expect(types).not.toContain('gmail.thread')
		const messageDef = config.events?.definitions.find((d) => d.entityType === 'gmail.message')
		expect(messageDef?.actions).toEqual(
			expect.arrayContaining(['received', 'sent', 'drafted', 'labeled', 'unlabeled']),
		)
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
			'Google userinfo response missing email field',
		)
	})

	it('throws on HTTP error', async () => {
		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: () => Promise.resolve('unauthorized'),
		} as Response)

		await expect(resolveExternalId({ accessToken: 'expired' })).rejects.toThrow(
			'Failed to resolve Google account email: HTTP 401',
		)
	})

	it('throws early without calling fetch when accessToken is absent', async () => {
		const fetchSpy = vi.spyOn(globalThis, 'fetch')

		await expect(resolveExternalId({})).rejects.toThrow(
			'Cannot resolve Google account email: no access token in credentials',
		)
		expect(fetchSpy).not.toHaveBeenCalled()
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

// ── Watch lifecycle (renew + stop) ────────────────────────────────────────────

/** Recursively flatten a drizzle SQL fragment (or any value) into a single string for inspection. */
function sqlToString(value: unknown): string {
	if (value == null) return ''
	if (typeof value === 'string') return value
	if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint')
		return String(value)
	if (Array.isArray(value)) return value.map(sqlToString).join(' ')
	if (typeof value === 'object') {
		const obj = value as Record<string, unknown>
		// drizzle SQL fragment
		if ('queryChunks' in obj) return sqlToString(obj.queryChunks)
		// drizzle Param wrapper
		if ('value' in obj && Object.keys(obj).length <= 3) return sqlToString(obj.value)
		// drizzle Column reference — emit its name so tests can grep for it without
		// recursing into PgTable's circular column graph.
		const ctorName = obj.constructor?.name ?? ''
		if (ctorName.startsWith('Pg') || 'table' in obj) {
			const name = (obj as { name?: string }).name
			return name ? `<col:${name}>` : `<${ctorName}>`
		}
		try {
			return JSON.stringify(obj)
		} catch {
			return `<${ctorName}>`
		}
	}
	return String(value)
}

const getValidTokenMock = vi.hoisted(() => vi.fn())
vi.mock('../../../../lib/integrations/oauth/token-manager', () => ({
	TokenManager: class {
		getValidToken = getValidTokenMock
	},
}))

vi.mock('../../../../lib/integrations/registry', () => ({
	getProvider: vi.fn(() => ({ config: { name: 'gmail' } })),
}))

interface FakeIntegrationRow {
	id: string
	provider: string
	workspaceId: string
	config: { gmail?: { historyId: string; watchExpiresAt: number; topicName: string } } | null
}

function makeFakeDb(row: FakeIntegrationRow | null) {
	const updateCalls: Array<{ values: unknown }> = []
	const db = {
		select: () => ({
			from: () => ({
				where: () => ({
					limit: () => Promise.resolve(row ? [row] : []),
				}),
			}),
		}),
		update: () => ({
			set: (values: unknown) => {
				updateCalls.push({ values })
				return {
					where: () => Promise.resolve(),
				}
			},
		}),
	}
	return { db, updateCalls }
}

describe('renewGmailWatch', () => {
	const ORIGINAL_TOPIC = process.env.GMAIL_PUBSUB_TOPIC

	beforeEach(() => {
		process.env.GMAIL_PUBSUB_TOPIC = 'projects/sindre-430307/topics/gmail-push'
		getValidTokenMock.mockReset().mockResolvedValue('ya29.access')
	})

	afterEach(() => {
		process.env.GMAIL_PUBSUB_TOPIC = ORIGINAL_TOPIC
		vi.restoreAllMocks()
	})

	it('preserves the existing historyId cursor when renewing', async () => {
		const { renewGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ historyId: '99999', expiration: '1800000000000' }),
		} as Response)

		const { db, updateCalls } = makeFakeDb({
			id: 'int-1',
			provider: 'gmail',
			workspaceId: 'ws-1',
			config: {
				gmail: {
					historyId: '12345',
					watchExpiresAt: 1700000000000,
					topicName: 'projects/sindre-430307/topics/gmail-push',
				},
			},
		})

		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		await renewGmailWatch(db as any, 'int-1')

		expect(fetchSpy).toHaveBeenCalledWith(
			'https://gmail.googleapis.com/gmail/v1/users/me/watch',
			expect.objectContaining({ method: 'POST' }),
		)
		expect(updateCalls).toHaveLength(1)
		// Renewer writes a jsonb_set SQL fragment that only touches watchExpiresAt and
		// topicName — never historyId — so a concurrent fan-out advancing the cursor
		// is not clobbered. Inspect the SQL chunks rather than a plain merged object.
		const config = (updateCalls[0]?.values as { config: unknown }).config
		const flat = sqlToString(config)
		expect(flat).toContain('jsonb_set')
		expect(flat).toContain('watchExpiresAt')
		expect(flat).toContain('topicName')
		expect(flat).toContain('1800000000000') // new expiration bound as param
		expect(flat).toContain('projects/sindre-430307/topics/gmail-push')
		// Critical: the SQL fragment must NOT write a historyId path.
		expect(flat).not.toContain('historyId')
		// And must NOT carry the new historyId returned by users.watch.
		expect(flat).not.toContain('99999')
	})

	it('falls back to initial setup when no prior cursor exists', async () => {
		const { renewGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			json: () => Promise.resolve({ historyId: '50000', expiration: '1800000000000' }),
		} as Response)

		const { db, updateCalls } = makeFakeDb({
			id: 'int-2',
			provider: 'gmail',
			workspaceId: 'ws-1',
			config: null,
		})

		// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
		await renewGmailWatch(db as any, 'int-2')

		// Initial setup writes the watch's returned historyId as the cursor via jsonb_set.
		const config = (updateCalls[0]?.values as { config: unknown }).config
		const flat = sqlToString(config)
		expect(flat).toContain('jsonb_set')
		expect(flat).toContain('"historyId":"50000"')
		expect(flat).toContain('"watchExpiresAt":1800000000000')
	})

	it('throws if users.watch returns a non-finite expiration (NaN guard)', async () => {
		const { renewGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 200,
			// Malformed expiration that would silently coerce to NaN under Number(...)
			json: () => Promise.resolve({ historyId: '99999', expiration: 'not-a-number' }),
		} as Response)

		const { db, updateCalls } = makeFakeDb({
			id: 'int-bad',
			provider: 'gmail',
			workspaceId: 'ws-1',
			config: {
				gmail: { historyId: '12345', watchExpiresAt: 1700000000000, topicName: 't' },
			},
		})

		await expect(
			// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
			renewGmailWatch(db as any, 'int-bad'),
		).rejects.toThrow(/invalid expiration/)

		// Critically: nothing was written, so a stale NaN can't poison the row.
		expect(updateCalls).toHaveLength(0)
	})
})

describe('stopGmailWatch', () => {
	beforeEach(() => {
		getValidTokenMock.mockReset().mockResolvedValue('ya29.access')
	})

	afterEach(() => {
		vi.restoreAllMocks()
	})

	it('calls users.stop with a valid bearer token', async () => {
		const { stopGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: true,
			status: 204,
			text: () => Promise.resolve(''),
		} as Response)

		const { db } = makeFakeDb({
			id: 'int-3',
			provider: 'gmail',
			workspaceId: 'ws-1',
			config: { gmail: { historyId: '1', watchExpiresAt: 0, topicName: 't' } },
		})

		await stopGmailWatch({
			// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
			db: db as any,
			integrationId: 'int-3',
			workspaceId: 'ws-1',
			credentials: {} as StoredCredentials,
		})

		expect(fetchSpy).toHaveBeenCalledWith(
			'https://gmail.googleapis.com/gmail/v1/users/me/stop',
			expect.objectContaining({
				method: 'POST',
				headers: { Authorization: 'Bearer ya29.access' },
			}),
		)
	})

	it('treats 404 (no active watch) as success and does not throw', async () => {
		const { stopGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 404,
			text: () => Promise.resolve('Not Found'),
		} as Response)

		const { db } = makeFakeDb({
			id: 'int-4',
			provider: 'gmail',
			workspaceId: 'ws-1',
			config: null,
		})

		await expect(
			stopGmailWatch({
				// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
				db: db as any,
				integrationId: 'int-4',
				workspaceId: 'ws-1',
				credentials: {} as StoredCredentials,
			}),
		).resolves.toBeUndefined()
	})

	it('swallows non-404 errors so disconnect can proceed', async () => {
		const { stopGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce({
			ok: false,
			status: 500,
			text: () => Promise.resolve('boom'),
		} as Response)

		const { db } = makeFakeDb({
			id: 'int-5',
			provider: 'gmail',
			workspaceId: 'ws-1',
			config: null,
		})

		await expect(
			stopGmailWatch({
				// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
				db: db as any,
				integrationId: 'int-5',
				workspaceId: 'ws-1',
				credentials: {} as StoredCredentials,
			}),
		).resolves.toBeUndefined()
	})

	it('is a no-op when the integration row is missing', async () => {
		const { stopGmailWatch } = await import('../../../../lib/integrations/providers/gmail/watch')

		const fetchSpy = vi.spyOn(globalThis, 'fetch')
		const { db } = makeFakeDb(null)

		await stopGmailWatch({
			// biome-ignore lint/suspicious/noExplicitAny: test fake doesn't need full Database type
			db: db as any,
			integrationId: 'missing',
			workspaceId: 'ws-1',
			credentials: {} as StoredCredentials,
		})

		expect(fetchSpy).not.toHaveBeenCalled()
	})
})
