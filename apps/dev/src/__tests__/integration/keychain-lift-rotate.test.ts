import { randomBytes, randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { MasterKeyProvider } from '@maskin/auth/kms'
import {
	events,
	agentGrants,
	credentialAccessLog,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { decrypt, decryptStoredCredential, encrypt } from '../../lib/crypto'
import { createApiError } from '../../lib/errors'
import { createByoApiKey } from '../../lib/integrations/byo-apikey'
import { verifyCredentialAccessChain } from '../../lib/integrations/credential-audit'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import keychainAdminRoutes from '../../routes/keychain-admin'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const fake = (label: string) => `fake-${label}-${'0123456789'.repeat(3)}`

let kms: MasterKeyProvider
beforeAll(() => {
	kms = new MasterKeyProvider(randomBytes(32))
	setKmsProviderForTests(kms)
})
afterAll(() => {
	setKmsProviderForTests(undefined)
})

function appFor(actorId: string, actorType: 'human' | 'agent' = 'human') {
	const app = new OpenAPIHono<{
		Variables: { db: typeof db; actorId: string; actorType: string }
	}>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		await next()
	})
	app.onError((_err, c) =>
		c.json(createApiError('INTERNAL_ERROR', 'Internal server error'), { status: 500 }),
	)
	app.route('/api/keychain', keychainAdminRoutes)
	return app
}

const lift = (workspaceId: string, body?: unknown, app = appFor(getTestActorId())) =>
	app.request('/api/keychain/lift', {
		method: 'POST',
		headers: { 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
		body: body === undefined ? undefined : JSON.stringify(body),
	})

const replaceValue = (
	workspaceId: string,
	id: string,
	rawSecret: string,
	app = appFor(getTestActorId()),
) =>
	app.request(`/api/keychain/credentials/${id}/replace-value`, {
		method: 'POST',
		headers: { 'x-workspace-id': workspaceId, 'content-type': 'application/json' },
		body: JSON.stringify({ rawSecret }),
	})

interface ServerSpec {
	type?: 'stdio' | 'http'
	command?: string
	args?: string[]
	env?: Record<string, string>
	url?: string
	headers?: Record<string, string>
}

/** A workspace-level tool server, stored the way the Integrations page stores it. */
async function toolServer(
	workspaceId: string,
	name: string,
	server: ServerSpec,
	agentIds: string[],
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'custom-mcp',
			// One custom-mcp row per workspace and actor is allowed without an external id.
			externalId: randomUUID(),
			status: 'active',
			displayName: name,
			credentials: encrypt(JSON.stringify({ server })),
			defaultAgentAccess: 'none',
			createdBy: getTestActorId(),
		})
		.returning()
	if (!row) throw new Error('insert returned no row')
	if (agentIds.length > 0) {
		await db.insert(agentGrants).values(
			agentIds.map((actorId) => ({
				workspaceId,
				integrationId: row.id,
				actorId,
				access: 'read_write' as const,
			})),
		)
	}
	return row.id
}

async function storedServer(id: string): Promise<ServerSpec> {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return JSON.parse(decrypt(row?.credentials as string)).server
}

