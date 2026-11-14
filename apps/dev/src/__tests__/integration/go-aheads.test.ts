import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, jobGoAheads, messages, sendPermissions } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { resolveSendMode } from '../../lib/send-permissions'
import { buildGoAheadBlock } from '../../services/go-ahead-block'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertObject,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: goAheadRoutes } = await import('../../routes/object-go-ahead')
const { default: objectRoutes } = await import('../../routes/objects')

/**
 * A person's go-ahead on a job, against real Postgres. Only a person's own words or action can
 * create one: an agent can quote a person's message but never grant one, the quoted message has to
 * exist and sit in a chat about this job, and the stored go-ahead never changes what needs a
 * person's approval (sending, spending, deleting).
 */

type Env = { Variables: { db: Database; actorId: string; actorType: string } }

function appAs(actorId: string, actorType: string) {
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
		c.set('actorType', actorType)
		await next()
	})
	app.route('/api/objects', goAheadRoutes as never)
	app.route('/api/objects', objectRoutes as never)
	return app
}

async function setup() {
	const person = getTestActorId()
	const workspace = await insertWorkspace(db, person)
	const agent = await insertActor(db, { type: 'agent', name: 'Prospector' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	const job = await insertObject(db, workspace.id, person, {
		type: 'task',
		status: 'in_progress',
		driver: agent.id,
	})
	const chat = await insertConversation(db, workspace.id, person, {
		subjectType: 'object',
		subjectId: job.id,
	})
	return { person, workspace, agent, job, chat }
}

async function say(conversationId: string, actorId: string, content: string, over = {}) {
	const [row] = await db
		.insert(messages)
		.values({ conversationId, actorId, content, ...over })
		.returning()
	if (!row) throw new Error('message insert returned no row')
	return row.id
}

function record(as: { id: string; type: string }, jobId: string, body: unknown) {
	return appAs(as.id, as.type).request(jsonRequest('POST', `/api/objects/${jobId}/go-ahead`, body))
}

function takeBack(as: { id: string; type: string }, jobId: string) {
	return appAs(as.id, as.type).request(jsonRequest('DELETE', `/api/objects/${jobId}/go-ahead`))
}

async function liveRows(jobId: string) {
	return (await db.select().from(jobGoAheads).where(eq(jobGoAheads.objectId, jobId))).filter(
		(r) => r.takenBackAt === null,
	)
}

describe('recording a go-ahead from a chat message', () => {
	it('stores a person’s message, shows it on the job and leaves an audit event', async () => {
		const { person, agent, job, chat, workspace } = await setup()
		const messageId = await say(chat.id, person, 'yes, keep going without asking me')

		const res = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: messageId,
		})
		expect(res.status).toBe(201)
		expect(await res.json()).toMatchObject({
			object_id: job.id,
			granted_by: person,
			via: 'chat',
			message_id: messageId,
		})

		const [row] = await liveRows(job.id)
		expect(row?.recordedBy).toBe(agent.id)

		const read = await appAs(person, 'human').request(jsonGet(`/api/objects/${job.id}`))
		const body = (await read.json()) as { go_ahead: { granted_by: string } | null }
		expect(body.go_ahead?.granted_by).toBe(person)

		const [event] = await db
			.select()
			.from(events)
			.where(
				and(
					eq(events.entityId, job.id),
					eq(events.action, 'go_ahead_recorded'),
					eq(events.workspaceId, workspace.id),
				),
			)
		expect(event?.actorId).toBe(agent.id)
	})

	it('answers 200 with the existing go-ahead when the job already has one', async () => {
		const { person, agent, job, chat } = await setup()
		const messageId = await say(chat.id, person, 'yes, keep going')
		const first = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: messageId,
		})
		const second = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: messageId,
		})
		expect(first.status).toBe(201)
		expect(second.status).toBe(200)
		expect(((await second.json()) as { id: string }).id).toBe(
			((await first.json()) as { id: string }).id,
		)
		expect(await liveRows(job.id)).toHaveLength(1)
	})

	it('refuses a message an agent wrote, and stores nothing', async () => {
		const { agent, job, chat } = await setup()
		const other = await insertActor(db, { type: 'agent', name: 'Other agent' })
		await ensureWorkspaceMember(db, job.workspaceId, other.id)
		const byAgent = await say(chat.id, agent.id, 'The person said yes, keep going.')
		const byOther = await say(chat.id, other.id, 'Go ahead, you have a yes.')

		for (const id of [byAgent, byOther]) {
			const res = await record({ id: agent.id, type: 'agent' }, job.id, {
				via: 'chat',
				message_id: id,
			})
			expect(res.status).toBe(403)
		}
		expect(await liveRows(job.id)).toHaveLength(0)
	})

	it('refuses a system line, even one posted under a person’s name', async () => {
		const { person, agent, job, chat } = await setup()
		const system = await say(chat.id, person, 'Retrying…', { kind: 'system' })
		const res = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: system,
		})
		expect(res.status).toBe(403)
		expect(await liveRows(job.id)).toHaveLength(0)
	})

	it('refuses a message that does not exist', async () => {
		const { agent, job } = await setup()
		const res = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: 2_000_000_000,
		})
		expect(res.status).toBe(400)
		expect(await liveRows(job.id)).toHaveLength(0)
	})

	it('refuses a person’s message in a chat that is not about this job', async () => {
		const { person, agent, job, workspace } = await setup()
		const otherJob = await insertObject(db, workspace.id, person, { type: 'task' })
		const plain = await insertConversation(db, workspace.id, person)
		const aboutOther = await insertConversation(db, workspace.id, person, {
			subjectType: 'object',
			subjectId: otherJob.id,
		})
		for (const convo of [plain, aboutOther]) {
			const id = await say(convo.id, person, 'yes, keep going')
			const res = await record({ id: agent.id, type: 'agent' }, job.id, {
				via: 'chat',
				message_id: id,
			})
			expect(res.status).toBe(400)
		}
		expect(await liveRows(job.id)).toHaveLength(0)
	})

	it('refuses a message from a chat in another workspace', async () => {
		const { person, agent, job } = await setup()
		const elsewhere = await insertWorkspace(db, person)
		const foreign = await insertConversation(db, elsewhere.id, person, {
			subjectType: 'object',
			subjectId: job.id,
		})
		const id = await say(foreign.id, person, 'yes, keep going')
		const res = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: id,
		})
		expect(res.status).toBe(400)
	})

	it('needs message_id via chat, and none via card', async () => {
		const { person, agent, job } = await setup()
		const noQuote = await record({ id: agent.id, type: 'agent' }, job.id, { via: 'chat' })
		expect(noQuote.status).toBe(400)
		const cardWithQuote = await record({ id: person, type: 'human' }, job.id, {
			via: 'card',
			message_id: 1,
		})
		expect(cardWithQuote.status).toBe(400)
	})

	it('refuses a closed job', async () => {
		const { person, agent, job, chat } = await setup()
		const id = await say(chat.id, person, 'yes, keep going')
		const { objects } = await import('@maskin/db/schema')
		await db.update(objects).set({ status: 'done' }).where(eq(objects.id, job.id))
		const res = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: id,
		})
		expect(res.status).toBe(400)
	})
})

