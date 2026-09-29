import { randomBytes } from 'node:crypto'
import { promises as dns } from 'node:dns'
import { integrations } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, beforeEach, vi } from 'vitest'
import { decrypt } from '../../lib/crypto'
import type { ResolvedProvider } from '../../lib/integrations/types'
import { logger } from '../../lib/logger'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// Task 1 registers the real resend provider config; until that PR lands we
// mock the registry so tests exercise this task's /connect body-branch and
// /complete merge in isolation. The mock only supplies the shape needed to
// unlock the manual branch — Task 1's config carries the same auth.type.
vi.mock('../../lib/integrations/registry', async () => {
	const actual = await vi.importActual<typeof import('../../lib/integrations/registry')>(
		'../../lib/integrations/registry',
	)
	return {
		...actual,
		getProvider: vi.fn(actual.getProvider),
	}
})

const { getProvider } = await import('../../lib/integrations/registry')
const { default: integrationsRoutes } = await import('../../routes/integrations')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations', module: integrationsRoutes })
}

function resendProvider(): ResolvedProvider {
	return {
		config: {
			name: 'resend',
			displayName: 'Resend',
			description: 'Resend for tests',
			auth: { type: 'manual' },
			events: {
				definitions: [{ entityType: 'resend.email', actions: ['received'], label: 'Email' }],
			},
		},
	} as unknown as ResolvedProvider
}

function jsonPost(path: string, body: unknown, headers: Record<string, string> = {}) {
	return new Request(`http://localhost${path}`, {
		method: 'POST',
		headers: { 'Content-Type': 'application/json', ...headers },
		body: JSON.stringify(body),
	})
}

const RESEND_DOMAIN_RESPONSE = {
	id: 'd_test_abc123',
	name: 'mail.example.com',
	status: 'not_started',
	capabilities: { sending: 'pending', receiving: 'pending' },
	records: [
		{
			record: 'SPF',
			type: 'TXT',
			name: 'mail.example.com',
			value: 'v=spf1 include:_spf.resend.com -all',
			status: 'pending',
		},
		{
			record: 'DKIM',
			type: 'TXT',
			name: 'resend._domainkey.mail.example.com',
			value: 'p=MIGfMA0GCSqGSIb3DQEBAQ...',
			status: 'pending',
		},
		{
			record: 'MX',
			type: 'MX',
			name: 'mail.example.com',
			value: 'feedback-smtp.eu-west-1.amazonses.com',
			priority: 10,
			status: 'pending',
		},
	],
}

// A single global fetch spy — each test installs its own responder chain via
// mockImplementation. Restored after each test so unrelated fetches (dns,
// dev-server bootstrap) can't leak across tests.
let fetchSpy: ReturnType<typeof vi.spyOn>

const originalEncryptionKey = process.env.INTEGRATION_ENCRYPTION_KEY

beforeAll(() => {
	// createDb is already up per global-setup; we just need an encryption key
	// so encrypt()/decrypt() work when the row is read back.
	if (!process.env.INTEGRATION_ENCRYPTION_KEY) {
		process.env.INTEGRATION_ENCRYPTION_KEY = randomBytes(32).toString('hex')
	}
})

afterAll(() => {
	if (originalEncryptionKey === undefined) {
		Reflect.deleteProperty(process.env, 'INTEGRATION_ENCRYPTION_KEY')
	} else {
		process.env.INTEGRATION_ENCRYPTION_KEY = originalEncryptionKey
	}
})

beforeEach(() => {
	fetchSpy = vi.spyOn(globalThis, 'fetch')
	vi.mocked(getProvider).mockImplementation((name: string) => {
		if (name === 'resend') return resendProvider()
		throw new Error(`unknown provider ${name}`)
	})
})

afterEach(() => {
	fetchSpy.mockRestore()
	vi.mocked(getProvider).mockReset()
})

