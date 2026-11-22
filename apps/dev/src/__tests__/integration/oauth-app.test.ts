import { randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import { events, credentialAccessLog, integrations, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

// Salesforce is behind a flag; the flag itself is covered in feature-flags.test.ts.
vi.mock('../../lib/feature-flags', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/feature-flags')>()),
	isFlagEnabled: () => true,
}))

import { createApiError } from '../../lib/errors'
import { resolveAgentAccess } from '../../lib/integrations/agent-access'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import {
	OAuthAppInUseError,
	deleteOAuthApp,
	getOAuthAppStatus,
	loadOAuthApp,
	saveOAuthApp,
} from '../../lib/integrations/oauth-app'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { ViewerReadOnlyError } from '../../lib/workspace-auth'
import integrationsRoutes from '../../routes/integrations'
import oauthAppRoutes from '../../routes/integrations-oauth-app'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Obviously fake, built at runtime so no secret-shaped literal sits in the repo.
const SECRET = `3MVG9_${'CANARY0123'.repeat(5)}`
const CLIENT_ID = `3MVG9${'appid'.repeat(6)}`

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => setKmsProviderForTests(undefined))

const save = (workspaceId: string, over: Record<string, unknown> = {}) =>
	saveOAuthApp(db, kms, {
		workspaceId,
		actorId: getTestActorId(),
		provider: 'salesforce',
		displayName: 'Salesforce app',
		clientId: CLIENT_ID,
		clientSecret: SECRET,
		...over,
	})

function appFor(workspaceId: string, role = 'owner', actorType = 'human') {
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('actorType', actorType)
		c.set('workspaceRole', role)
		await next()
	})
	app.onError((err, c) => {
		// The real app maps this to 403 in createApp's onError.
		if (err instanceof ViewerReadOnlyError) {
			return c.json(createApiError('FORBIDDEN', err.message), 403)
		}
		return c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 })
	})
	app.route('/api/integrations', oauthAppRoutes as never)
	app.route('/api/integrations', integrationsRoutes as never)
	return {
		request: (method: string, path: string, body?: unknown) =>
			app.request(`/api/integrations${path}`, {
				method,
				headers: { 'content-type': 'application/json', 'x-workspace-id': workspaceId },
				body: body === undefined ? undefined : JSON.stringify(body),
			}),
	}
}

