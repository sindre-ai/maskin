import { randomBytes } from 'node:crypto'
import { MasterKeyProvider } from '@maskin/auth/kms'
import {
	events,
	agentGrants,
	credentialAccessLog,
	extensions,
	integrations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn(async () => {}) }))

import { upsertExtensionMcpKey } from '../../lib/integrations/extensions-db'
import { setKmsProviderForTests } from '../../lib/keychain-kms'
import { SessionManager } from '../../services/session-manager'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// The extension MCP key is read through Keychain at session launch: the server
// attaches only when getCredential lets this agent read the key, and the read
// leaves one audit row. Run through the real launch spec against Postgres.

// Obviously fake, built at runtime so no token-shaped literal sits in the repo.
const fake = (label: string) => `fake-${label}-${'0123456789'.repeat(3)}`

beforeAll(() => {
	setKmsProviderForTests(new MasterKeyProvider(randomBytes(32)))
})
afterAll(() => {
	setKmsProviderForTests(undefined)
})

function stubStorage(): StorageProvider {
	return {
		put: async () => {},
		get: async () => Buffer.from(''),
		list: async () => [],
		delete: async () => {},
		exists: async () => false,
		ensureBucket: async () => {},
	}
}

const mcpConfig = {
	envKey: 'AUTHORIZATION',
	server: {
		type: 'stdio',
		command: 'npx',
		args: [
			'mcp-remote',
			'https://mcp.example.com/mcp',
			'--header',
			'Authorization:${AUTHORIZATION}',
		],
		envFromCredential: 'AUTHORIZATION',
	},
	autoInject: true,
	credentialProvider: 'extension-mcp:example',
	tools: [{ name: 'get_item', kind: 'read' }],
}

async function setup() {
	const human = getTestActorId()
	const ws = await insertWorkspace(db, human, {
		enterpriseGranted: true,
		settings: { llm_keys: { anthropic: 'sk-ant-test' } },
	})
	const agent = await insertActor(db, { type: 'agent', systemPrompt: 'Agent' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId: ws.id, actorId: agent.id, role: 'member' })
	const [extension] = await db
		.insert(extensions)
		.values({
			workspaceId: ws.id,
			slug: 'example',
			name: 'Example',
			status: 'active',
			mcpConfig: mcpConfig as never,
			toolGrants: { [agent.id]: { get_item: 'allow' } },
			createdBy: human,
		})
		.returning()
	if (!extension) throw new Error('extension insert failed')
	const created = await insertSession(db, ws.id, agent.id, human, {
		status: 'pending',
		containerId: null,
	})
	const [session] = await db.select().from(sessions).where(eq(sessions.id, created.id))
	return { human, ws, agent, extension, session: session as typeof sessions.$inferSelect }
}

async function saveKey(s: Awaited<ReturnType<typeof setup>>, key: string) {
	await upsertExtensionMcpKey(db, {
		workspaceId: s.ws.id,
		slug: 'example',
		key,
		createdBy: s.human,
	})
	const [row] = await db
		.select()
		.from(integrations)
		.where(
			and(
				eq(integrations.workspaceId, s.ws.id),
				eq(integrations.provider, 'extension-mcp:example'),
			),
		)
	if (!row) throw new Error('key row missing')
	return row
}

async function launch(session: typeof sessions.$inferSelect) {
	const manager = new SessionManager(db, stubStorage())
	try {
		return (await manager.buildLaunchSpec(session)).env
	} finally {
		await manager.stop()
	}
}

const readsOf = (integrationId: string) =>
	db
		.select()
		.from(credentialAccessLog)
		.where(
			and(
				eq(credentialAccessLog.integrationId, integrationId),
				eq(credentialAccessLog.action, 'read'),
			),
		)

const lastError = async (extensionId: string) => {
	const [row] = await db.select().from(extensions).where(eq(extensions.id, extensionId))
	return row?.mcpLastError
}