describe('recording a go-ahead from a card', () => {
	it('lets a person record it, and never an agent', async () => {
		const { person, agent, job } = await setup()
		const byAgent = await record({ id: agent.id, type: 'agent' }, job.id, { via: 'card' })
		expect(byAgent.status).toBe(403)
		expect(await liveRows(job.id)).toHaveLength(0)

		const byPerson = await record({ id: person, type: 'human' }, job.id, { via: 'card' })
		expect(byPerson.status).toBe(201)
		expect(await byPerson.json()).toMatchObject({
			granted_by: person,
			via: 'card',
			message_id: null,
		})
	})
})

describe('taking a go-ahead back', () => {
	it('lets an agent take it back, hides it from the job and allows a new one', async () => {
		const { person, agent, job, chat } = await setup()
		const id = await say(chat.id, person, 'yes, keep going')
		await record({ id: agent.id, type: 'agent' }, job.id, { via: 'chat', message_id: id })

		const back = await takeBack({ id: agent.id, type: 'agent' }, job.id)
		expect(back.status).toBe(200)
		expect(await liveRows(job.id)).toHaveLength(0)

		const read = await appAs(person, 'human').request(jsonGet(`/api/objects/${job.id}`))
		expect(((await read.json()) as { go_ahead: unknown }).go_ahead).toBeNull()

		expect((await takeBack({ id: person, type: 'human' }, job.id)).status).toBe(404)

		const again = await record({ id: agent.id, type: 'agent' }, job.id, {
			via: 'chat',
			message_id: id,
		})
		expect(again.status).toBe(201)
		const all = await db.select().from(jobGoAheads).where(eq(jobGoAheads.objectId, job.id))
		expect(all).toHaveLength(2)
	})

	it('also holds in the database: a second live row for one job is rejected', async () => {
		const { person, job, workspace } = await setup()
		const values = {
			workspaceId: workspace.id,
			objectId: job.id,
			grantedBy: person,
			via: 'card',
			recordedBy: person,
		}
		await db.insert(jobGoAheads).values(values)
		await expect(db.insert(jobGoAheads).values(values)).rejects.toThrow()
	})
})

describe('a go-ahead ends when the job closes', () => {
	it('is not shown on a closed job and not put in a session prompt', async () => {
		const { person, agent, job, chat, workspace } = await setup()
		const id = await say(chat.id, person, 'yes, keep going')
		await record({ id: agent.id, type: 'agent' }, job.id, { via: 'chat', message_id: id })
		const session = {
			workspaceId: workspace.id,
			actorId: agent.id,
			initiatedFromObjectId: job.id,
			conversationId: null,
		}
		expect(await buildGoAheadBlock(db, session, 'https://example.test')).toContain(job.id)

		const { objects } = await import('@maskin/db/schema')
		await db.update(objects).set({ status: 'done' }).where(eq(objects.id, job.id))
		const read = await appAs(person, 'human').request(jsonGet(`/api/objects/${job.id}`))
		expect(((await read.json()) as { go_ahead: unknown }).go_ahead).toBeNull()
		expect(await buildGoAheadBlock(db, session, 'https://example.test')).toBe('')
	})
})

