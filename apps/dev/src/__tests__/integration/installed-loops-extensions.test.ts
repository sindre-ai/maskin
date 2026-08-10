import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { marketplaceLoopItems, marketplaceLoops, workspaces } from '@maskin/db/schema'
import crmExtension from '@maskin/ext-crm/server'
import { registerModule } from '@maskin/module-sdk'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

// Extensions are installed from the marketplace now that the Settings → General
// toggles are gone, so this suite covers the 'extension' marketplace item type
// end to end against real Postgres:
//
//   * the 0052 check-constraint actually admits item_type = 'extension' (a
//     mocked-DB test cannot see a CHECK violation at all)
//   * installing merges the extension into workspaces.settings.enabled_modules
//     (a pre-existing settings key) and seeds its defaults without clobbering
//     the installer's own edits
//   * a second install is a no-op rather than duplicating the extension id
//
// The integration harness doesn't load src/__tests__/register-extensions.ts
// (that's the unit config's setupFile), so register the extension the same way
// src/extensions.ts does in production — applyExtensionSnapshot reads its
// defaults from the live registry.
registerModule(crmExtension)

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
	}
}

function createMemoryStorage(): StorageProvider {
	const store = new Map<string, Buffer>()
	return {
		async put(key, data) {
			store.set(key, Buffer.isBuffer(data) ? data : Buffer.from(data as Uint8Array))
		},
		async get(key) {
			const buf = store.get(key)
			if (!buf) throw new Error(`Not found: ${key}`)
			return buf
		},
		async list(prefix) {
			return [...store.keys()].filter((k) => k.startsWith(prefix))
		},
		async listWithMetadata(prefix) {
			return [...store.entries()]
				.filter(([k]) => k.startsWith(prefix))
				.map(([key, buf]) => ({ key, size: buf.length }))
		},
		async delete(key) {
			store.delete(key)
		},
		async exists(key) {
			return store.has(key)
		},
		async ensureBucket() {
			// no-op
		},
	}
}

function makeApp(actorId: string) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})
	const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('agentStorage', agentStorage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	return app
}

/** A marketplace loop carrying a single 'extension' item for the CRM extension. */
async function seedCrmExtensionLoop() {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'CRM Extension',
			slug: `crm-extension-loop-${randomUUID()}`,
			description: 'Adds the CRM extension: contacts and companies.',
			version: '1.0.0',
			useCase: 'Extensions',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')

	const sourceItemId = randomUUID()
	await db.insert(marketplaceLoopItems).values({
		loopId: loop.id,
		itemType: 'extension',
		sourceItemId,
		itemSnapshot: { extensionId: 'crm', name: 'CRM', description: 'Contacts and companies.' },
	})

	return { loop, sourceItemId }
}

async function readSettings(workspaceId: string): Promise<Record<string, unknown>> {
	const [row] = await db
		.select({ settings: workspaces.settings })
		.from(workspaces)
		.where(eq(workspaces.id, workspaceId))
		.limit(1)
	return (row?.settings as Record<string, unknown> | null) ?? {}
}

describe('installing a marketplace loop that ships an extension', () => {
	let actorId: string
	let workspaceId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId, { settings: { enabled_modules: ['work'] } })
		workspaceId = ws.id
	})

	it('accepts item_type = extension — the 0052 check constraint admits it', async () => {
		const { loop, sourceItemId } = await seedCrmExtensionLoop()
		const [item] = await db
			.select()
			.from(marketplaceLoopItems)
			.where(eq(marketplaceLoopItems.loopId, loop.id))
		expect(item?.itemType).toBe('extension')
		expect(item?.sourceItemId).toBe(sourceItemId)
	})

	it('enables the extension and seeds its defaults into workspace settings', async () => {
		const { loop } = await seedCrmExtensionLoop()
		const app = makeApp(actorId)

		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { provisioned: { extensions: number } }
		expect(body.provisioned.extensions).toBe(1)

		const settings = await readSettings(workspaceId)
		expect(settings.enabled_modules).toEqual(['work', 'crm'])
		// CRM's own object types arrive with the extension.
		expect(Object.keys(settings.statuses as Record<string, unknown>)).toEqual(
			expect.arrayContaining(['contact', 'company']),
		)
		expect((settings.display_names as Record<string, string>).contact).toBe('Contact')
		expect(settings.relationship_types).toEqual(expect.arrayContaining(['works_at']))
	})

	it('never overwrites settings the workspace already configured', async () => {
		// The installer renamed Contact before installing — the extension's default
		// display name must not clobber it.
		await db
			.update(workspaces)
			.set({
				settings: {
					enabled_modules: ['work'],
					display_names: { contact: 'Person' },
					statuses: { contact: ['mine'] },
				},
			})
			.where(eq(workspaces.id, workspaceId))

		const { loop } = await seedCrmExtensionLoop()
		const app = makeApp(actorId)
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)

		const settings = await readSettings(workspaceId)
		expect((settings.display_names as Record<string, string>).contact).toBe('Person')
		expect((settings.statuses as Record<string, string[]>).contact).toEqual(['mine'])
		// The types the workspace hadn't touched still get their defaults.
		expect((settings.display_names as Record<string, string>).company).toBe('Company')
	})

	it('is a no-op when another loop already enabled the extension — no duplicate id', async () => {
		const first = await seedCrmExtensionLoop()
		const second = await seedCrmExtensionLoop()
		const app = makeApp(actorId)

		await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId: first.loop.id, workspaceId }),
		)
		const res = await app.request(
			jsonRequest('POST', '/api/installed-loops', { loopId: second.loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)
		// Already enabled → reported as a reuse, not a fresh provision.
		const body = (await res.json()) as { provisioned: { extensions: number } }
		expect(body.provisioned.extensions).toBe(0)

		const settings = await readSettings(workspaceId)
		expect(settings.enabled_modules).toEqual(['work', 'crm'])
	})
})