describe('POST /api/integrations/resend/connect — two-call handshake', () => {
	it('registers the domain, seeds credentials + config.resend, and returns dns records', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		// Sequence responses: first call is the verify (GET /domains), second is
		// the register (POST /domains) — Resend uses the same URL for both.
		let callCount = 0
		fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
			callCount++
			if (init?.method === 'POST') {
				return new Response(JSON.stringify(RESEND_DOMAIN_RESPONSE), { status: 200 })
			}
			if (callCount === 1) {
				return new Response(JSON.stringify({ data: [] }), { status: 200 })
			}
			return new Response('not-mocked', { status: 500 })
		})

		const res = await buildApp().request(
			jsonPost(
				'/api/integrations/resend/connect',
				{ api_key: 're_test_valid_key', receive_subdomain: 'mail.example.com' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			integration_id: string
			webhook_url: string
			dns_records: Array<{ record: string; type: string; status: string; priority?: number }>
			verification_status: string
		}
		expect(body.integration_id).toMatch(/^[0-9a-f-]{36}$/)
		expect(body.verification_status).toBe('pending')
		expect(body.dns_records).toHaveLength(3)
		expect(body.dns_records.find((r) => r.record === 'MX')?.priority).toBe(10)

		const [row] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, body.integration_id))

		expect(row.status).toBe('awaiting_secret')
		expect(row.externalId).toMatch(/^[0-9a-f]{48}$/)
		expect(row.provider).toBe('resend')
		expect(body.webhook_url).toBe(`http://localhost/api/webhooks/resend/${row.externalId}`)

		const decryptedCreds = JSON.parse(decrypt(row.credentials)) as {
			accessToken: string
			webhookSecret?: string
		}
		expect(decryptedCreds.accessToken).toBe('re_test_valid_key')
		expect(decryptedCreds.webhookSecret).toBeUndefined()

		const cfg = row.config as {
			resend?: {
				receive_subdomain: string
				resend_domain_id: string
				verification_status: string
				last_polled_at: null
				webhook_url: string
				dns_records: unknown[]
				capabilities: unknown
				verification_error: null
			}
		}
		expect(cfg.resend?.receive_subdomain).toBe('mail.example.com')
		expect(cfg.resend?.resend_domain_id).toBe('d_test_abc123')
		expect(cfg.resend?.verification_status).toBe('pending')
		expect(cfg.resend?.last_polled_at).toBeNull()
		expect(cfg.resend?.webhook_url).toBe(body.webhook_url)
		expect(cfg.resend?.dns_records).toHaveLength(3)
		expect(cfg.resend?.verification_error).toBeNull()
	})

	it('returns 400 INVALID_API_KEY and inserts no row when Resend rejects the key with 401', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		fetchSpy.mockImplementation(async () => {
			return new Response(JSON.stringify({ name: 'unauthorized' }), { status: 401 })
		})

		const res = await buildApp().request(
			jsonPost(
				'/api/integrations/resend/connect',
				{ api_key: 're_test_bad', receive_subdomain: 'mail.example.com' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; details?: Array<{ field: string; message: string }> }
		}
		expect(body.error.details).toEqual(
			expect.arrayContaining([{ field: 'code', message: 'INVALID_API_KEY' }]),
		)

		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})

	it('returns 400 DOMAIN_ALREADY_CLAIMED and inserts no row when Resend rejects the subdomain', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		let call = 0
		fetchSpy.mockImplementation(async (_url: RequestInfo | URL, init?: RequestInit) => {
			call++
			if (call === 1 && init?.method !== 'POST') {
				return new Response(JSON.stringify({ data: [] }), { status: 200 })
			}
			return new Response(JSON.stringify({ name: 'domain_already_verified' }), { status: 409 })
		})

		const res = await buildApp().request(
			jsonPost(
				'/api/integrations/resend/connect',
				{ api_key: 're_test_valid', receive_subdomain: 'mail.example.com' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(400)
		const body = (await res.json()) as {
			error: { code: string; details?: Array<{ field: string; message: string }> }
		}
		expect(body.error.details).toEqual(
			expect.arrayContaining([{ field: 'code', message: 'DOMAIN_ALREADY_CLAIMED' }]),
		)

		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows).toHaveLength(0)
	})

	it('falls through to Skjald behaviour verbatim when the resend body is absent (non-resend provider)', async () => {
		vi.mocked(getProvider).mockImplementation((name: string) => {
			if (name === 'skjald') {
				return {
					config: {
						name: 'skjald',
						displayName: 'Skjald',
						description: 'Skjald for tests',
						auth: { type: 'manual' },
						events: { definitions: [] },
					},
				} as unknown as ResolvedProvider
			}
			throw new Error(`unknown provider ${name}`)
		})

		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const res = await buildApp().request(
			new Request('http://localhost/api/integrations/skjald/connect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'x-workspace-id': ws.id },
				// no body → Skjald path
			}),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as { webhook_url: string; integration_id: string }
		const [row] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, body.integration_id))

		expect(row.provider).toBe('skjald')
		expect(row.status).toBe('awaiting_secret')
		expect(row.credentials).toBe('') // raw empty — no resend JSON blob
		const cfg = row.config as { resend?: unknown; system_actor_id?: string }
		expect(cfg.resend).toBeUndefined()
		expect(typeof cfg.system_actor_id).toBe('string')
	})
})

