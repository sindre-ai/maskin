import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, conversationParticipants, messages } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertObject,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { db, getTestActorId } from './global-setup'

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

const { default: workspacesRoutes } = await import('../../routes/workspaces')

type Counts = { workspaceId: string; unreadChats: number; forYou: number; needYou: number }

function appAs(actorId: string) {
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
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/workspaces', workspacesRoutes)
	return app
}

describe('GET /api/workspaces/counts', () => {
	let callerId: string
	let agentId: string
	let otherHumanId: string
	let wsA: string
	let wsB: string
	let wsEmpty: string

	beforeEach(async () => {
		callerId = getTestActorId()
		agentId = (await insertActor(db, { type: 'agent', name: 'CoS', email: null })).id
		otherHumanId = (await insertActor(db, { type: 'human' })).id
		wsA = (await insertWorkspace(db, callerId)).id
		wsB = (await insertWorkspace(db, callerId)).id
		wsEmpty = (await insertWorkspace(db, callerId)).id
		for (const ws of [wsA, wsB, wsEmpty]) {
			await ensureWorkspaceMember(db, ws, agentId)
			await ensureWorkspaceMember(db, ws, otherHumanId)
		}
	})

	/** A chat the caller is in, with `fromOthers` messages from someone else past `readMarker`. */
	async function chat(
		workspaceId: string,
		opts: {
			fromOthers?: number
			fromCaller?: number
			archived?: boolean
			left?: boolean
			readAll?: boolean
		} = {},
	) {
		const conversation = await insertConversation(db, workspaceId, callerId)
		const [participant] = await db
			.insert(conversationParticipants)
			.values({
				conversationId: conversation.id,
				actorId: callerId,
				archived: opts.archived ?? false,
				leftAt: opts.left ? new Date() : null,
			})
			.returning()
		let lastId = 0
		for (let i = 0; i < (opts.fromOthers ?? 0); i++) {
			const [row] = await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: otherHumanId, content: `hi ${i}` })
				.returning()
			lastId = row?.id ?? lastId
		}
		for (let i = 0; i < (opts.fromCaller ?? 0); i++) {
			await db
				.insert(messages)
				.values({ conversationId: conversation.id, actorId: callerId, content: `mine ${i}` })
		}
		if (opts.readAll) {
			await db
				.update(conversationParticipants)
				.set({ lastReadMessageId: lastId })
				.where(
					and(
						eq(conversationParticipants.conversationId, conversation.id),
						eq(conversationParticipants.actorId, participant?.actorId ?? callerId),
					),
				)
		}
		return conversation
	}

	/** An agent's decision card addressed to the caller, on a fresh open task. */
	async function decisionCard(workspaceId: string) {
		const task = await insertObject(db, workspaceId, callerId, { status: 'in_review' })
		await db.insert(events).values({
			workspaceId,
			actorId: agentId,
			action: 'commented',
			entityType: 'object',
			entityId: task.id,
			data: {
				content: 'Approve the note.',
				mentions: [callerId],
				decision: {
					title: 'Send the note?',
					summary: 'It goes out in your name.',
					ask: 'Send it?',
					options: [{ label: 'Send', recommended: true }, { label: 'Skip' }],
				},
			},
		})
	}

	async function counts(as = callerId) {
		const res = await appAs(as).request(jsonGet('/api/workspaces/counts'))
		expect(res.status).toBe(200)
		return (await res.json()) as Counts[]
	}

	it('counts chats with something unread, not messages, per workspace', async () => {
		await chat(wsA, { fromOthers: 3 })
		await chat(wsA, { fromOthers: 1 })
		await chat(wsB, { fromOthers: 2 })

		const rows = await counts()
		const byId = new Map(rows.map((r) => [r.workspaceId, r]))
		expect(byId.get(wsA)?.unreadChats).toBe(2)
		expect(byId.get(wsB)?.unreadChats).toBe(1)
	})

	it('leaves out chats that are read, archived, left, or only the caller wrote in', async () => {
		await chat(wsA, { fromOthers: 2, readAll: true })
		await chat(wsA, { fromOthers: 2, archived: true })
		await chat(wsA, { fromOthers: 2, left: true })
		await chat(wsA, { fromCaller: 2 })

		const rows = await counts()
		expect(rows.find((r) => r.workspaceId === wsA)?.unreadChats).toBe(0)
	})

	it('counts For You items per workspace and adds them to the chats for needYou', async () => {
		await chat(wsA, { fromOthers: 1 })
		await decisionCard(wsA)
		await decisionCard(wsB)

		const rows = await counts()
		const byId = new Map(rows.map((r) => [r.workspaceId, r]))
		expect(byId.get(wsA)).toMatchObject({ unreadChats: 1, forYou: 1, needYou: 2 })
		expect(byId.get(wsB)).toMatchObject({ unreadChats: 0, forYou: 1, needYou: 1 })
	})

	it('returns a zero row for a workspace with nothing waiting', async () => {
		const rows = await counts()
		expect(rows.find((r) => r.workspaceId === wsEmpty)).toEqual({
			workspaceId: wsEmpty,
			unreadChats: 0,
			forYou: 0,
			needYou: 0,
		})
	})

	it('lists only workspaces the caller belongs to and never counts another person’s chats', async () => {
		const foreign = (await insertWorkspace(db, otherHumanId)).id
		const conversation = await insertConversation(db, foreign, otherHumanId)
		await db
			.insert(conversationParticipants)
			.values({ conversationId: conversation.id, actorId: otherHumanId })
		await db
			.insert(messages)
			.values({ conversationId: conversation.id, actorId: agentId, content: 'hello' })

		const rows = await counts()
		expect(rows.map((r) => r.workspaceId)).not.toContain(foreign)
		expect(rows.map((r) => r.workspaceId)).toEqual(expect.arrayContaining([wsA, wsB, wsEmpty]))
	})
})
