import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { marketplaceLoops, objects, triggers } from '@maskin/db/schema'
import { readLoopViews } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq, inArray } from 'drizzle-orm'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { seedMarketplaceLoops } from '../../lib/dev-bootstrap'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { bootstrapDefaultAgents } from '../../services/workspace-bootstrap'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		agentStorage: AgentStorageManager
		storageProvider: StorageProvider
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
	const storage = createMemoryStorage()
	const agentStorage = new AgentStorageManager(storage, db)
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('agentStorage', agentStorage)
		c.set('storageProvider', storage)
		await next()
	})
	app.route('/api/installed-loops', installedLoopsRoutes)
	return app
}

// End-to-end coverage of the marketplace install path for every seeded loop
// bundle (the ones dev-bootstrap.ts publishes on startup) — the exact path a
// user hits from the marketplace detail view's Install button. This is the
// regression gate for the "bundle install 500s on the first seeded loop" bug:
// each seeded bundle must install into a fresh workspace and return 201.
describe('Marketplace install — seeded bundle end-to-end', () => {
	let seededLoops: Array<{ id: string; slug: string; name: string }>

	beforeAll(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		await seedMarketplaceLoops(db)
		seededLoops = await db
			.select({
				id: marketplaceLoops.id,
				slug: marketplaceLoops.slug,
				name: marketplaceLoops.name,
			})
			.from(marketplaceLoops)
		if (seededLoops.length === 0) throw new Error('expected seeded marketplace loops')
	})

	beforeEach(async () => {
		await rawSql`TRUNCATE installed_loops CASCADE`
	})

	// Seeded slugs come from packages/shared/src/constants (matches
	// dev-bootstrap.ts's MARKETPLACE_SEED_CONFIGS). Naming the slug in the test
	// title (not just the DB row) means a CI failure names the exact bundle
	// that broke rather than a generic "install failed" line.
	const BUNDLE_SLUGS = [
		'market-competitor-watch-loop',
		'product-discovery-loop',
		'meeting-loop',
		'product-release-loop',
		'customer-voice-loop',
		'knowledge-wiki-loop',
		'product-usage-loop',
	] as const

	for (const slug of BUNDLE_SLUGS) {
		it(`installs the ${slug} bundle into a fresh workspace`, async () => {
			const actorId = getTestActorId()
			const ws = await insertWorkspace(db, actorId)
			if (!ws) throw new Error('workspace insert returned no row')
			// Match the real UI path: `POST /api/actors` seeds every fresh
			// workspace with the built-in default agents + their bundled skills
			// (workspace-context, maskin-voice, deep-research, …). A bundle
			// install then has to reconcile skill-name collisions against those
			// existing rows — the exact scenario the failing e2e run hit.
			const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
			await bootstrapDefaultAgents(db, agentStorage, ws.id, actorId)

			const loop = seededLoops.find((l) => l.slug === slug)
			if (!loop) throw new Error(`seeded loop ${slug} not found`)

			const app = makeApp(actorId)
			const res = await app.request(
				jsonRequest('POST', '/api/installed-loops', {
					loopId: loop.id,
					workspaceId: ws.id,
				}),
			)

			if (res.status !== 201) {
				const body = await res.text()
				throw new Error(`install of ${slug} returned ${res.status}: ${body}`)
			}
			const body = (await res.json()) as {
				id: string
				objectId: string | null
				provisioned: { actors: number; triggers: number; skills: number; integrations: number }
			}
			expect(body.id).toBeTruthy()
			expect(body.objectId).toBeTruthy()
			expect(
				body.provisioned.actors + body.provisioned.triggers + body.provisioned.skills,
			).toBeGreaterThan(0)

			// A bundle that ships custom views leaves their tabs on the loop page.
			const [loopObject] = await db
				.select({ metadata: objects.metadata })
				.from(objects)
				.where(eq(objects.id, body.objectId as string))
			const tabs = readLoopViews(loopObject?.metadata as Record<string, unknown>).map((v) => v.name)
			expect(tabs).toEqual(
				slug === 'product-discovery-loop'
					? ['Radar', 'Learning', 'Briefing', 'Opportunities', 'Opportunity shortlist', 'Pipeline']
					: slug === 'customer-voice-loop' || slug === 'product-usage-loop'
						? ['Results']
						: slug === 'knowledge-wiki-loop'
							? ['Results', 'Strategic context']
							: [],
			)
		})
	}

	// The fold-in trigger links each new page into the flow by the flow's name, so the installed flow
	// must carry exactly that name, and the targets the weekly prune recounts must be on it.
	it('installs the knowledge-wiki-loop flow under the name its triggers look it up by', async () => {
		const actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		const agentStorage = new AgentStorageManager(createMemoryStorage(), db)
		await bootstrapDefaultAgents(db, agentStorage, ws.id, actorId)

		const loop = seededLoops.find((l) => l.slug === 'knowledge-wiki-loop')
		if (!loop) throw new Error('seeded loop knowledge-wiki-loop not found')

		const res = await makeApp(actorId).request(
			jsonRequest('POST', '/api/installed-loops', { loopId: loop.id, workspaceId: ws.id }),
		)
		expect(res.status).toBe(201)
		const body = (await res.json()) as { objectId: string | null }
		const [flow] = await db
			.select({ title: objects.title, type: objects.type, metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, body.objectId as string))
		expect(flow?.type).toBe('loop')
		expect(flow?.title).toBe('Knowledge Wiki')

		const meta = flow?.metadata as { trigger_ids: string[]; targets: Array<{ label: string }> }
		expect(meta.targets.map((t) => t.label)).toEqual(['Idle drafts', 'Stale pages'])

		const rows = await db
			.select({ name: triggers.name, actionPrompt: triggers.actionPrompt })
			.from(triggers)
			.where(inArray(triggers.id, meta.trigger_ids))
		expect(rows).toHaveLength(4)
		const fold = rows.find((r) => r.name === 'Fold new knowledge into the wiki')
		expect(fold?.actionPrompt).toContain(flow?.title)
		expect(fold?.actionPrompt).toContain('list_loops')
		expect(fold?.actionPrompt).toContain('in_loop')
		for (const row of rows) expect(row.actionPrompt).toContain(flow?.title)
	})
})