describe('POST /api/integrations/:id/complete — parse-then-merge fallback', () => {
	it('merges webhookSecret into a resend row seeded with an accessToken JSON blob', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		// Seed the row directly in the shape /connect would have written.
		const { encrypt } = await import('../../lib/crypto')
		const seededCreds = encrypt(JSON.stringify({ accessToken: 're_seeded_key' }))
		const [seeded] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'resend',
				status: 'awaiting_secret',
				externalId: randomBytes(24).toString('hex'),
				credentials: seededCreds,
				config: { system_actor_id: actorId, resend: { receive_subdomain: 'mail.example.com' } },
				createdBy: actorId,
			})
			.returning()

		// The endpoint-cap fetch after /complete succeeds — return 3 webhooks
		// (below Pro ceiling of 5, so no warn log fires).
		fetchSpy.mockImplementation(async () => {
			return new Response(JSON.stringify({ data: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }] }), {
				status: 200,
			})
		})

		const res = await buildApp().request(
			jsonPost(
				`/api/integrations/${seeded.id}/complete`,
				{ secret: 'whsec_test_webhook_secret' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, seeded.id))
		expect(row.status).toBe('active')
		const parsed = JSON.parse(decrypt(row.credentials)) as {
			accessToken: string
			webhookSecret: string
		}
		expect(parsed.accessToken).toBe('re_seeded_key')
		expect(parsed.webhookSecret).toBe('whsec_test_webhook_secret')
	})

	it('stores the raw string when the row was seeded Skjald-style (no JSON blob)', async () => {
		vi.mocked(getProvider).mockImplementation((name: string) => {
			if (name === 'skjald') {
				return {
					config: {
						name: 'skjald',
						displayName: 'Skjald',
						auth: { type: 'manual' },
						events: { definitions: [] },
					},
				} as unknown as ResolvedProvider
			}
			throw new Error(`unknown provider ${name}`)
		})

		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const [seeded] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'skjald',
				status: 'awaiting_secret',
				externalId: randomBytes(24).toString('hex'),
				credentials: '', // Skjald shape
				config: { system_actor_id: actorId },
				createdBy: actorId,
			})
			.returning()

		const res = await buildApp().request(
			jsonPost(
				`/api/integrations/${seeded.id}/complete`,
				{ secret: 'sk-test-skjald-secret' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, seeded.id))
		expect(row.status).toBe('active')
		const decrypted = decrypt(row.credentials)
		expect(decrypted).toBe('sk-test-skjald-secret')
		// Confirm it's a raw string, not a JSON blob.
		expect(() => JSON.parse(decrypted)).toThrow()
	})
})