describe('a workspace saves its own sign-in app', () => {
	it('stores the secret as an envelope, keeps the app id in config and audits the write', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { integrationId, created } = await save(ws.id)
		expect(created).toBe(true)

		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({
			provider: 'oauth-app',
			providerMode: 'oauth_app',
			externalId: 'salesforce',
			status: 'active',
			defaultAgentAccess: 'none',
			config: { client_id: CLIENT_ID, for_provider: 'salesforce' },
		})
		expect(row?.credentials).not.toContain(SECRET)
		expect(row?.dekCiphertext).toBeTruthy()

		const log = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, integrationId))
		expect(log).toHaveLength(1)
		expect(log[0]).toMatchObject({ action: 'create', source: 'oauth_app_form' })
		expect(await verifyCredentialAccessChain(db, ws.id)).toMatchObject({ ok: true })

		const evs = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, integrationId), eq(events.entityType, 'integration')))
		expect(evs).toHaveLength(1)
		expect(
			JSON.stringify([row?.config, log, evs], (_k, v) =>
				typeof v === 'bigint' ? v.toString() : v,
			),
		).not.toContain(SECRET)

		expect(await loadOAuthApp(db, kms, ws.id, 'salesforce')).toEqual({
			clientId: CLIENT_ID,
			clientSecret: SECRET,
		})
	})

	it('replaces in place: same row, new pair, a rotated audit row', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const first = await save(ws.id)
		const second = await save(ws.id, { clientId: 'second-id', clientSecret: 'second-secret' })
		expect(second).toEqual({ integrationId: first.integrationId, created: false })
		expect(await loadOAuthApp(db, kms, ws.id, 'salesforce')).toEqual({
			clientId: 'second-id',
			clientSecret: 'second-secret',
		})
		const rows = await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))
		expect(rows).toHaveLength(1)
		const log = await db
			.select({ action: credentialAccessLog.action })
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.integrationId, first.integrationId))
		expect(log.map((l) => l.action).sort()).toEqual(['create', 'rotated'])
		expect(await verifyCredentialAccessChain(db, ws.id)).toMatchObject({ ok: true })
	})

	it('refuses a new app id while connected, but takes a new secret for the same id', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await save(ws.id)
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'salesforce',
			status: 'active',
			externalId: 'oauth-def',
			credentials: 'x',
			createdBy: getTestActorId(),
		})
		await expect(save(ws.id, { clientId: 'other-id' })).rejects.toBeInstanceOf(OAuthAppInUseError)
		await save(ws.id, { clientSecret: 'rotated-secret' })
		expect(await loadOAuthApp(db, kms, ws.id, 'salesforce')).toEqual({
			clientId: CLIENT_ID,
			clientSecret: 'rotated-secret',
		})
	})

	it('gives nobody access to the app row, whatever the default', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { integrationId } = await save(ws.id)
		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'read' })
			.where(eq(integrations.id, integrationId))
		expect(await resolveAgentAccess(db, ws.id, integrationId, getTestActorId())).toBe('none')
	})

	it("never hands one workspace another workspace's app", async () => {
		const a = await insertWorkspace(db, getTestActorId())
		const b = await insertWorkspace(db, getTestActorId())
		await save(a.id)
		expect(await loadOAuthApp(db, kms, b.id, 'salesforce')).toBeNull()
		expect(await getOAuthAppStatus(db, b.id, 'salesforce')).toEqual({ configured: false })
	})

	it('refuses a value that breaks the key rule and writes nothing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await expect(save(ws.id, { clientSecret: 'has a "quote"' })).rejects.toThrow()
		expect(await db.select().from(integrations).where(eq(integrations.workspaceId, ws.id))).toEqual(
			[],
		)
	})

	it('is refused to remove while the tool is connected, and wipes the secret otherwise', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { integrationId } = await save(ws.id)
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'salesforce',
			status: 'active',
			externalId: 'oauth-abc',
			credentials: 'x',
			createdBy: getTestActorId(),
		})
		const params = { workspaceId: ws.id, actorId: getTestActorId(), provider: 'salesforce' }
		expect(await deleteOAuthApp(db, params)).toBe('in_use')
		await db.delete(integrations).where(eq(integrations.externalId, 'oauth-abc'))
		expect(await deleteOAuthApp(db, params)).toBe('deleted')
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row).toMatchObject({ status: 'undone', credentials: null, dekCiphertext: null })
		expect(await loadOAuthApp(db, kms, ws.id, 'salesforce')).toBeNull()
		expect(await deleteOAuthApp(db, params)).toBe('not_found')
		// Saving again brings the same row back.
		const again = await save(ws.id)
		expect(again).toEqual({ integrationId, created: false })
		expect(await loadOAuthApp(db, kms, ws.id, 'salesforce')).not.toBeNull()
	})
})