async function setup() {
	const ws = await insertWorkspace(db, getTestActorId(), {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const infra = await insertActor(db, { type: 'agent', systemPrompt: 'Infra' })
	const watcher = await insertActor(db, { type: 'agent', systemPrompt: 'Watcher' })
	const outsider = await insertActor(db, { type: 'agent', systemPrompt: 'Outsider' })
	await db.insert(workspaceMembers).values(
		[infra, watcher, outsider].map((a) => ({
			workspaceId: ws.id,
			actorId: (a as { id: string }).id,
			role: 'member',
		})),
	)
	const ids = {
		infra: (infra as { id: string }).id,
		watcher: (watcher as { id: string }).id,
		outsider: (outsider as { id: string }).id,
	}
	const cf = fake('cloudflare')
	const coolify = fake('coolify')
	const sentry = fake('sentry')
	const supabase = fake('supabase')
	const rows = {
		cfApi: await toolServer(
			ws.id,
			'cloudflare-api',
			{
				type: 'http',
				url: 'https://mcp.cloudflare.example/mcp',
				headers: { Authorization: `Bearer ${cf}` },
			},
			[ids.infra],
		),
		cfObs: await toolServer(
			ws.id,
			'cloudflare-observability',
			{ type: 'stdio', command: 'npx', args: ['-y', 'cf-mcp'], env: { CLOUDFLARE_API_TOKEN: cf } },
			[ids.infra],
		),
		cfBuilds: await toolServer(
			ws.id,
			'cloudflare-builds',
			{
				type: 'http',
				url: 'https://builds.cloudflare.example/mcp',
				headers: { Authorization: `Bearer ${cf}` },
			},
			[ids.infra],
		),
		cfBindings: await toolServer(
			ws.id,
			'cloudflare-bindings',
			{
				type: 'stdio',
				command: 'npx',
				args: ['-y', 'cf-bindings'],
				env: { CLOUDFLARE_API_TOKEN: cf },
			},
			[ids.infra],
		),
		coolify: await toolServer(
			ws.id,
			'Coolify',
			{
				type: 'stdio',
				command: 'npx',
				args: ['-y', 'coolify-mcp'],
				env: { COOLIFY_ACCESS_TOKEN: coolify, COOLIFY_BASE_URL: 'https://cool.example.com' },
			},
			[ids.infra],
		),
		sentry: await toolServer(
			ws.id,
			'Sentry',
			{
				type: 'http',
				url: 'https://mcp.sentry.example/mcp',
				headers: { Authorization: `Bearer ${sentry}` },
			},
			[ids.infra, ids.watcher],
		),
		// A token in the command arguments cannot hold a reference.
		supabase: await toolServer(
			ws.id,
			'Supabase (Maskin Production)',
			{ type: 'stdio', command: 'npx', args: ['-y', 'supabase-mcp', '--access-token', supabase] },
			[ids.infra],
		),
	}
	return { ws, ids, rows, values: { cf, coolify, sentry, supabase } }
}

type Setup = Awaited<ReturnType<typeof setup>>

const keysIn = (workspaceId: string) =>
	db
		.select()
		.from(integrations)
		.where(
			and(eq(integrations.workspaceId, workspaceId), eq(integrations.providerMode, 'byo_apikey')),
		)

const grantsOf = async (integrationId: string) =>
	(await db.select().from(agentGrants).where(eq(agentGrants.integrationId, integrationId)))
		.map((g) => g.actorId)
		.sort()

describe('POST /api/keychain/lift', () => {
	it('refuses an agent, even a workspace admin, before saying anything about the workspace', async () => {
		const s = await setup()
		const agent = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: agent.id, role: 'admin' })

		const dry = await lift(s.ws.id, undefined, appFor(agent.id, 'agent'))
		const apply = await lift(s.ws.id, { apply: true }, appFor(agent.id, 'agent'))

		expect(dry.status).toBe(403)
		expect(apply.status).toBe(403)
		expect(await keysIn(s.ws.id)).toHaveLength(0)
	})

	it('answers a call with no body with a dry run that writes nothing and shows no value', async () => {
		const s = await setup()
		const rowsBefore = await db
			.select()
			.from(integrations)
			.where(eq(integrations.workspaceId, s.ws.id))
		const logBefore = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.workspaceId, s.ws.id))
		const eventsBefore = await db.select().from(events).where(eq(events.workspaceId, s.ws.id))

		const res = await lift(s.ws.id)
		const text = await res.text()
		const body = JSON.parse(text)

		expect(res.status).toBe(200)
		expect(body.dryRun).toBe(true)
		for (const value of Object.values(s.values)) expect(text).not.toContain(value)
		expect(body.keys.map((k: { keyName: string }) => k.keyName).sort()).toEqual([
			'Cloudflare',
			'Coolify',
			'Sentry',
		])
		const cloudflare = body.keys.find((k: { keyName: string }) => k.keyName === 'Cloudflare')
		expect(cloudflare.entries).toBe(4)
		expect(cloudflare.actorIds).toEqual([s.ids.infra])
		const blocked = body.entries.filter((e: { status: string }) => e.status === 'cannot_lift')
		expect(blocked).toHaveLength(1)
		expect(blocked[0]).toMatchObject({
			serverName: 'Supabase (Maskin Production)',
			reason: 'in_args',
		})

		const rowsAfter = await db
			.select()
			.from(integrations)
			.where(eq(integrations.workspaceId, s.ws.id))
		expect(rowsAfter).toHaveLength(rowsBefore.length)
		expect(rowsAfter.map((r) => [r.id, r.credentials, r.updatedAt])).toEqual(
			rowsBefore.map((r) => [r.id, r.credentials, r.updatedAt]),
		)
		expect(
			await db
				.select()
				.from(credentialAccessLog)
				.where(eq(credentialAccessLog.workspaceId, s.ws.id)),
		).toHaveLength(logBefore.length)
		expect(await db.select().from(events).where(eq(events.workspaceId, s.ws.id))).toHaveLength(
			eventsBefore.length,
		)
	})

	it('lifts each token into one key per value, granted to the agents of its tool server only', async () => {
		const s = await setup()

		const res = await lift(s.ws.id, { apply: true })
		const body = await res.json()

		expect(res.status).toBe(200)
		expect(body.dryRun).toBe(false)
		expect(body.results.map((r: { status: string }) => r.status)).toEqual([
			'lifted',
			'lifted',
			'lifted',
		])
		// Cloudflare on four tool servers became one key.
		const keys = await keysIn(s.ws.id)
		expect(keys.map((k) => k.displayName).sort()).toEqual(['Cloudflare', 'Coolify', 'Sentry'])
		const byName = (name: string) => keys.find((k) => k.displayName === name)
		expect(await grantsOf(byName('Cloudflare')?.id as string)).toEqual([s.ids.infra])
		expect(await grantsOf(byName('Sentry')?.id as string)).toEqual(
			[s.ids.infra, s.ids.watcher].sort(),
		)
		// Never a workspace-wide grant, never a grant to an agent that did not hold the tool.
		for (const key of keys) {
			expect(key.defaultAgentAccess).toBe('none')
			expect(await grantsOf(key.id)).not.toContain(s.ids.outsider)
			expect(key.source).toBe('admin_ui')
			expect(key.status).toBe('active')
		}
		// The saved value is the token, envelope encrypted.
		const cloudflare = byName('Cloudflare')
		expect(cloudflare?.dekCiphertext).not.toBeNull()
		expect(
			await decryptStoredCredential(kms, {
				workspaceId: s.ws.id,
				credentials: cloudflare?.credentials as string,
				dekCiphertext: cloudflare?.dekCiphertext as string,
			}),
		).toBe(s.values.cf)
	})

	it('grants a deduped key to the union of the agents across the matching tool servers', async () => {
		const s = await setup()
		// Only one of the four Cloudflare tool servers is also granted to the watcher.
		await db.insert(agentGrants).values({
			workspaceId: s.ws.id,
			integrationId: s.rows.cfBuilds,
			actorId: s.ids.watcher,
			access: 'read_write' as const,
		})

		const res = await lift(s.ws.id, { apply: true })

		expect(res.status).toBe(200)
		const keys = await keysIn(s.ws.id)
		const cloudflareKeys = keys.filter((k) => k.displayName === 'Cloudflare')
		expect(cloudflareKeys).toHaveLength(1)
		expect(await grantsOf(cloudflareKeys[0]?.id as string)).toEqual(
			[s.ids.infra, s.ids.watcher].sort(),
		)
		expect(await grantsOf(cloudflareKeys[0]?.id as string)).not.toContain(s.ids.outsider)
	})

	it('leaves only the reference in each tool server, keeping the scheme word and other fields', async () => {
		const s = await setup()

		await lift(s.ws.id, { apply: true })

		expect((await storedServer(s.rows.cfApi)).headers).toEqual({
			Authorization: 'Bearer ${KEYCHAIN_BYO_APIKEY_CLOUDFLARE}',
		})
		expect((await storedServer(s.rows.cfObs)).env).toEqual({
			CLOUDFLARE_API_TOKEN: '${KEYCHAIN_BYO_APIKEY_CLOUDFLARE}',
		})
		expect((await storedServer(s.rows.coolify)).env).toEqual({
			COOLIFY_ACCESS_TOKEN: '${KEYCHAIN_BYO_APIKEY_COOLIFY}',
			COOLIFY_BASE_URL: 'https://cool.example.com',
		})
		expect((await storedServer(s.rows.sentry)).headers).toEqual({
			Authorization: 'Bearer ${KEYCHAIN_BYO_APIKEY_SENTRY}',
		})
		// A token in the arguments cannot hold a reference, so that server is untouched.
		expect((await storedServer(s.rows.supabase)).args).toContain(s.values.supabase)
		for (const id of [
			s.rows.cfApi,
			s.rows.cfObs,
			s.rows.cfBuilds,
			s.rows.cfBindings,
			s.rows.coolify,
			s.rows.sentry,
		]) {
			const text = JSON.stringify(await storedServer(id))
			for (const value of [s.values.cf, s.values.coolify, s.values.sentry]) {
				expect(text).not.toContain(value)
			}
		}
	})

	it('is a no-op the second time', async () => {
		const s = await setup()
		await lift(s.ws.id, { apply: true })
		const rowsBefore = await db
			.select()
			.from(integrations)
			.where(eq(integrations.workspaceId, s.ws.id))
		const logBefore = await db
			.select()
			.from(credentialAccessLog)
			.where(eq(credentialAccessLog.workspaceId, s.ws.id))

		const again = await lift(s.ws.id, { apply: true })
		const dry = await (await lift(s.ws.id)).json()

		expect((await again.json()).results).toEqual([])
		expect(dry.keys).toEqual([])
		const rowsAfter = await db
			.select()
			.from(integrations)
			.where(eq(integrations.workspaceId, s.ws.id))
		expect(rowsAfter.map((r) => [r.id, r.credentials])).toEqual(
			rowsBefore.map((r) => [r.id, r.credentials]),
		)
		expect(
			await db
				.select()
				.from(credentialAccessLog)
				.where(eq(credentialAccessLog.workspaceId, s.ws.id)),
		).toHaveLength(logBefore.length)
	})

	it('aborts a key whose name is taken and lifts the others', async () => {
		const s = await setup()
		await createByoApiKey(db, kms, {
			workspaceId: s.ws.id,
			actorId: getTestActorId(),
			displayName: 'Coolify',
			rawSecret: fake('someone-elses'),
		})

		const body = await (await lift(s.ws.id, { apply: true })).json()

		const byName = Object.fromEntries(body.results.map((r: { keyName: string }) => [r.keyName, r]))
		expect(byName.Coolify).toMatchObject({ status: 'aborted', reason: 'name_taken' })
		expect(byName.Cloudflare.status).toBe('lifted')
		expect(byName.Sentry.status).toBe('lifted')
		// The aborted tool server still holds its own token.
		expect((await storedServer(s.rows.coolify)).env?.COOLIFY_ACCESS_TOKEN).toBe(s.values.coolify)
	})

	it('writes an audit row with source lift, a names-only event, and keeps the chain whole', async () => {
		const s = await setup()

		const body = await (await lift(s.ws.id, { apply: true })).json()

		const lifted = body.results.filter((r: { status: string }) => r.status === 'lifted')
		for (const r of lifted) {
			const log = await db
				.select()
				.from(credentialAccessLog)
				.where(eq(credentialAccessLog.integrationId, r.integrationId))
			expect(log).toHaveLength(1)
			expect(log[0]).toMatchObject({ action: 'create', source: 'lift', actorId: getTestActorId() })
			const [event] = await db
				.select()
				.from(events)
				.where(and(eq(events.entityId, r.integrationId), eq(events.action, 'keychain_lifted')))
			expect(String(event?.id)).toBe(r.eventId)
			const text = JSON.stringify(event?.data)
			for (const value of Object.values(s.values)) expect(text).not.toContain(value)
		}
		expect((await verifyCredentialAccessChain(db, s.ws.id)).ok).toBe(true)
	})

	it('hands the lifted value to the granted agent at launch and to nobody else', async () => {
		const s = await setup()
		await lift(s.ws.id, { apply: true })
		const manager = new SessionManager(db, {
			put: async () => {},
			get: async () => Buffer.from(''),
			list: async () => [],
			delete: async () => {},
			exists: async () => false,
			ensureBucket: async () => {},
		})
		const launch = async (actorId: string) => {
			const created = await insertSession(db, s.ws.id, actorId, getTestActorId(), {
				status: 'pending',
				containerId: null,
			})
			const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
			return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
		}
		try {
			const infraEnv = await launch(s.ids.infra)
			const outsiderEnv = await launch(s.ids.outsider)
			expect(infraEnv.KEYCHAIN_BYO_APIKEY_CLOUDFLARE).toBe(s.values.cf)
			expect(Object.keys(outsiderEnv).filter((k) => k.startsWith('KEYCHAIN_'))).toEqual([])
		} finally {
			await manager.stop()
		}
	})

	it('undoes one lift by event id, putting the token back, and refuses a second undo', async () => {
		const s = await setup()
		const body = await (await lift(s.ws.id, { apply: true })).json()
		const cloudflare = body.results.find((r: { keyName: string }) => r.keyName === 'Cloudflare')

		const undo = await lift(s.ws.id, { undo_event_id: cloudflare.eventId })

		expect(undo.status).toBe(200)
		expect(await undo.json()).toEqual({ undone: true, restored: 4, skipped: 0 })
		expect((await storedServer(s.rows.cfApi)).headers).toEqual({
			Authorization: `Bearer ${s.values.cf}`,
		})
		expect((await storedServer(s.rows.cfObs)).env).toEqual({ CLOUDFLARE_API_TOKEN: s.values.cf })
		const [key] = await db
			.select()
			.from(integrations)
			.where(eq(integrations.id, cloudflare.integrationId))
		expect(key).toMatchObject({ status: 'undone', credentials: null, dekCiphertext: null })
		// The other keys are untouched.
		expect((await storedServer(s.rows.sentry)).headers?.Authorization).toContain('KEYCHAIN_')
		expect((await lift(s.ws.id, { undo_event_id: cloudflare.eventId })).status).toBe(409)
		expect((await lift(s.ws.id, { undo_event_id: '999999999' })).status).toBe(404)
		expect((await verifyCredentialAccessChain(db, s.ws.id)).ok).toBe(true)
	})

	it('rejects a body that is neither a dry run, an apply nor an undo', async () => {
		const s = await setup()
		expect((await lift(s.ws.id, { apply: false })).status).toBe(400)
		expect((await lift(s.ws.id, { apply: true, undo_event_id: '1' })).status).toBe(400)
		expect(await keysIn(s.ws.id)).toHaveLength(0)
	})
})

