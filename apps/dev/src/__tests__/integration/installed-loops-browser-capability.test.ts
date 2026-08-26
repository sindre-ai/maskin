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
 * Publish a loop the way the real publisher does: run the actor's live row —
 * browser MCP entry, hardcoded third-party secret and all — through
 * actorSnapshot(), and store exactly what that produces. Nothing here is
 * hand-written, so the test fails if publishing ever stops carrying the
 * capability across, and it proves the secret really is gone.
 */
async function seedPublishedBrowserAgent() {
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

	const snapshot = actorSnapshot({
		type: 'agent',
		name: 'Event Producer',
		description: 'Runs meetups end to end',
		systemPrompt: 'You have a Playwright MCP — publish on Meetup and Luma with it.',
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

	const sourceItemId = randomUUID()
	await db.insert(marketplaceLoopItems).values({
		loopId: loop.id,
		itemType: 'actor',
		sourceItemId,
		itemSnapshot: snapshot,
	})

	return { loop, sourceItemId, snapshot }
}

describe('Installed loops — browser capability survives publish → install', () => {
	let workspaceId: string

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		const ws = await insertWorkspace(db, getTestActorId())
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
	})

	it('installs an agent whose persisted tools provision a browser sidecar, without carrying the publisher secret', async () => {
		const { loop, sourceItemId, snapshot } = await seedPublishedBrowserAgent()

		// The published snapshot itself: capability kept, config (and its secret) gone.
		expect(snapshot.tools).toEqual({ browser: true })
		expect(JSON.stringify(snapshot)).not.toContain('pat-live-publisher-secret')

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

		// This is the row session-manager.ts reads to build AGENT_MCP_JSON, read
		// back out of real Postgres after a real round-trip through jsonb.
		const persisted = JSON.stringify(actorRow.tools)
		expect(persisted).toContain('@playwright/mcp')
		// needsBrowserSidecar() matches this exact placeholder — no placeholder,
		// no Chromium, and the agent reports "No Playwright in this session".
		expect(persisted).toContain('${BROWSER_CDP_URL}')
		expect(persisted).not.toContain('pat-live-publisher-secret')
	})

	it('leaves an agent without the capability with no browser MCP entry', async () => {
		const [loop] = await db
			.insert(marketplaceLoops)
			.values({
				name: 'Ops Kit',
				slug: `ops-kit-${randomUUID()}`,
				description: 'No browser here',
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
			itemSnapshot: actorSnapshot({
				type: 'agent',
				name: 'SalesOps',
				description: 'No browser',
				systemPrompt: 'You do ops.',
				llmProvider: 'anthropic',
				llmConfig: {},
				tools: { mcpServers: { hubspot: { command: 'npx' } } },
			}),
		})

		const res = await createInstalledLoopsApp().request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId }),
		)
		expect(res.status).toBe(201)
		const installed = await res.json()

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
		expect(JSON.stringify(actorRow.tools)).not.toContain('BROWSER_CDP_URL')
	})
})
