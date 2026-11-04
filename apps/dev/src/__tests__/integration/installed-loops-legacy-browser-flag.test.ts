import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { actors, marketplaceLoopItems, marketplaceLoops } from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, sql } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import { actorSnapshot } from '../../lib/marketplace-loops/loop-snapshot'
import { AgentStorageManager } from '../../services/agent-storage'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: { db: Database; actorId: string; agentStorage: AgentStorageManager }
}

// Install writes no skills here, so storage is never touched — a stub is enough.
const noopStorage = {
	async put() {},
	async get(): Promise<Buffer> {
		throw new Error('not used')
	},
	async list() {
		return []
	},
	async listWithMetadata() {
		return []
	},
	async delete() {},
	async exists() {
		return false
	},
	async ensureBucket() {},
} as unknown as StorageProvider

function createInstalledLoopsApp() {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) =>
			result.success
				? undefined
				: c.json(
						createApiError(
							'VALIDATION_ERROR',
							'Request validation failed',
							formatZodError(result.error),
						),
						400,
					),
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', getTestActorId())
		c.set('agentStorage', new AgentStorageManager(noopStorage, db))
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	return app
}

/**
 * Install a loop whose stored snapshot is exactly what an older publisher wrote
 * for an agent that had a browser: `tools: { browser: true }`. The browser
 * sidecar is gone, so installing it must neither carry the dead flag onto the
 * new actor nor build a Playwright MCP entry from it.
 */
async function seedLegacyBrowserLoop() {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Growth Kit',
			slug: `growth-kit-${randomUUID()}`,
			description: 'Events and outreach',
			version: '1.0.0',
			useCase: 'growth',
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')

	const sourceItemId = randomUUID()
	await db.insert(marketplaceLoopItems).values({
		loopId: loop.id,
		itemType: 'actor',
		sourceItemId,
		itemSnapshot: {
			type: 'agent',
			name: 'Event Producer',
			description: 'Runs meetups end to end',
			systemPrompt: 'You run meetups.',
			llmProvider: 'anthropic',
			llmConfig: {},
			tools: { browser: true },
		},
	})
	return { loop, sourceItemId }
}

describe('Installed loops — legacy browser flag', () => {
	let workspaceId: string

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
	})

	it('publishes a browser MCP entry as nothing, and keeps the publisher secret out of the snapshot', () => {
		const snapshot = actorSnapshot({
			type: 'agent',
			name: 'Event Producer',
			description: 'Runs meetups end to end',
			systemPrompt: 'You run meetups.',
			llmProvider: 'anthropic',
			llmConfig: {},
			tools: {
				mcpServers: {
					playwright: {
						type: 'stdio',
						command: 'npx',
						args: ['@playwright/mcp@latest', '--cdp-endpoint', '${BROWSER_CDP_URL}'],
					},
					hubspot: { command: 'npx', env: { HUBSPOT_TOKEN: 'pat-live-publisher-secret' } },
				},
			},
		})
		expect(snapshot.tools).toEqual({})
		expect(JSON.stringify(snapshot)).not.toContain('pat-live-publisher-secret')
	})

	it('installs an old snapshot without the browser flag and without a Playwright entry', async () => {
		const { loop, sourceItemId } = await seedLegacyBrowserLoop()

		const res = await createInstalledLoopsApp().request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)
		const installed = await res.json()
		expect(installed.provisioned).toMatchObject({ actors: 1 })

		const [actorRow] = await db
			.select({ tools: actors.tools })
			.from(actors)
			.where(
				and(
					sql`${actors.metadata}->>'installed_loop_id' = ${installed.id}`,
					sql`${actors.metadata}->>'source_item_id' = ${sourceItemId}`,
				),
			)
		if (!actorRow) throw new Error('provisioned actor row not found')

		const persisted = JSON.stringify(actorRow.tools)
		expect(persisted).not.toContain('browser')
		expect(persisted).not.toContain('playwright')
		expect(persisted).not.toContain('BROWSER_CDP_URL')
	})
})