describe('the app routes', () => {
	it('save, then report the app id and the callback URL and never the secret', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const app = appFor(ws.id)

		const empty = await app.request('GET', '/salesforce/app')
		expect(empty.status).toBe(200)
		expect(await empty.json()).toMatchObject({
			configured: false,
			callbackUrl: expect.stringMatching(/\/api\/integrations\/salesforce\/callback$/),
		})

		const put = await app.request('PUT', '/salesforce/app', {
			clientId: CLIENT_ID,
			clientSecret: SECRET,
		})
		expect(put.status).toBe(200)
		const putText = await put.text()
		expect(putText).not.toContain(SECRET)
		expect(JSON.parse(putText)).toMatchObject({ configured: true, clientId: CLIENT_ID })

		const get = await (await app.request('GET', '/salesforce/app')).text()
		expect(get).not.toContain(SECRET)
	})

	it('keeps the app out of the integrations list', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await save(ws.id)
		const res = await appFor(ws.id).request('GET', '')
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual([])
	})

	it('refuses a viewer, a member who is not an admin, an agent and a tool with no own app', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const body = { clientId: CLIENT_ID, clientSecret: SECRET }
		expect((await appFor(ws.id, 'viewer').request('PUT', '/salesforce/app', body)).status).toBe(403)
		// The admin check reads the member row, not the role on the request, so demote the row.
		await db
			.update(workspaceMembers)
			.set({ role: 'member' })
			.where(
				and(
					eq(workspaceMembers.workspaceId, ws.id),
					eq(workspaceMembers.actorId, getTestActorId()),
				),
			)
		expect((await appFor(ws.id, 'member').request('PUT', '/salesforce/app', body)).status).toBe(403)
		await db
			.update(workspaceMembers)
			.set({ role: 'owner' })
			.where(
				and(
					eq(workspaceMembers.workspaceId, ws.id),
					eq(workspaceMembers.actorId, getTestActorId()),
				),
			)
		expect(
			(await appFor(ws.id, 'owner', 'agent').request('PUT', '/salesforce/app', body)).status,
		).toBe(403)
		expect((await appFor(ws.id).request('PUT', '/linear/app', body)).status).toBe(400)
		expect(await getOAuthAppStatus(db, ws.id, 'salesforce')).toEqual({ configured: false })
	})

	it('answers 409 to a remove while connected and 404 when nothing is saved', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const app = appFor(ws.id)
		expect((await app.request('DELETE', '/salesforce/app')).status).toBe(404)
		await save(ws.id)
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'salesforce',
			status: 'active',
			externalId: 'oauth-def',
			credentials: 'x',
			createdBy: getTestActorId(),
		})
		expect((await app.request('DELETE', '/salesforce/app')).status).toBe(409)
	})

	it('refuses to start a sign-in before an app is saved', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await appFor(ws.id).request('POST', '/salesforce/connect')
		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('APP_REQUIRED')
	})

	it("signs in with the workspace's own app id on the authorize URL", async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		await save(ws.id)
		const res = await appFor(ws.id).request('POST', '/salesforce/connect')
		expect(res.status).toBe(200)
		const { install_url } = (await res.json()) as { install_url: string }
		const url = new URL(install_url)
		expect(url.origin + url.pathname).toBe('https://login.salesforce.com/services/oauth2/authorize')
		expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
		expect(url.searchParams.get('scope')).toBe('mcp_api refresh_token')
		expect(install_url).not.toContain(SECRET)
	})
})

