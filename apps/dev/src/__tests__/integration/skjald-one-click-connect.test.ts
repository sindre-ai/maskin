import { createHash, randomBytes } from 'node:crypto'
import { integrations } from '@maskin/db/schema'
import { SKJALD_CONNECT_REDIRECT_URI } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { decrypt } from '../../lib/crypto'
import { insertWorkspace } from '../factories'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

// "Connect with Maskin" from the Skjald app, against real Postgres: the approve call creates the integration and a
// one-time code, the exchange call (no API key) trades the code for the webhook URL and signing secret once.

const TEST_ENCRYPTION_KEY = randomBytes(32).toString('hex')

const { default: skjaldConnectRoutes } = await import('../../routes/integrations-skjald-connect')

function buildApp() {
	return createIntegrationApp({ path: '/api/integrations/skjald', module: skjaldConnectRoutes })
}

function pkce() {
	const verifier = randomBytes(32).toString('base64url')
	return { verifier, challenge: createHash('sha256').update(verifier).digest('base64url') }
}

describe('Skjald one-click connect', () => {
	const previous: Record<string, string | undefined> = {}
	const ENV = { INTEGRATION_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY, CORS_ORIGIN: 'http://maskin.test' }

	beforeAll(() => {
		for (const [key, value] of Object.entries(ENV)) {
			previous[key] = process.env[key]
			process.env[key] = value
		}
	})

	afterAll(() => {
		for (const key of Object.keys(ENV)) {
			if (previous[key] === undefined) delete process.env[key]
			else process.env[key] = previous[key]
		}
	})

	async function authorize(
		workspaceId: string,
		challenge: string,
		overrides: Record<string, unknown> = {},
	) {
		const app = buildApp()
		const res = await app.request(
			new Request('http://localhost/api/integrations/skjald/authorize', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspaceId },
				body: JSON.stringify({
					state: 'state-1234',
					redirect_uri: SKJALD_CONNECT_REDIRECT_URI,
					code_challenge: challenge,
					code_challenge_method: 'S256',
					...overrides,
				}),
			}),
		)
		return { app, res }
	}

	async function exchange(app: ReturnType<typeof buildApp>, body: Record<string, unknown>) {
		return app.request(
			new Request('http://localhost/api/integrations/skjald/exchange', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body),
			}),
		)
	}

	async function approved(workspaceId: string) {
		const { verifier, challenge } = pkce()
		const { app, res } = await authorize(workspaceId, challenge)
		expect(res.status).toBe(200)
		const { redirect_url } = (await res.json()) as { redirect_url: string }
		const url = new URL(redirect_url)
		expect(`${url.protocol}//${url.host}${url.pathname}`).toBe(SKJALD_CONNECT_REDIRECT_URI)
		expect(url.searchParams.get('state')).toBe('state-1234')
		return { app, verifier, challenge, code: url.searchParams.get('code') ?? '' }
	}

	const rows = (workspaceId: string) =>
		db
			.select()
			.from(integrations)
			.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, 'skjald')))

	it('hands the app the webhook URL and a signing secret, and activates the integration', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const { app, verifier, code } = await approved(workspace.id)

		// Before the exchange nothing is active and the secret is not stored where the webhook reads it.
		const [pending] = await rows(workspace.id)
		expect(pending?.status).toBe('awaiting_secret')
		expect(pending?.credentials).toBe('')

		const res = await exchange(app, { code, code_verifier: verifier })
		expect(res.status).toBe(200)
		const body = (await res.json()) as {
			webhook_url: string
			secret: string
			workspace_name: string
		}
		expect(body.workspace_name).toBe(workspace.name)
		expect(body.secret).toMatch(/^[0-9a-f]{64}$/)

		const [row] = await rows(workspace.id)
		expect(row?.status).toBe('active')
		expect(body.webhook_url).toBe(`http://maskin.test/api/webhooks/skjald/${row?.externalId}`)
		expect(decrypt(row?.credentials ?? '')).toBe(body.secret)
		expect((row?.config as Record<string, unknown>).skjald_connect).toBeUndefined()
		expect((row?.config as Record<string, unknown>).system_actor_id).toBeTruthy()
	})

	it('trades a code once', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const { app, verifier, code } = await approved(workspace.id)
		expect((await exchange(app, { code, code_verifier: verifier })).status).toBe(200)
		expect((await exchange(app, { code, code_verifier: verifier })).status).toBe(404)
	})

	it('refuses a wrong verifier without using the code up', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const { app, verifier, code } = await approved(workspace.id)
		expect((await exchange(app, { code, code_verifier: pkce().verifier })).status).toBe(404)
		expect((await exchange(app, { code, code_verifier: verifier })).status).toBe(200)
	})

	it('refuses an unknown code and an expired one', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const { app, verifier, code } = await approved(workspace.id)
		expect(
			(
				await exchange(app, {
					code: randomBytes(32).toString('base64url'),
					code_verifier: verifier,
				})
			).status,
		).toBe(404)

		const [row] = await rows(workspace.id)
		const config = row?.config as { skjald_connect: Record<string, unknown> }
		await db
			.update(integrations)
			.set({
				config: {
					...config,
					skjald_connect: { ...config.skjald_connect, expires_at: '2020-01-01T00:00:00.000Z' },
				},
			})
			.where(eq(integrations.id, row?.id ?? ''))
		expect((await exchange(app, { code, code_verifier: verifier })).status).toBe(404)
	})

	it('refuses a redirect that is not the Skjald app, and creates nothing', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const { res } = await authorize(workspace.id, pkce().challenge, {
			redirect_uri: 'https://evil.example/cb',
		})
		expect(res.status).toBe(400)
		expect(await rows(workspace.id)).toHaveLength(0)
	})

	it('rejects a malformed exchange', async () => {
		const res = await exchange(buildApp(), { code: 'short', code_verifier: 'short' })
		expect(res.status).toBe(400)
	})

	it('connecting again reuses the integration and gives it a new secret', async () => {
		const workspace = await insertWorkspace(db, getTestActorId())
		const first = await approved(workspace.id)
		const a = (await (
			await exchange(first.app, { code: first.code, code_verifier: first.verifier })
		).json()) as {
			webhook_url: string
			secret: string
		}
		const second = await approved(workspace.id)
		const b = (await (
			await exchange(second.app, { code: second.code, code_verifier: second.verifier })
		).json()) as {
			webhook_url: string
			secret: string
		}
		expect(await rows(workspace.id)).toHaveLength(1)
		expect(b.webhook_url).toBe(a.webhook_url)
		expect(b.secret).not.toBe(a.secret)
	})
})
