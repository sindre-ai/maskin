import { events, integrations } from '@maskin/db/schema'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { and, eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DriveError } from '../../lib/integrations/providers/google-drive/errors'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Real-Postgres coverage for the first_tool_call_at stamp. The customer UI reads
// has-ingested from integrations.config.first_tool_call_at, so the conditional
// jsonb write has to hold against the real schema: set on the first successful
// call, never moved by a later one, never set by an errored one. The Drive HTTP
// surface and the token lookup are faked; the integrations UPDATE is real.

const getToken = vi.fn()
vi.mock('../../lib/integrations/providers/google-drive/token', () => ({
	getGoogleDriveAccessToken: (...args: unknown[]) => getToken(...args),
}))

vi.mock('../../lib/analytics/mcp-tool-calls', async (orig) => ({
	...(await orig<typeof import('../../lib/analytics/mcp-tool-calls')>()),
	captureMcpToolCall: vi.fn(),
}))
vi.mock('../../lib/analytics/posthog', () => ({ capturePosthogEvent: vi.fn() }))

const { createGoogleDriveMcpServer } = await import(
	'../../lib/integrations/providers/google-drive/mcp-server'
)

async function connect(workspaceId: string, actorId: string) {
	const server = createGoogleDriveMcpServer({ db, workspaceId, actorId })
	const [clientT, serverT] = InMemoryTransport.createLinkedPair()
	const client = new Client({ name: 'test', version: '0.0.0' })
	await Promise.all([server.connect(serverT), client.connect(clientT)])
	return client
}

async function seedDriveRow(
	workspaceId: string,
	actorId: string,
	overrides: Partial<typeof integrations.$inferInsert> = {},
) {
	const [row] = await db
		.insert(integrations)
		.values({
			workspaceId,
			provider: 'google-drive',
			status: 'active',
			externalId: 'priya@acme.test',
			credentials: '',
			config: { system_actor_id: 'sys', drive: { peopleId: '1' } },
			createdBy: actorId,
			...overrides,
		})
		.returning()
	return row as NonNullable<typeof row>
}

const readConfig = async (id: string) => {
	const [row] = await db.select().from(integrations).where(eq(integrations.id, id))
	return (row?.config ?? {}) as Record<string, unknown>
}

/** The stamp is fire and forget, so poll until it lands (or give up). */
async function waitForStamp(id: string): Promise<string | undefined> {
	for (let i = 0; i < 40; i++) {
		const stamp = (await readConfig(id)).first_tool_call_at
		if (typeof stamp === 'string') return stamp
		await new Promise((r) => setTimeout(r, 25))
	}
	return undefined
}

function mockDriveOk() {
	getToken.mockResolvedValue({ accessToken: 'tok', integrationId: 'ignored' })
	vi.spyOn(globalThis, 'fetch').mockImplementation(
		async () => new Response(JSON.stringify({ files: [] }), { status: 200 }),
	)
}

afterEach(() => {
	vi.restoreAllMocks()
	getToken.mockReset()
})

describe('google-drive first_tool_call_at stamp (real Postgres)', () => {
	it('stamps the first successful call, keeps the other config keys, and records an audit event', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const row = await seedDriveRow(ws.id, actorId)
		mockDriveOk()
		const client = await connect(ws.id, actorId)

		const res = await client.callTool({
			name: 'google_drive__search_files',
			arguments: { query: 'x' },
		})
		expect(res.isError).toBeFalsy()

		const stamp = await waitForStamp(row.id)
		expect(stamp).toBeDefined()
		expect(new Date(stamp as string).toISOString()).toBe(stamp)
		const config = await readConfig(row.id)
		expect(config.system_actor_id).toBe('sys')
		expect(config.drive).toEqual({ peopleId: '1' })

		const audit = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.workspaceId, ws.id),
					eq(events.entityType, 'integration'),
					eq(events.entityId, row.id),
				),
			)
		expect(audit).toHaveLength(1)
		expect(audit[0]?.action).toBe('updated')
	})

	it('a second successful call leaves the timestamp where the first put it', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const row = await seedDriveRow(ws.id, actorId)
		mockDriveOk()
		const client = await connect(ws.id, actorId)

		await client.callTool({ name: 'google_drive__search_files', arguments: { query: 'a' } })
		const first = await waitForStamp(row.id)
		expect(first).toBeDefined()

		await new Promise((r) => setTimeout(r, 15))
		await client.callTool({ name: 'google_drive__search_files', arguments: { query: 'b' } })
		await new Promise((r) => setTimeout(r, 150))

		expect((await readConfig(row.id)).first_tool_call_at).toBe(first)
		const audit = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, ws.id), eq(events.entityId, row.id)))
		expect(audit).toHaveLength(1)
	})

	it('an errored call never stamps', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const row = await seedDriveRow(ws.id, actorId)
		getToken.mockRejectedValue(
			new DriveError({ code: 'INTEGRATION_MISSING', message: 'No Drive connected.' }),
		)
		const client = await connect(ws.id, actorId)

		const res = await client.callTool({
			name: 'google_drive__search_files',
			arguments: { query: 'x' },
		})
		expect(res.isError).toBe(true)
		await new Promise((r) => setTimeout(r, 150))

		expect(await readConfig(row.id)).not.toHaveProperty('first_tool_call_at')
	})

	it('stamps a row whose config is empty', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		const row = await seedDriveRow(ws.id, actorId, { config: {} })
		mockDriveOk()
		const client = await connect(ws.id, actorId)

		await client.callTool({ name: 'google_drive__search_files', arguments: { query: 'x' } })

		expect(await waitForStamp(row.id)).toBeDefined()
	})

	it('only touches the calling workspace, and not a revoked row', async () => {
		const actorId = getTestActorId()
		const wsA = await insertWorkspace(db, actorId)
		const wsB = await insertWorkspace(db, actorId)
		const rowA = await seedDriveRow(wsA.id, actorId)
		const rowB = await seedDriveRow(wsB.id, actorId, { status: 'revoked' })
		mockDriveOk()
		const client = await connect(wsA.id, actorId)

		await client.callTool({ name: 'google_drive__search_files', arguments: { query: 'x' } })
		expect(await waitForStamp(rowA.id)).toBeDefined()

		const clientB = await connect(wsB.id, actorId)
		await clientB.callTool({ name: 'google_drive__search_files', arguments: { query: 'x' } })
		await new Promise((r) => setTimeout(r, 150))
		expect(await readConfig(rowB.id)).not.toHaveProperty('first_tool_call_at')
	})
})