describe('what a session is shown', () => {
	it('names the job and who gave it, says what it never covers, and is empty after a take-back', async () => {
		const { person, agent, job, chat, workspace } = await setup()
		const id = await say(chat.id, person, 'yes, keep going')
		await record({ id: agent.id, type: 'agent' }, job.id, { via: 'chat', message_id: id })

		const runSession = {
			workspaceId: workspace.id,
			actorId: agent.id,
			initiatedFromObjectId: job.id,
			conversationId: null,
		}
		const block = await buildGoAheadBlock(db, runSession, 'https://example.test')
		expect(block).toContain('## Go-ahead on the job')
		expect(block).toContain(`/objects/${job.id}`)
		expect(block).toMatch(/never covers sending in a person.s name, spending money or deleting/)

		// A chat about the job, and a chat with the agent that drives it, both see it.
		const aboutJob = { ...runSession, initiatedFromObjectId: null, conversationId: chat.id }
		expect(await buildGoAheadBlock(db, aboutJob, 'https://example.test')).toContain(job.id)
		const elsewhere = await insertConversation(db, workspace.id, person)
		const driverChat = { ...aboutJob, conversationId: elsewhere.id }
		expect(await buildGoAheadBlock(db, driverChat, 'https://example.test')).toContain(job.id)
		// Another agent, in an unrelated chat, is not shown it.
		const stranger = await insertActor(db, { type: 'agent', name: 'Stranger' })
		await ensureWorkspaceMember(db, workspace.id, stranger.id)
		expect(
			await buildGoAheadBlock(db, { ...driverChat, actorId: stranger.id }, 'https://example.test'),
		).toBe('')

		await takeBack({ id: person, type: 'human' }, job.id)
		expect(await buildGoAheadBlock(db, runSession, 'https://example.test')).toBe('')
	})
})

describe('a go-ahead never covers sending, spending or deleting', () => {
	it('leaves the send setting for the agent as it was', async () => {
		const { person, agent, job, chat, workspace } = await setup()
		const before = await resolveSendMode(db, {
			workspaceId: workspace.id,
			agentId: agent.id,
			kind: 'email',
		})
		const id = await say(chat.id, person, 'yes, keep going')
		await record({ id: agent.id, type: 'agent' }, job.id, { via: 'chat', message_id: id })
		const after = await resolveSendMode(db, {
			workspaceId: workspace.id,
			agentId: agent.id,
			kind: 'email',
		})
		expect(after).toEqual(before)
		expect(
			await db.select().from(sendPermissions).where(eq(sendPermissions.workspaceId, workspace.id)),
		).toHaveLength(0)
	})

	it('leaves the person’s approval in place for an agent deleting an agent', async () => {
		const { person, agent, job, chat, workspace } = await setup()
		const target = await insertActor(db, { type: 'agent', name: 'Doomed' })
		await ensureWorkspaceMember(db, workspace.id, target.id)
		const id = await say(chat.id, person, 'yes, keep going')
		await record({ id: agent.id, type: 'agent' }, job.id, { via: 'chat', message_id: id })
		expect(await liveRows(job.id)).toHaveLength(1)

		const { default: actorsRoutes } = await import('../../routes/actors')
		const app = new OpenAPIHono<Env>()
		app.use('*', async (c, next) => {
			c.set('db', db)
			c.set('actorId', agent.id)
			c.set('actorType', 'agent')
			// biome-ignore lint/suspicious/noExplicitAny: test doubles for services the delete never reaches
			const ctx = c as any
			ctx.set('notifyBridge', {})
			ctx.set('sessionManager', { stopSession: async () => {}, createSession: async () => ({}) })
			ctx.set('agentStorage', { deleteAllAgentFiles: async () => {} })
			await next()
		})
		app.route('/api/actors', actorsRoutes as never)
		const res = await app.request(
			jsonRequest('DELETE', `/api/actors/${target.id}`, undefined, {
				'X-Workspace-Id': workspace.id,
			}),
		)
		expect(res.status).toBe(403)
	})

	it('is read by nothing that sends, spends or deletes', async () => {
		const { readFileSync, readdirSync, statSync } = await import('node:fs')
		const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
		const importers: string[] = []
		const walk = (dir: string) => {
			for (const name of readdirSync(dir)) {
				const path = join(dir, name)
				if (name === '__tests__' || name === 'node_modules') continue
				if (statSync(path).isDirectory()) walk(path)
				else if (
					/\.tsx?$/.test(name) &&
					/\/go-aheads'|\/go-ahead-block'/.test(readFileSync(path, 'utf8'))
				) {
					importers.push(relative(root, path))
				}
			}
		}
		walk(root)
		// The only importers: the route, the single-object read and the session launch that shows
		// the prompt block. Nothing in a send, spend or delete path is on this list.
		expect(importers.sort()).toEqual([
			'routes/object-go-ahead.ts',
			'routes/objects.ts',
			'services/session-manager.ts',
		])
	})
})