describe('POST /api/keychain/credentials/:id/replace-value', () => {
	async function vault(s: Setup, name: string, value: string, agentIds: string[]) {
		const { integrationId } = await createByoApiKey(db, kms, {
			workspaceId: s.ws.id,
			actorId: getTestActorId(),
			displayName: name,
			rawSecret: value,
			agentIds,
		})
		return integrationId
	}
	const reload = async (id: string) => {
		const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
		return row as typeof integrations.$inferSelect
	}

	it('refuses an agent, even a workspace admin', async () => {
		const s = await setup()
		const id = await vault(s, 'Rotating', fake('old'), [s.ids.infra])
		const agent = await insertActor(db, { type: 'agent' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: s.ws.id, actorId: agent.id, role: 'admin' })
		const before = await reload(id)

		const res = await replaceValue(s.ws.id, id, fake('new'), appFor(agent.id, 'agent'))

		expect(res.status).toBe(403)
		expect((await reload(id)).credentials).toBe(before.credentials)
	})

	it('replaces the value in place, keeping id, name and grants, and writes a rotated audit row', async () => {
		const s = await setup()
		const id = await vault(s, 'Rotating', fake('old'), [s.ids.infra, s.ids.watcher])
		const before = await reload(id)
		const grantsBefore = await grantsOf(id)
		const next = fake('new')

		const res = await replaceValue(s.ws.id, id, next)

		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ id, status: 'replaced' })
		const after = await reload(id)
		expect(after.id).toBe(id)
		expect(after.displayName).toBe('Rotating')
		expect(after.status).toBe('active')
		expect(after.credentials).not.toBe(before.credentials)
		expect(after.dekCiphertext).not.toBeNull()
		expect(
			await decryptStoredCredential(kms, {
				workspaceId: s.ws.id,
				credentials: after.credentials as string,
				dekCiphertext: after.dekCiphertext as string,
			}),
		).toBe(next)
		expect(await grantsOf(id)).toEqual(grantsBefore)
		const rotated = await db
			.select()
			.from(credentialAccessLog)
			.where(
				and(eq(credentialAccessLog.integrationId, id), eq(credentialAccessLog.action, 'rotated')),
			)
		expect(rotated).toHaveLength(1)
		expect(rotated[0]).toMatchObject({ source: 'replace_value', actorId: getTestActorId() })
		const [event] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, id), eq(events.action, 'updated')))
		const text = JSON.stringify(event?.data)
		expect(text).not.toContain(next)
		expect(text).not.toContain(fake('old'))
		expect((await verifyCredentialAccessChain(db, s.ws.id)).ok).toBe(true)
	})

	it('runs the value rule and leaves the old value in place when it fails', async () => {
		const s = await setup()
		const id = await vault(s, 'Rotating', fake('old'), [s.ids.infra])
		const before = await reload(id)

		const quote = await replaceValue(s.ws.id, id, 'has"quote')
		const newline = await replaceValue(s.ws.id, id, 'trailing-newline\n')

		expect(quote.status).toBe(400)
		expect(newline.status).toBe(400)
		expect(JSON.stringify(await quote.json())).not.toContain('has"quote')
		expect((await reload(id)).credentials).toBe(before.credentials)
		expect(
			await db
				.select()
				.from(credentialAccessLog)
				.where(
					and(eq(credentialAccessLog.integrationId, id), eq(credentialAccessLog.action, 'rotated')),
				),
		).toHaveLength(0)
	})

	it('answers 404 for an unknown id and 409 for a key that is no longer active', async () => {
		const s = await setup()
		const id = await vault(s, 'Gone', fake('old'), [])
		await db
			.update(integrations)
			.set({ status: 'undone', credentials: null, dekCiphertext: null })
			.where(eq(integrations.id, id))

		expect(
			(await replaceValue(s.ws.id, '00000000-0000-4000-8000-000000000000', fake('x'))).status,
		).toBe(404)
		expect((await replaceValue(s.ws.id, id, fake('x'))).status).toBe(409)
		// A tool server is not an API key.
		expect((await replaceValue(s.ws.id, s.rows.cfApi, fake('x'))).status).toBe(409)
	})

	it('lets a running session keep the old value while the next launch gets the new one', async () => {
		const s = await setup()
		const id = await vault(s, 'Rotating', fake('old'), [s.ids.infra])
		const manager = new SessionManager(db, {
			put: async () => {},
			get: async () => Buffer.from(''),
			list: async () => [],
			delete: async () => {},
			exists: async () => false,
			ensureBucket: async () => {},
		})
		const launch = async () => {
			const created = await insertSession(db, s.ws.id, s.ids.infra, getTestActorId(), {
				status: 'pending',
				containerId: null,
			})
			const [row] = await db.select().from(sessions).where(eq(sessions.id, created.id))
			return (await manager.buildLaunchSpec(row as typeof sessions.$inferSelect)).env
		}
		try {
			const running = await launch()
			await replaceValue(s.ws.id, id, fake('new'))
			const next = await launch()

			// The running session was handed its env at launch; nothing can change it.
			expect(running.KEYCHAIN_BYO_APIKEY_ROTATING).toBe(fake('old'))
			expect(next.KEYCHAIN_BYO_APIKEY_ROTATING).toBe(fake('new'))
		} finally {
			await manager.stop()
		}
	})
})
