import { extensions, integrations } from '@maskin/db/schema'
import { MAX_EXTENSION_TOOLS } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { encrypt } from '../../lib/crypto'
import {
	buildExtensionMcpServers,
	resolveMcpFromExtension,
} from '../../lib/integrations/extensions-db'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))

const { capturePosthogEvent } = await import('../../lib/analytics/posthog')

// Tech spec section 3 and 5d against real Postgres: which extensions the shim
// picks up for a workspace, the key it attaches them under, and the tool cap.

function mcpConfig(toolCount: number, overrides: Record<string, unknown> = {}) {
	return {
		envKey: 'AUTHORIZATION',
		server: {
			type: 'stdio',
			command: 'npx',
			args: ['mcp-remote', 'https://example.com/mcp'],
			envFromCredential: 'AUTHORIZATION',
		},
		autoInject: true,
		credentialProvider: 'extension-mcp:example',
		tools: Array.from({ length: toolCount }, (_, i) => ({
			name: `get_item_${String(i).padStart(2, '0')}`,
			kind: 'read' as const,
		})),
		...overrides,
	}
}

describe('resolveMcpFromExtension and buildExtensionMcpServers', () => {
	let workspaceId: string
	const readCredential = vi.fn()

	async function addExtension(slug: string, values: Partial<typeof extensions.$inferInsert> = {}) {
		const [row] = await db
			.insert(extensions)
			.values({
				workspaceId,
				slug,
				name: slug,
				status: 'active',
				mcpConfig: mcpConfig(2) as never,
				createdBy: getTestActorId(),
				...values,
			})
			.returning()
		if (!row) throw new Error('insert failed')
		return row
	}

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		readCredential.mockReset()
		vi.mocked(capturePosthogEvent).mockClear()
	})

	it('returns nothing for a workspace with no extensions', async () => {
		expect(await resolveMcpFromExtension(db, workspaceId)).toEqual([])
	})

	it('returns only the active extension that has an auto-inject mcp_config', async () => {
		await addExtension('beta')
		await addExtension('alpha')
		await addExtension('disabled-one', { status: 'disabled' })
		await addExtension('webhook-only', { mcpConfig: null })
		await addExtension('manual', { mcpConfig: mcpConfig(2, { autoInject: false }) as never })

		const found = await resolveMcpFromExtension(db, workspaceId)
		expect(found.map((e) => e.slug)).toEqual(['alpha', 'beta'])
	})

	it("does not pick up another workspace's extensions", async () => {
		await addExtension('mine')
		const otherWs = (await insertWorkspace(db, getTestActorId())).id
		expect(await resolveMcpFromExtension(db, otherWs)).toEqual([])
	})

	it('carries the credential row id but never its credentials', async () => {
		await addExtension('example')
		const [cred] = await db
			.insert(integrations)
			.values({
				workspaceId,
				provider: 'extension-mcp:example',
				status: 'active',
				credentials: encrypt('secret-key'),
				config: {},
				actorId: null,
				createdBy: getTestActorId(),
			})
			.returning()

		const [entry] = await resolveMcpFromExtension(db, workspaceId)
		expect(entry?.credentialIntegrationId).toBe(cred?.id)
		expect(JSON.stringify(entry)).not.toContain('secret-key')
	})

	it('attaches under extension-{slug} with the key as a Bearer value', async () => {
		await addExtension('example')
		readCredential.mockResolvedValue('abc123')

		const { servers, env } = await buildExtensionMcpServers(db, workspaceId, readCredential)

		expect(Object.keys(servers)).toEqual(['extension-example'])
		expect(servers['extension-example']).toEqual({
			type: 'stdio',
			command: 'npx',
			args: ['mcp-remote', 'https://example.com/mcp'],
		})
		expect(env).toEqual({ AUTHORIZATION: 'Bearer abc123' })
	})

	it('attaches an extension with exactly 20 tools and writes no error', async () => {
		const row = await addExtension('twenty', {
			mcpConfig: mcpConfig(MAX_EXTENSION_TOOLS) as never,
		})
		readCredential.mockResolvedValue('k')

		const { servers } = await buildExtensionMcpServers(db, workspaceId, readCredential)

		expect(Object.keys(servers)).toEqual(['extension-twenty'])
		const [after] = await db.select().from(extensions).where(eq(extensions.id, row.id))
		expect(after?.mcpLastError).toBeNull()
		expect(capturePosthogEvent).not.toHaveBeenCalled()
	})

	it('skips an extension with 21 tools, records the error and fires the event', async () => {
		const row = await addExtension('twenty-one', {
			mcpConfig: mcpConfig(MAX_EXTENSION_TOOLS + 1) as never,
		})
		readCredential.mockResolvedValue('k')

		const { servers, env } = await buildExtensionMcpServers(db, workspaceId, readCredential)

		expect(servers).toEqual({})
		expect(env).toEqual({})
		expect(readCredential).not.toHaveBeenCalled()
		const [after] = await db.select().from(extensions).where(eq(extensions.id, row.id))
		expect(after?.mcpLastError).toBe('tool cap exceeded: 21/20')
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'extension_mcp_tool_cap_exceeded',
			workspaceId,
			{ extension_id: row.id, slug: 'twenty-one', tool_count: 21 },
		)
	})

	it('does not attach anything when no key reader is wired', async () => {
		const row = await addExtension('example')
		const { servers, env } = await buildExtensionMcpServers(db, workspaceId, null)
		expect(servers).toEqual({})
		expect(env).toEqual({})
		const [after] = await db.select().from(extensions).where(eq(extensions.id, row.id))
		expect(after?.mcpLastError).toBeNull()
	})

	it('does not attach when the key cannot be read, and records why', async () => {
		const row = await addExtension('example')
		readCredential.mockResolvedValue(null)

		const { servers, env } = await buildExtensionMcpServers(db, workspaceId, readCredential)

		expect(servers).toEqual({})
		expect(env).toEqual({})
		const [after] = await db.select().from(extensions).where(eq(extensions.id, row.id))
		expect(after?.mcpLastError).toBe('key not readable')
	})

	it('does not pick up the webhook signing-secret row as the key row', async () => {
		await addExtension('example')
		await db.insert(integrations).values({
			workspaceId,
			provider: 'extension:example',
			status: 'active',
			credentials: encrypt('signing-secret'),
			config: {},
			actorId: null,
			createdBy: getTestActorId(),
		})
		const [entry] = await resolveMcpFromExtension(db, workspaceId)
		expect(entry?.credentialIntegrationId).toBeNull()
	})

	it('does not attach the http variant', async () => {
		await addExtension('http-one', {
			mcpConfig: mcpConfig(1, {
				server: { type: 'http', url: 'https://example.com/mcp' },
			}) as never,
		})
		const { servers } = await buildExtensionMcpServers(db, workspaceId, readCredential)
		expect(servers).toEqual({})
	})
})
