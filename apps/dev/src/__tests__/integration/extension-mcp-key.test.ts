import { integrations } from '@maskin/db/schema'
import { mcpRemoteServer } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { decrypt } from '../../lib/crypto'
import extensionsRoutes from '../../routes/extensions'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/integration-events', () => ({
	trackIntegrationConnected: vi.fn().mockResolvedValue(undefined),
}))

// The MCP API key goes on its own row (provider extension-mcp:{slug}), apart
// from the webhook signing secret (extension:{slug}), and is never returned.

const KEY = 'sk-mcp-key-123'
const SECRET = 'f'.repeat(64)

function buildApp(role = 'owner') {
	const inner = createIntegrationApp({ path: '/api/extensions', module: extensionsRoutes })
	const app = new Hono<{ Variables: { workspaceRole?: string } }>()
	app.use('*', async (c, next) => {
		c.set('workspaceRole', role)
		await next()
	})
	app.route('/', inner)
	return app
}

function mcpBody(overrides: Record<string, unknown> = {}) {
	return {
		slug: 'acme',
		name: 'Acme',
		mcp_config: {
			envKey: 'AUTHORIZATION',
			server: mcpRemoteServer('https://example.com/mcp', true),
			autoInject: true,
			credentialProvider: 'extension-mcp:acme',
			tools: [{ name: 'get_item', kind: 'read' }],
		},
		mcp_api_key: KEY,
		...overrides,
	}
}

async function rowsFor(workspaceId: string, provider: string) {
	return db
		.select()
		.from(integrations)
		.where(and(eq(integrations.workspaceId, workspaceId), eq(integrations.provider, provider)))
}

describe('extension MCP key (integration)', () => {
	let workspaceId: string
	const headers = () => ({ 'x-workspace-id': workspaceId })

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	it('stores the key encrypted on its own row and never returns it', async () => {
		const res = await buildApp().request(
			jsonRequest('POST', '/api/extensions', mcpBody(), headers()),
		)
		expect(res.status).toBe(201)
		const json = (await res.json()) as { hasMcpKey: boolean; hasSigningSecret: boolean }
		expect(json.hasMcpKey).toBe(true)
		expect(json.hasSigningSecret).toBe(false)
		expect(JSON.stringify(json)).not.toContain(KEY)

		const [row] = await rowsFor(workspaceId, 'extension-mcp:acme')
		expect(row?.credentials).not.toContain(KEY)
		expect(decrypt(row?.credentials ?? '')).toBe(KEY)
		expect(await rowsFor(workspaceId, 'extension:acme')).toHaveLength(0)
	})

	it('keeps the webhook signing secret and the MCP key apart', async () => {
		const app = buildApp()
		const body = mcpBody({
			webhook_config: {
				signatureScheme: 'hmac-sha256',
				signatureHeader: 'X-Sig',
				eventMap: {
					externalIdPath: '$.id',
					entityType: { literal: 'acme.thing' },
					action: { literal: 'ready' },
				},
			},
			signing_secret: SECRET,
		})
		const res = await app.request(jsonRequest('POST', '/api/extensions', body, headers()))
		expect(res.status).toBe(201)
		const [secretRow] = await rowsFor(workspaceId, 'extension:acme')
		const [keyRow] = await rowsFor(workspaceId, 'extension-mcp:acme')
		expect(decrypt(secretRow?.credentials ?? '')).toBe(SECRET)
		expect(decrypt(keyRow?.credentials ?? '')).toBe(KEY)
	})

	it('replaces the key on update and leaves it alone when none is sent', async () => {
		const app = buildApp()
		const created = (await (
			await app.request(jsonRequest('POST', '/api/extensions', mcpBody(), headers()))
		).json()) as { id: string }

		const renamed = await app.request(
			jsonRequest('PATCH', `/api/extensions/${created.id}`, { name: 'Acme 2' }, headers()),
		)
		expect(renamed.status).toBe(200)
		const [kept] = await rowsFor(workspaceId, 'extension-mcp:acme')
		expect(decrypt(kept?.credentials ?? '')).toBe(KEY)

		const replaced = await app.request(
			jsonRequest('PATCH', `/api/extensions/${created.id}`, { mcp_api_key: 'sk-new' }, headers()),
		)
		expect(replaced.status).toBe(200)
		const rows = await rowsFor(workspaceId, 'extension-mcp:acme')
		expect(rows).toHaveLength(1)
		expect(decrypt(rows[0]?.credentials ?? '')).toBe('sk-new')
	})

	it('rejects an http-transport mcp_config and more than 20 tools', async () => {
		const app = buildApp()
		const http = mcpBody({
			mcp_config: {
				envKey: 'X',
				server: { type: 'http', url: 'https://example.com/mcp' },
				credentialProvider: 'extension-mcp:acme',
				tools: [],
			},
		})
		expect(
			(await app.request(jsonRequest('POST', '/api/extensions', http, headers()))).status,
		).toBe(400)

		const tools = Array.from({ length: 21 }, (_, i) => ({ name: `get_${i}`, kind: 'read' }))
		const tooMany = mcpBody({
			mcp_config: { ...mcpBody().mcp_config, tools },
		})
		expect(
			(await app.request(jsonRequest('POST', '/api/extensions', tooMany, headers()))).status,
		).toBe(400)
		expect(await rowsFor(workspaceId, 'extension-mcp:acme')).toHaveLength(0)
	})

	it('only lets an owner or admin store a key', async () => {
		const res = await buildApp('member').request(
			jsonRequest('POST', '/api/extensions', mcpBody(), headers()),
		)
		expect(res.status).toBe(403)
		expect(await rowsFor(workspaceId, 'extension-mcp:acme')).toHaveLength(0)
	})
})