describe('a tool at the customer own address', () => {
	it('saves a public client with no secret and the address, and reads both back', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const { integrationId } = await save(ws.id, {
			provider: 'looker',
			displayName: 'Looker app',
			clientSecret: null,
			value: 'acme.cloud.looker.com',
		})
		const [row] = await db.select().from(integrations).where(eq(integrations.id, integrationId))
		expect(row?.credentials).toBeNull()
		expect(row?.dekCiphertext).toBeNull()
		expect(row?.config).toMatchObject({
			client_id: CLIENT_ID,
			public: true,
			value: 'acme.cloud.looker.com',
		})
		expect(await getOAuthAppStatus(db, ws.id, 'looker')).toMatchObject({
			configured: true,
			clientId: CLIENT_ID,
			value: 'acme.cloud.looker.com',
		})
		expect(await loadOAuthApp(db, kms, ws.id, 'looker')).toEqual({
			clientId: CLIENT_ID,
			clientSecret: '',
			value: 'acme.cloud.looker.com',
		})
	})

	it('keeps the secret encrypted and the address in the clear for a tool with both', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const tenant = '11111111-2222-3333-4444-555555555555'
		await save(ws.id, { provider: 'power-bi', displayName: 'Power BI app', value: tenant })
		expect(await loadOAuthApp(db, kms, ws.id, 'power-bi')).toEqual({
			clientId: CLIENT_ID,
			clientSecret: SECRET,
			value: tenant,
		})
	})

	it('never hands one workspace the address of another', async () => {
		const a = await insertWorkspace(db, getTestActorId())
		const b = await insertWorkspace(db, getTestActorId())
		await save(a.id, { provider: 'looker', clientSecret: null, value: 'acme.looker.com' })
		expect(await loadOAuthApp(db, kms, b.id, 'looker')).toBeNull()
	})

	it('refuses a different address while the tool is connected, and allows it before', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const first = { provider: 'looker', clientSecret: null, value: 'acme.looker.com' }
		await save(ws.id, first)
		// Not connected yet: the address can still change.
		await save(ws.id, { ...first, value: 'acme.cloud.looker.com' })
		await db.insert(integrations).values({
			workspaceId: ws.id,
			provider: 'looker',
			status: 'active',
			externalId: 'looker-conn',
			credentials: 'x',
			createdBy: getTestActorId(),
		})
		await expect(save(ws.id, { ...first, value: 'other.looker.com' })).rejects.toBeInstanceOf(
			OAuthAppInUseError,
		)
		// Same id and address: a rotation is fine.
		await expect(save(ws.id, { ...first, value: 'acme.cloud.looker.com' })).resolves.toBeDefined()
	})

	it('the route refuses an address that is not a public vendor host, and writes nothing', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const app = appFor(ws.id)
		for (const value of [
			'127.0.0.1',
			'169.254.169.254',
			'localhost',
			'https://acme.looker.com',
			'acme.looker.com/admin',
			'acme.looker.com.evil.com',
			'acme.example.com',
		]) {
			const res = await app.request('PUT', '/looker/app', { clientId: CLIENT_ID, value })
			expect(res.status, value).toBe(400)
		}
		expect((await getOAuthAppStatus(db, ws.id, 'looker')).configured).toBe(false)
	})

	it('the route needs the address, takes no secret for a public client and no address elsewhere', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const app = appFor(ws.id)
		expect((await app.request('PUT', '/looker/app', { clientId: CLIENT_ID })).status).toBe(400)
		expect(
			(
				await app.request('PUT', '/looker/app', {
					clientId: CLIENT_ID,
					clientSecret: SECRET,
					value: 'acme.looker.com',
				})
			).status,
		).toBe(400)
		expect(
			(
				await app.request('PUT', '/salesforce/app', {
					clientId: CLIENT_ID,
					clientSecret: SECRET,
					value: 'acme.looker.com',
				})
			).status,
		).toBe(400)
		expect(
			(
				await app.request('PUT', '/power-bi/app', {
					clientId: CLIENT_ID,
					value: '11111111-2222-3333-4444-555555555555',
				})
			).status,
		).toBe(400)
	})

	it('saves through the route, reports the address back and signs in on it', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const app = appFor(ws.id)
		const put = await app.request('PUT', '/looker/app', {
			clientId: CLIENT_ID,
			value: ' Acme.Cloud.Looker.com ',
		})
		expect(put.status).toBe(200)
		expect(await put.json()).toMatchObject({ configured: true, value: 'acme.cloud.looker.com' })
		const res = await app.request('POST', '/looker/connect')
		expect(res.status).toBe(200)
		const { install_url } = (await res.json()) as { install_url: string }
		const url = new URL(install_url)
		expect(url.origin + url.pathname).toBe('https://acme.cloud.looker.com/auth')
		expect(url.searchParams.get('client_id')).toBe(CLIENT_ID)
		expect(url.searchParams.get('code_challenge_method')).toBe('S256')
	})

	it('refuses to start a sign-in before the address is saved', async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		const res = await appFor(ws.id).request('POST', '/looker/connect')
		expect(res.status).toBe(400)
		expect(JSON.stringify(await res.json())).toContain('APP_REQUIRED')
	})
})
