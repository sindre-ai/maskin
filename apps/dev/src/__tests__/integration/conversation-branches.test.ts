import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { conversationBranches, messages, workspaceMembers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { buildBranchPoints, resolveSegmentsFrom } from '../../services/conversation-branches'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: conversationsRoutes } = await import('../../routes/conversations')

/** The insert factories return `rows[0]`, i.e. `T | undefined`. In a test a
 *  missing row is a broken fixture, so fail loudly at the point of creation
 *  rather than threading optionality through every assertion below. */
function required<T>(value: T | undefined, what: string): T {
	if (!value) throw new Error(`fixture failed to create: ${what}`)
	return value
}

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: {
			createSession: ReturnType<typeof vi.fn>
			findActiveConversationSession: ReturnType<typeof vi.fn>
			findConversationSessionAnyActive: ReturnType<typeof vi.fn>
			drainPendingConversationTurns: ReturnType<typeof vi.fn>
			writeInput: ReturnType<typeof vi.fn>
			stopSession: ReturnType<typeof vi.fn>
		}
	}
}

function createApp(actorId: string) {
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

	const sessionManager = {
		createSession: vi.fn().mockResolvedValue({ id: crypto.randomUUID() }),
		findActiveConversationSession: vi.fn().mockResolvedValue(null),
		findConversationSessionAnyActive: vi.fn().mockResolvedValue(null),
		drainPendingConversationTurns: vi.fn().mockResolvedValue(undefined),
		writeInput: vi.fn().mockResolvedValue(undefined),
		stopSession: vi.fn().mockResolvedValue(undefined),
	}

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/conversations', conversationsRoutes)
	return { app, sessionManager }
}

describe('Conversation branching (rewind)', () => {
	let ownerId: string
	let workspaceId: string

	beforeEach(async () => {
		ownerId = getTestActorId()
		workspaceId = required(await insertWorkspace(db, ownerId), 'workspace').id
	})

	async function createConversation(app: OpenAPIHono<Env>, participantIds: string[] = []) {
		const res = await app.request(
			jsonRequest(
				'POST',
				'/api/conversations',
				{ title: 'Branching', participant_actor_ids: participantIds },
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(201)
		return ((await res.json()) as { id: string }).id
	}

	async function post(app: OpenAPIHono<Env>, conversationId: string, content: string) {
		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages`,
				{ content },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(res.status).toBe(201)
		return ((await res.json()) as { id: number }).id
	}

	async function listMessages(app: OpenAPIHono<Env>, conversationId: string) {
		const res = await app.request(
			jsonGet(`/api/conversations/${conversationId}/messages`, { 'x-workspace-id': workspaceId }),
		)
		expect(res.status).toBe(200)
		return (await res.json()) as {
			messages: Array<{ id: number; content: string; canRewind?: boolean }>
			active_branch_id: string | null
			branch_points: Array<{ messageId: number; activeIndex: number; options: unknown[] }>
		}
	}

	it('hides the rewound tail and re-posts the message on a new branch', async () => {
		const { app } = createApp(ownerId)
		const conversationId = await createConversation(app)
		const first = await post(app, conversationId, 'first')
		const target = await post(app, conversationId, 'second')
		await post(app, conversationId, 'third')

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages/${target}/rewind`,
				undefined,
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(202)
		const body = (await res.json()) as { branch_id: string; message: { id: number } }

		const after = await listMessages(app, conversationId)
		const contents = after.messages.map((m) => m.content)
		// 'third' is gone from the thread, 'second' is back as a fresh row.
		expect(contents).toEqual(['second', 'first'])
		expect(after.messages.map((m) => m.id)).toEqual([body.message.id, first])
		expect(after.active_branch_id).toBe(body.branch_id)

		// Nothing was deleted — the original rows are still in the table.
		const all = await db.select().from(messages).where(eq(messages.conversationId, conversationId))
		expect(all).toHaveLength(4)
	})

	it('restores the original tail when switching back to the root branch', async () => {
		const { app } = createApp(ownerId)
		const conversationId = await createConversation(app)
		await post(app, conversationId, 'first')
		const target = await post(app, conversationId, 'second')
		await post(app, conversationId, 'third')

		await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages/${target}/rewind`,
				undefined,
				{ 'x-workspace-id': workspaceId },
			),
		)

		const back = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/branch`,
				{ branch_id: null },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(back.status).toBe(200)

		const restored = await listMessages(app, conversationId)
		expect(restored.messages.map((m) => m.content)).toEqual(['third', 'second', 'first'])
		expect(restored.active_branch_id).toBeNull()
	})

	it('refuses to rewind past another human and allows it past an agent', async () => {
		const other = required(await insertActor(db, { type: 'human' }), 'other human')
		const agent = required(await insertActor(db, { type: 'agent' }), 'agent')
		await db.insert(workspaceMembers).values([
			{ workspaceId, actorId: other.id, role: 'member' },
			{ workspaceId, actorId: agent.id, role: 'member' },
		])

		const { app } = createApp(ownerId)
		const conversationId = await createConversation(app, [other.id, agent.id])
		const target = await post(app, conversationId, 'mine')

		// An agent replying afterwards must not block — re-running it is the point.
		await db.insert(messages).values({
			conversationId,
			actorId: agent.id,
			content: 'agent reply',
			metadata: null,
			sessionId: null,
		})
		const beforeHuman = await listMessages(app, conversationId)
		expect(beforeHuman.messages.find((m) => m.id === target)?.canRewind).toBe(true)

		// Another person replying does block — rewinding would erase their message.
		await db.insert(messages).values({
			conversationId,
			actorId: other.id,
			content: 'their reply',
			metadata: null,
			sessionId: null,
		})
		const afterHuman = await listMessages(app, conversationId)
		expect(afterHuman.messages.find((m) => m.id === target)?.canRewind).toBe(false)

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages/${target}/rewind`,
				undefined,
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(409)
	})

	it('rejects a rewind of somebody else’s message', async () => {
		const other = required(await insertActor(db, { type: 'human' }), 'other human')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: other.id, role: 'member' })

		const { app } = createApp(ownerId)
		const conversationId = await createConversation(app, [other.id])
		const [theirs] = await db
			.insert(messages)
			.values({
				conversationId,
				actorId: other.id,
				content: 'not yours',
				metadata: null,
				sessionId: null,
			})
			.returning()

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages/${theirs?.id}/rewind`,
				undefined,
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(res.status).toBe(403)
	})

	it('resolves nested rewinds and exposes a switcher at each fork point', async () => {
		const { app } = createApp(ownerId)
		const conversationId = await createConversation(app)
		await post(app, conversationId, 'first')
		const firstTarget = await post(app, conversationId, 'second')
		await post(app, conversationId, 'third')

		const r1 = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages/${firstTarget}/rewind`,
				undefined,
				{ 'x-workspace-id': workspaceId },
			),
		)
		const b1 = (await r1.json()) as { branch_id: string; message: { id: number } }

		// Rewind again, this time from inside the new branch.
		const r2 = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${conversationId}/messages/${b1.message.id}/rewind`,
				undefined,
				{ 'x-workspace-id': workspaceId },
			),
		)
		expect(r2.status).toBe(202)

		const nested = await listMessages(app, conversationId)
		expect(nested.messages.map((m) => m.content)).toEqual(['second', 'first'])
		// One fork point per rewind, and each offers original + re-send.
		expect(nested.branch_points).toHaveLength(2)
		for (const point of nested.branch_points) expect(point.options.length).toBeGreaterThanOrEqual(2)

		const branchRows = await db
			.select()
			.from(conversationBranches)
			.where(eq(conversationBranches.conversationId, conversationId))
		expect(branchRows).toHaveLength(2)
	})

	it('rejects a branch id belonging to another conversation', async () => {
		const { app } = createApp(ownerId)
		const a = await createConversation(app)
		const b = await createConversation(app)
		const target = await post(app, a, 'msg')
		const r = await app.request(
			jsonRequest('POST', `/api/conversations/${a}/messages/${target}/rewind`, undefined, {
				'x-workspace-id': workspaceId,
			}),
		)
		const { branch_id } = (await r.json()) as { branch_id: string }

		const res = await app.request(
			jsonRequest(
				'POST',
				`/api/conversations/${b}/branch`,
				{ branch_id },
				{
					'x-workspace-id': workspaceId,
				},
			),
		)
		expect(res.status).toBe(404)
	})
})

