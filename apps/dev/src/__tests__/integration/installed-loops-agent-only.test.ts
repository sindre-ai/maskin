import { randomUUID } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	actors,
	agentSkills,
	conversations,
	installedLoops,
	marketplaceLoopItems,
	marketplaceLoops,
	messages,
	objects,
	workspaceSkills,
} from '@maskin/db/schema'
import type { StorageProvider } from '@maskin/storage'
import { and, eq, sql } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { AgentStorageManager } from '../../services/agent-storage'
import { LoopVersionPusher } from '../../services/loop-version-pusher'
import { insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId, sql as rawSql } from './global-setup'

// The install count and the hello event are the two numbers the outcome check reads.
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: vi.fn().mockResolvedValue(undefined),
}))
const { trackLoopInstalledMock } = vi.hoisted(() => ({
	trackLoopInstalledMock: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('../../lib/analytics/loop-events', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../lib/analytics/loop-events')>()
	return { ...actual, trackLoopInstalled: trackLoopInstalledMock }
})

const { default: installedLoopsRoutes } = await import('../../routes/installed-loops')
const { capturePosthogEvent } = await import('../../lib/analytics/posthog')
const captured = vi.mocked(capturePosthogEvent)

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

function makeApp(actorId: string, storage = createMemoryStorage()) {
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
	const agentStorage = new AgentStorageManager(storage, db)
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

const FIRST_LOOK = 'Look for a design style in knowledge pages and files.'

/** A listing that is one agent with one skill, marked agent-only. */
async function seedAgentListing(overrides?: { agentOnly?: boolean }) {
	const [loop] = await db
		.insert(marketplaceLoops)
		.values({
			name: 'Deck Maker',
			slug: `deck-maker-${randomUUID()}`,
			description: 'Builds decks',
			version: '1.0.0',
			useCase: 'marketing',
			loopSettings:
				overrides?.agentOnly === false ? null : { agentOnly: true, firstLook: FIRST_LOOK },
		})
		.returning()
	if (!loop) throw new Error('marketplace_loops insert returned no row')
	const sourceActorId = randomUUID()
	const sourceSkillId = randomUUID()
	await db.insert(marketplaceLoopItems).values([
		{
			loopId: loop.id,
			itemType: 'actor',
			sourceItemId: sourceActorId,
			itemSnapshot: {
				type: 'agent',
				name: 'Deck Maker',
				description: 'Builds decks as one file',
				systemPrompt: 'You build decks.',
				llmProvider: 'anthropic',
				llmConfig: {},
				tools: {},
			},
		},
		{
			loopId: loop.id,
			itemType: 'skill',
			sourceItemId: sourceSkillId,
			itemSnapshot: {
				name: `deck-patterns-${randomUUID()}`,
				description: 'Deck patterns',
				content: 'Use one slide per idea.',
				attachedActorIds: [sourceActorId],
			},
		},
	])
	return { loop, sourceActorId }
}

const install = (app: ReturnType<typeof makeApp>, loopId: string, workspaceId: string) =>
	app.request(jsonRequest('POST', '/api/installed-loops', { loopId, workspaceId }))

describe('Installing an agent-only listing', () => {
	let workspaceId: string
	let actorId: string

	beforeEach(async () => {
		await rawSql`TRUNCATE marketplace_loops, marketplace_loop_items CASCADE`
		trackLoopInstalledMock.mockClear()
		captured.mockClear()
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		if (!ws) throw new Error('workspace insert returned no row')
		workspaceId = ws.id
	})

	it('creates the agent, its skill and the install record, but no flow page and no flow setup chat', async () => {
		const { loop, sourceActorId } = await seedAgentListing()

		const res = await install(makeApp(actorId), loop.id, workspaceId)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.objectId).toBeNull()
		expect(body.provisioned).toMatchObject({ actors: 1, skills: 1, triggers: 0 })

		const [row] = await db.select().from(installedLoops).where(eq(installedLoops.id, body.id))
		expect(row?.objectId).toBeNull()

		const flowPages = await db
			.select({ id: objects.id })
			.from(objects)
			.where(and(eq(objects.workspaceId, workspaceId), eq(objects.type, 'loop')))
		expect(flowPages).toHaveLength(0)

		const [agent] = await db
			.select({ id: actors.id })
			.from(actors)
			.where(sql`${actors.metadata}->>'source_item_id' = ${sourceActorId}`)
		if (!agent) throw new Error('provisioned agent not found')
		const skills = await db
			.select({ id: workspaceSkills.id })
			.from(workspaceSkills)
			.innerJoin(agentSkills, eq(agentSkills.workspaceSkillId, workspaceSkills.id))
			.where(and(eq(workspaceSkills.workspaceId, workspaceId), eq(agentSkills.actorId, agent.id)))
		expect(skills).toHaveLength(1)

		// The only chat is the direct message the agent says hello in, not a flow setup chat.
		const chats = await db
			.select({ id: conversations.id, subjectType: conversations.subjectType })
			.from(conversations)
			.where(eq(conversations.workspaceId, workspaceId))
		expect(chats).toHaveLength(1)
		expect(chats[0]?.subjectType).toBeNull()
		expect(body.chatId).toBe(chats[0]?.id)
	})

	it('still counts the install with the listing slug, and the agent says hello in the direct message', async () => {
		const { loop } = await seedAgentListing()

		const res = await install(makeApp(actorId), loop.id, workspaceId)
		const body = await res.json()

		expect(trackLoopInstalledMock).toHaveBeenCalledTimes(1)
		expect(trackLoopInstalledMock).toHaveBeenCalledWith(
			expect.objectContaining({ loopSlug: loop.slug, workspaceId, actorId }),
		)

		await vi.waitFor(async () => {
			const hello = await db.select().from(messages).where(eq(messages.conversationId, body.chatId))
			expect(hello).toHaveLength(1)
			expect(hello[0]?.content).toContain("I'm Deck Maker")
			expect(hello[0]?.metadata).toMatchObject({ delivery: { kind: 'agent_intro' } })
		})
		const sent = captured.mock.calls.filter(([name]) => name === 'agent_intro_sent')
		expect(sent).toHaveLength(1)
		expect(sent[0]?.[2]).toMatchObject({ workspace_id: workspaceId, conversation_id: body.chatId })
	})

	it('can be uninstalled with no flow page', async () => {
		const { loop } = await seedAgentListing()
		const app = makeApp(actorId)
		const installed = await (await install(app, loop.id, workspaceId)).json()
		// The hello is written in the background; let it finish so it cannot land mid-delete.
		await vi.waitFor(async () => {
			const hello = await db
				.select({ id: messages.id })
				.from(messages)
				.where(eq(messages.conversationId, installed.chatId))
			expect(hello).toHaveLength(1)
		})

		const res = await app.request(
			jsonRequest('DELETE', `/api/installed-loops/${installed.id}`, {
				keepProvisionedItems: false,
			}),
		)
		expect(res.status).toBe(200)
		expect((await res.json()).removedLoopObject).toBe(false)

		const remaining = await db
			.select({ id: installedLoops.id })
			.from(installedLoops)
			.where(eq(installedLoops.id, installed.id))
		expect(remaining).toHaveLength(0)
	})

	it('takes a new version on the hourly push with no flow page', async () => {
		const { loop, sourceActorId } = await seedAgentListing()
		const storage = createMemoryStorage()
		const installed = await (await install(makeApp(actorId, storage), loop.id, workspaceId)).json()

		await db
			.update(marketplaceLoops)
			.set({ version: '1.1.0' })
			.where(eq(marketplaceLoops.id, loop.id))
		await db
			.update(marketplaceLoopItems)
			.set({
				itemSnapshot: {
					type: 'agent',
					name: 'Deck Maker',
					description: 'Builds decks as one file',
					systemPrompt: 'You build decks, version two.',
					llmProvider: 'anthropic',
					llmConfig: {},
					tools: {},
				},
			})
			.where(eq(marketplaceLoopItems.sourceItemId, sourceActorId))

		await new LoopVersionPusher(db, new AgentStorageManager(storage, db), 60_000).tick()

		const [row] = await db.select().from(installedLoops).where(eq(installedLoops.id, installed.id))
		expect(row?.installedVersion).toBe('1.1.0')
		expect(row?.objectId).toBeNull()
		const [agent] = await db
			.select({ systemPrompt: actors.systemPrompt })
			.from(actors)
			.where(sql`${actors.metadata}->>'source_item_id' = ${sourceActorId}`)
		expect(agent?.systemPrompt).toBe('You build decks, version two.')
	})

	it('installs a listing without the marker as a normal flow: a flow page, no chat id in the reply', async () => {
		const { loop } = await seedAgentListing({ agentOnly: false })

		const res = await install(makeApp(actorId), loop.id, workspaceId)
		expect(res.status).toBe(201)
		const body = await res.json()
		expect(body.objectId).toBeTruthy()
		expect(body).not.toHaveProperty('chatId')
		const [flowPage] = await db.select().from(objects).where(eq(objects.id, body.objectId))
		expect(flowPage?.type).toBe('loop')
	})
})