describe('SessionManager.buildLaunchSpec: extension MCP key read through Keychain (Integration)', () => {
	it('attaches the server with the key as Bearer and writes one audit row', async () => {
		const s = await setup()
		const key = fake('mcp-key')
		const row = await saveKey(s, key)

		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toBe(`Bearer ${key}`)
		const servers = JSON.parse(env.MCP_SERVERS_JSON as string).mcpServers
		expect(Object.keys(servers)).toContain('extension-example')
		// The key is in the Bearer env only: not in the server entry, the args or any config JSON.
		expect(JSON.stringify(servers['extension-example'])).toContain('${AUTHORIZATION}')
		for (const [name, value] of Object.entries(env)) {
			if (name !== 'AUTHORIZATION') expect(value).not.toContain(key)
		}
		expect(await lastError(s.extension.id)).toBeNull()

		const reads = await readsOf(row.id)
		expect(reads).toHaveLength(1)
		expect(reads[0]).toMatchObject({
			actorId: s.agent.id,
			sessionId: s.session.id,
			outboundTarget: 'mcp.example.com',
		})
	})

	it('does not attach, read the key or write an audit row for an agent with no grant on the extension', async () => {
		const s = await setup()
		const key = fake('mcp-key')
		const row = await saveKey(s, key)
		await db.update(extensions).set({ toolGrants: {} }).where(eq(extensions.id, s.extension.id))

		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toBeUndefined()
		expect(env.MCP_SERVERS_JSON).not.toContain('extension-example')
		for (const value of Object.values(env)) expect(value).not.toContain(key)
		expect(await readsOf(row.id)).toEqual([])
		expect(await lastError(s.extension.id)).toBeNull()
	})

	it('does not attach for an agent when only another agent holds the grant', async () => {
		const s = await setup()
		const other = await insertActor(db, { type: 'agent', systemPrompt: 'Other' })
		await db.update(extensions).set({ toolGrants: { [other.id]: { get_item: 'allow' } } }).where(eq(extensions.id, s.extension.id))
		const row = await saveKey(s, fake('mcp-key'))

		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toBeUndefined()
		expect(await readsOf(row.id)).toEqual([])
	})

	it('needs no grant row: the key saved through the write path is readable by the workspace', async () => {
		const s = await setup()
		const row = await saveKey(s, fake('mcp-key'))

		expect(row.providerMode).toBe('registered')
		expect(
			await db.select().from(agentGrants).where(eq(agentGrants.integrationId, row.id)),
		).toEqual([])
		expect((await launch(s.session)).AUTHORIZATION).toMatch(/^Bearer fake-mcp-key/)
	})

	it('reads the replaced key after Replace key', async () => {
		const s = await setup()
		await saveKey(s, fake('old'))
		const second = fake('new')
		await saveKey(s, second)

		expect((await launch(s.session)).AUTHORIZATION).toBe(`Bearer ${second}`)
	})

	it('clears a stale "key not readable" once the key is saved and the server attaches', async () => {
		const s = await setup()
		await launch(s.session)
		expect(await lastError(s.extension.id)).toBe('key not readable')

		await saveKey(s, fake('mcp-key'))
		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toMatch(/^Bearer fake-mcp-key/)
		expect(await lastError(s.extension.id)).toBeNull()
	})

	it('leaves the server off when the read is denied, and the session still builds', async () => {
		const s = await setup()
		const row = await saveKey(s, fake('mcp-key'))
		await db
			.update(integrations)
			.set({ defaultAgentAccess: 'none' })
			.where(eq(integrations.id, row.id))

		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toBeUndefined()
		expect(env.MCP_SERVERS_JSON).not.toContain('extension-example')
		expect(await lastError(s.extension.id)).toBe('key not readable')
		expect(await readsOf(row.id)).toEqual([])
		const denied = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, s.ws.id), eq(events.action, 'credential_scope_denied')))
		expect(denied).toHaveLength(1)
	})

	it('leaves the server off when no key was saved', async () => {
		const s = await setup()

		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toBeUndefined()
		expect(env.MCP_SERVERS_JSON).not.toContain('extension-example')
		expect(await lastError(s.extension.id)).toBe('key not readable')
	})

	it('does not read a key saved under the same slug in another workspace', async () => {
		const s = await setup()
		const other = await setup()
		const otherRow = await saveKey(other, fake('elsewhere'))

		const env = await launch(s.session)

		expect(env.AUTHORIZATION).toBeUndefined()
		expect(await readsOf(otherRow.id)).toEqual([])
	})
})