describe('POST /api/integrations/:id/complete — endpoint-cap soft warning', () => {
	it('logs resend.webhook_endpoints.at_ceiling at WARN but still returns 200 with status active', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const { encrypt } = await import('../../lib/crypto')
		const seededCreds = encrypt(JSON.stringify({ accessToken: 're_pro_plan_key' }))
		const [seeded] = await db
			.insert(integrations)
			.values({
				workspaceId: ws.id,
				provider: 'resend',
				status: 'awaiting_secret',
				externalId: randomBytes(24).toString('hex'),
				credentials: seededCreds,
				config: { system_actor_id: actorId, resend: {} },
				createdBy: actorId,
			})
			.returning()

		// 5 webhooks in the response — Pro ceiling.
		fetchSpy.mockImplementation(async () => {
			return new Response(
				JSON.stringify({
					data: [{ id: 'w1' }, { id: 'w2' }, { id: 'w3' }, { id: 'w4' }, { id: 'w5' }],
				}),
				{ status: 200 },
			)
		})

		const warnSpy = vi.spyOn(logger, 'warn')

		const res = await buildApp().request(
			jsonPost(
				`/api/integrations/${seeded.id}/complete`,
				{ secret: 'whsec_at_ceiling' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const [row] = await db.select().from(integrations).where(eq(integrations.id, seeded.id))
		expect(row.status).toBe('active')

		expect(warnSpy).toHaveBeenCalledWith(
			'resend.webhook_endpoints.at_ceiling',
			expect.objectContaining({ workspace_id: ws.id, endpoint_count: 5 }),
		)
		warnSpy.mockRestore()
	})
})

describe('POST /api/integrations/resend/dns-precheck', () => {
	let resolveMxSpy: ReturnType<typeof vi.spyOn>

	beforeEach(() => {
		resolveMxSpy = vi.spyOn(dns, 'resolveMx')
	})

	afterEach(() => {
		resolveMxSpy.mockRestore()
	})

	it('returns warn: true when a bare domain has an existing non-Resend MX (Google)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		resolveMxSpy.mockResolvedValue([
			{ exchange: 'aspmx.l.google.com', priority: 1 },
			{ exchange: 'alt1.aspmx.l.google.com', priority: 5 },
		])

		const res = await buildApp().request(
			jsonPost(
				'/api/integrations/resend/dns-precheck',
				{ domain: 'example.com' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			existing_mx: string[]
			is_subdomain: boolean
			warn: boolean
		}
		expect(body.is_subdomain).toBe(false)
		expect(body.warn).toBe(true)
		expect(body.existing_mx[0]).toBe('aspmx.l.google.com')
	})

	it('returns warn: false with an empty MX list on ENOTFOUND (safe subdomain)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		const enotfound = Object.assign(new Error('ENOTFOUND mail.nonexistent.invalid'), {
			code: 'ENOTFOUND',
		})
		resolveMxSpy.mockRejectedValue(enotfound)

		const errorLogSpy = vi.spyOn(logger, 'warn')

		const res = await buildApp().request(
			jsonPost(
				'/api/integrations/resend/dns-precheck',
				{ domain: 'mail.nonexistent.invalid' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			existing_mx: string[]
			is_subdomain: boolean
			warn: boolean
		}
		expect(body.existing_mx).toEqual([])
		expect(body.warn).toBe(false)
		expect(body.is_subdomain).toBe(true)
		// No dns_precheck.error log for ENOTFOUND (safe case).
		expect(errorLogSpy).not.toHaveBeenCalledWith('resend.dns_precheck.error', expect.anything())
		errorLogSpy.mockRestore()
	})

	it('returns warn: false when a subdomain has an existing Resend/amazonses MX (safe reconnect)', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)

		resolveMxSpy.mockResolvedValue([
			{ exchange: 'feedback-smtp.eu-west-1.amazonses.com', priority: 10 },
		])

		const res = await buildApp().request(
			jsonPost(
				'/api/integrations/resend/dns-precheck',
				{ domain: 'mail.example.com' },
				{ 'x-workspace-id': ws.id },
			),
		)

		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			existing_mx: string[]
			is_subdomain: boolean
			warn: boolean
		}
		expect(body.warn).toBe(false)
		expect(body.is_subdomain).toBe(true)
		expect(body.existing_mx).toEqual(['feedback-smtp.eu-west-1.amazonses.com'])
	})
})