// Pure-function coverage for the walk itself — the DB tests above exercise it
// end to end, but a corrupt chain is easier to construct directly.
describe('resolveSegmentsFrom', () => {
	it('returns the whole conversation for the root branch', () => {
		expect(resolveSegmentsFrom([], null)).toEqual([{ branch: null, minId: 0, maxId: null }])
	})

	it('fails closed to the root when the chain is longer than the depth cap', () => {
		// A cycle: two branches naming each other as parent.
		const rows = [
			{ id: 'a', parentBranchId: 'b', forkedFromMessageId: 10 },
			{ id: 'b', parentBranchId: 'a', forkedFromMessageId: 5 },
		]
		expect(resolveSegmentsFrom(rows, 'a')).toEqual([{ branch: null, minId: 0, maxId: null }])
	})

	it('fails closed when a branch id is unknown', () => {
		expect(resolveSegmentsFrom([], 'missing')).toEqual([{ branch: null, minId: 0, maxId: null }])
	})

	it('emits half-open segments newest-first for a nested chain', () => {
		const rows = [
			{ id: 'outer', parentBranchId: null, forkedFromMessageId: 5 },
			{ id: 'inner', parentBranchId: 'outer', forkedFromMessageId: 9 },
		]
		expect(resolveSegmentsFrom(rows, 'inner')).toEqual([
			{ branch: 'inner', minId: 9, maxId: null },
			{ branch: 'outer', minId: 5, maxId: 9 },
			{ branch: null, minId: 0, maxId: 5 },
		])
	})
})

describe('buildBranchPoints', () => {
	it('reports the forked option as active, not its parent', () => {
		// Being on a branch puts its parent in the ancestry set too — a naive scan
		// from index 0 would always report the original as active.
		const rows = [{ id: 'fork', parentBranchId: null, forkedFromMessageId: 7 }]
		const [point] = buildBranchPoints(rows, 'fork')
		expect(point?.messageId).toBe(7)
		expect(point?.options).toEqual([{ branchId: null }, { branchId: 'fork' }])
		expect(point?.activeIndex).toBe(1)
	})

	it('reports the original as active when viewing the parent branch', () => {
		const rows = [{ id: 'fork', parentBranchId: null, forkedFromMessageId: 7 }]
		const [point] = buildBranchPoints(rows, null)
		expect(point?.activeIndex).toBe(0)
	})
})
