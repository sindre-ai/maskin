import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import {
	conversationParticipants,
	conversations,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { vi } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	insertActor,
	insertSession,
	insertSessionLog,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: sessionsRoutes } = await import('../../routes/sessions')

/**
 * Who may read, stop, pause and resume a session, against real Postgres.
 *
 * The rule: a session a person started is private to that person, to workspace
 * admins and owners, and to the people in the chat it belongs to. A session a
 * trigger or an agent started is readable by every member. Stop, pause and
 * resume stay with whoever started the session and admins.
 */

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		sessionManager: Record<string, ReturnType<typeof vi.fn>>
	}
}

function createSessionsApp(actorId: string, actorType: 'human' | 'agent') {
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
		stopSession: vi.fn().mockResolvedValue(undefined),
		pauseSession: vi.fn().mockResolvedValue(undefined),
		resumeSession: vi.fn().mockResolvedValue(undefined),
	}
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('sessionManager', sessionManager)
		await next()
	})
	app.route('/api/sessions', sessionsRoutes)
	return { app, sessionManager }
}

describe('Session route access', () => {
	let workspaceId: string
	let ownerId: string
	let adminId: string
	let starterId: string
	let otherMemberId: string
	let agentId: string
	let otherAgentId: string
	let headers: Record<string, string>

	async function addMember(type: 'human' | 'agent', role: string, name: string) {
		const actor = await insertActor(db, { type, name })
		if (!actor) throw new Error('failed to seed actor')
		await db.insert(workspaceMembers).values({ workspaceId, actorId: actor.id, role })
		return actor.id
	}

	beforeEach(async () => {
		ownerId = getTestActorId()
		const ws = await insertWorkspace(db, ownerId)
		workspaceId = ws.id
		headers = { 'x-workspace-id': workspaceId }
		adminId = await addMember('human', 'admin', 'Admin')
		starterId = await addMember('human', 'member', 'Starter')
		otherMemberId = await addMember('human', 'member', 'Other member')
		agentId = await addMember('agent', 'member', 'Agent')
		otherAgentId = await addMember('agent', 'member', 'Other agent')
	})

	/** A session a person started: the agent runs it, the starter is the person. */
	async function personSession(overrides?: Record<string, unknown>) {
		const session = await insertSession(db, workspaceId, agentId, starterId, {
			status: 'running',
			...overrides,
		})
		if (!session) throw new Error('failed to seed session')
		await insertSessionLog(db, session.id, { content: 'private transcript line' })
		return session
	}

	async function chat(participants: string[]) {
		const [conversation] = await db
			.insert(conversations)
			.values({ workspaceId, title: 'Test chat', createdBy: starterId })
			.returning()
		if (!conversation) throw new Error('failed to seed conversation')
		for (const actorId of participants) {
			await db.insert(conversationParticipants).values({ conversationId: conversation.id, actorId })
		}
		return conversation.id
	}

	const readPaths = (id: string) => [
		`/api/sessions/${id}`,
		`/api/sessions/${id}/logs`,
		`/api/sessions/${id}/logs/deep`,
	]
	const controlPaths = (id: string) =>
		['stop', 'pause', 'resume'].map((action) => `/api/sessions/${id}/${action}`)

	describe('a session a person started', () => {
		it('lets the starter read it and its logs', async () => {
			const session = await personSession()
			const { app } = createSessionsApp(starterId, 'human')

			for (const path of readPaths(session.id)) {
				const res = await app.request(jsonGet(path, headers))
				expect(res.status, path).toBe(200)
			}
		})

		it('refuses another member on read, logs and deep logs with a 403', async () => {
			const session = await personSession()
			const { app } = createSessionsApp(otherMemberId, 'human')

			for (const path of readPaths(session.id)) {
				const res = await app.request(jsonGet(path, headers))
				expect(res.status, path).toBe(403)
				const body = (await res.json()) as { error: { code: string } }
				expect(body.error.code).toBe('FORBIDDEN')
			}
		})

		it('refuses the live log stream to another member', async () => {
			const session = await personSession()
			const { app } = createSessionsApp(otherMemberId, 'human')

			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs/stream`, headers))
			expect(res.status).toBe(403)
		})

		it('refuses another agent with a 403', async () => {
			const session = await personSession()
			const { app } = createSessionsApp(otherAgentId, 'agent')

			for (const path of readPaths(session.id)) {
				const res = await app.request(jsonGet(path, headers))
				expect(res.status, path).toBe(403)
			}
		})

		it('does not leak the transcript in the refusal body', async () => {
			const session = await personSession()
			const { app } = createSessionsApp(otherMemberId, 'human')

			const res = await app.request(jsonGet(`/api/sessions/${session.id}/logs`, headers))
			expect(JSON.stringify(await res.json())).not.toContain('private transcript line')
		})

		it('lets an admin and the owner read it', async () => {
			const session = await personSession()
			for (const actorId of [adminId, ownerId]) {
				const { app } = createSessionsApp(actorId, 'human')
				for (const path of readPaths(session.id)) {
					const res = await app.request(jsonGet(path, headers))
					expect(res.status, path).toBe(200)
				}
			}
		})

		it('lets the starter stop, pause and resume it', async () => {
			const session = await personSession()
			const { app, sessionManager } = createSessionsApp(starterId, 'human')

			for (const path of controlPaths(session.id)) {
				const res = await app.request(jsonRequest('POST', path, undefined, headers))
				expect(res.status, path).toBe(200)
			}
			expect(sessionManager.stopSession).toHaveBeenCalledOnce()
			expect(sessionManager.pauseSession).toHaveBeenCalledOnce()
			expect(sessionManager.resumeSession).toHaveBeenCalledOnce()
		})

		it('refuses another member and another agent on stop, pause and resume', async () => {
			const session = await personSession()
			for (const [actorId, type] of [
				[otherMemberId, 'human'],
				[otherAgentId, 'agent'],
			] as const) {
				const { app, sessionManager } = createSessionsApp(actorId, type)
				for (const path of controlPaths(session.id)) {
					const res = await app.request(jsonRequest('POST', path, undefined, headers))
					expect(res.status, path).toBe(403)
				}
				expect(sessionManager.stopSession).not.toHaveBeenCalled()
				expect(sessionManager.pauseSession).not.toHaveBeenCalled()
				expect(sessionManager.resumeSession).not.toHaveBeenCalled()
			}
		})

		it('lets an admin stop, pause and resume it', async () => {
			const session = await personSession()
			const { app, sessionManager } = createSessionsApp(adminId, 'human')

			for (const path of controlPaths(session.id)) {
				const res = await app.request(jsonRequest('POST', path, undefined, headers))
				expect(res.status, path).toBe(200)
			}
			expect(sessionManager.stopSession).toHaveBeenCalledOnce()
		})

		it('keeps an unknown session at 404 for every route', async () => {
			const missing = '00000000-0000-0000-0000-000000000099'
			const { app } = createSessionsApp(otherMemberId, 'human')

			for (const path of readPaths(missing)) {
				expect((await app.request(jsonGet(path, headers))).status, path).toBe(404)
			}
			for (const path of controlPaths(missing)) {
				const res = await app.request(jsonRequest('POST', path, undefined, headers))
				expect(res.status, path).toBe(404)
			}
		})
	})

	describe('a session in a chat', () => {
		it('lets every participant read it but not stop it', async () => {
			const conversationId = await chat([starterId, otherMemberId])
			const session = await personSession({ interactive: true, conversationId })
			const { app } = createSessionsApp(otherMemberId, 'human')

			for (const path of readPaths(session.id)) {
				expect((await app.request(jsonGet(path, headers))).status, path).toBe(200)
			}
			const stop = await app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, headers),
			)
			expect(stop.status).toBe(403)
		})

		it('refuses a member who is not in the chat', async () => {
			const conversationId = await chat([starterId])
			const session = await personSession({ interactive: true, conversationId })
			const { app } = createSessionsApp(otherMemberId, 'human')

			const res = await app.request(jsonGet(`/api/sessions/${session.id}`, headers))
			expect(res.status).toBe(403)
		})

		it('refuses a member who left the chat', async () => {
			const conversationId = await chat([starterId, otherMemberId])
			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(eq(conversationParticipants.actorId, otherMemberId))
			const session = await personSession({ interactive: true, conversationId })
			const { app } = createSessionsApp(otherMemberId, 'human')

			const res = await app.request(jsonGet(`/api/sessions/${session.id}`, headers))
			expect(res.status).toBe(403)
		})

		it('lets the people in the chat a helper asks its questions in read the helper', async () => {
			const conversationId = await chat([starterId, otherMemberId])
			const session = await personSession({
				interactive: true,
				config: { ask_conversation_id: conversationId },
			})
			const { app } = createSessionsApp(otherMemberId, 'human')

			const res = await app.request(jsonGet(`/api/sessions/${session.id}`, headers))
			expect(res.status).toBe(200)
		})
	})

	describe('a session a trigger started', () => {
		it('is readable by any member, but only the starter or an admin may stop it', async () => {
			const trigger = await insertTrigger(db, workspaceId, starterId, agentId)
			if (!trigger) throw new Error('failed to seed trigger')
			const session = await personSession({ triggerId: trigger.id })

			const reader = createSessionsApp(otherMemberId, 'human')
			for (const path of readPaths(session.id)) {
				expect((await reader.app.request(jsonGet(path, headers))).status, path).toBe(200)
			}
			const stop = await reader.app.request(
				jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, headers),
			)
			expect(stop.status).toBe(403)
		})
	})

	describe('a session an agent started', () => {
		async function agentStartedSession() {
			const session = await insertSession(db, workspaceId, otherAgentId, agentId, {
				status: 'running',
			})
			if (!session) throw new Error('failed to seed session')
			await insertSessionLog(db, session.id, { content: 'helper output' })
			return session
		}

		it('is readable by its parent agent, another agent and any member', async () => {
			const session = await agentStartedSession()
			for (const [actorId, type] of [
				[agentId, 'agent'],
				[otherAgentId, 'agent'],
				[otherMemberId, 'human'],
			] as const) {
				const { app } = createSessionsApp(actorId, type)
				for (const path of readPaths(session.id)) {
					expect((await app.request(jsonGet(path, headers))).status, `${type} ${path}`).toBe(200)
				}
			}
		})

		it('can be stopped by the agent that started it but not by another agent or member', async () => {
			const session = await agentStartedSession()
			const path = `/api/sessions/${session.id}/stop`

			const parent = createSessionsApp(agentId, 'agent')
			const stopped = await parent.app.request(jsonRequest('POST', path, undefined, headers))
			expect(stopped.status).toBe(200)

			for (const [actorId, type] of [
				[otherAgentId, 'agent'],
				[otherMemberId, 'human'],
			] as const) {
				const { app } = createSessionsApp(actorId, type)
				const res = await app.request(jsonRequest('POST', path, undefined, headers))
				expect(res.status, type).toBe(403)
			}
		})
	})

	describe('the session list', () => {
		const SECRET = 'secret prompt of the starter'
		type Row = { id: string; actionPrompt?: string; title?: string }

		async function list(actorId: string, type: 'human' | 'agent', qs = '') {
			const { app } = createSessionsApp(actorId, type)
			const res = await app.request(jsonGet(`/api/sessions${qs}`, headers))
			expect(res.status).toBe(200)
			const rows = (await res.json()) as Row[]
			return { rows, ids: rows.map((row) => row.id), raw: JSON.stringify(rows) }
		}

		it("hides another member's private session, lean and verbose", async () => {
			const session = await personSession({ actionPrompt: SECRET })

			for (const qs of ['', '?verbose=true']) {
				const { ids, raw } = await list(otherMemberId, 'human', qs)
				expect(ids, qs).not.toContain(session.id)
				expect(raw, qs).not.toContain(SECRET)
			}
		})

		it('hides it from another agent too', async () => {
			const session = await personSession({ actionPrompt: SECRET })

			const { ids, raw } = await list(otherAgentId, 'agent', '?verbose=true')
			expect(ids).not.toContain(session.id)
			expect(raw).not.toContain(SECRET)
		})

		it('shows it to the starter, an admin and the owner, lean and verbose', async () => {
			const session = await personSession({ actionPrompt: SECRET })

			for (const actorId of [starterId, adminId, ownerId]) {
				for (const qs of ['', '?verbose=true']) {
					const { ids } = await list(actorId, 'human', qs)
					expect(ids, `${actorId} ${qs}`).toContain(session.id)
				}
			}
		})

		it('shows trigger-started and agent-started sessions to every member', async () => {
			const trigger = await insertTrigger(db, workspaceId, starterId, agentId)
			if (!trigger) throw new Error('failed to seed trigger')
			const fromTrigger = await personSession({ triggerId: trigger.id })
			const fromAgent = await insertSession(db, workspaceId, otherAgentId, agentId, {
				status: 'running',
			})
			if (!fromAgent) throw new Error('failed to seed session')

			for (const qs of ['', '?verbose=true']) {
				const { ids } = await list(otherMemberId, 'human', qs)
				expect(ids, qs).toEqual(expect.arrayContaining([fromTrigger.id, fromAgent.id]))
			}
		})

		it("shows a chat's sessions only to people still in the chat", async () => {
			const conversationId = await chat([starterId, otherMemberId])
			const session = await personSession({ interactive: true, conversationId })
			const helper = await personSession({ config: { ask_conversation_id: conversationId } })

			const inChat = await list(otherMemberId, 'human', '?verbose=true')
			expect(inChat.ids).toEqual(expect.arrayContaining([session.id, helper.id]))

			await db
				.update(conversationParticipants)
				.set({ leftAt: new Date() })
				.where(eq(conversationParticipants.actorId, otherMemberId))
			const left = await list(otherMemberId, 'human', '?verbose=true')
			expect(left.ids).not.toContain(session.id)
			expect(left.ids).not.toContain(helper.id)
		})

		it('keeps the chat running indicator working for people in the chat', async () => {
			const conversationId = await chat([starterId, otherMemberId])
			const session = await personSession({ interactive: true, conversationId })

			const filter = `?conversation_id=${conversationId}`
			for (const qs of [filter, `${filter}&verbose=true`]) {
				const { ids } = await list(otherMemberId, 'human', qs)
				expect(ids, qs).toEqual([session.id])
			}
		})

		it('keeps the object activity card filter from leaking a private mention session', async () => {
			const objectId = '00000000-0000-0000-0000-0000000000aa'
			const session = await personSession({
				config: { mention: { object_id: objectId, comment_event_id: 7 } },
			})

			const other = await list(otherMemberId, 'human', `?mention_object_id=${objectId}`)
			expect(other.ids).toEqual([])
			const starter = await list(starterId, 'human', `?mention_object_id=${objectId}`)
			expect(starter.ids).toEqual([session.id])
		})

		it('pages through only the visible sessions without skips or repeats', async () => {
			const visible: string[] = []
			const base = Date.now() - 60_000
			for (let i = 0; i < 6; i++) {
				const mine = i % 2 === 0
				const createdBy = mine ? otherMemberId : starterId
				const session = await insertSession(db, workspaceId, agentId, createdBy, {
					status: 'completed',
					updatedAt: new Date(base + i * 1000),
				})
				if (!session) throw new Error('failed to seed session')
				if (mine) visible.unshift(session.id)
			}

			for (const verbose of ['', '&verbose=true']) {
				const seen: string[] = []
				let before = ''
				for (let page = 0; page < 5; page++) {
					const { rows } = await list(otherMemberId, 'human', `?limit=2${verbose}${before}`)
					if (rows.length === 0) break
					seen.push(...rows.map((row) => row.id))
					const last = rows[rows.length - 1]
					const [row] = await db
						.select()
						.from(sessions)
						.where(eq(sessions.id, last?.id ?? ''))
					before = `&before=${encodeURIComponent((row?.updatedAt as Date).toISOString())}`
				}
				expect(seen, verbose).toEqual(visible)
			}
		})
	})

	it('does not change the session when a stop is refused', async () => {
		const session = await personSession()
		const { app } = createSessionsApp(otherMemberId, 'human')

		await app.request(jsonRequest('POST', `/api/sessions/${session.id}/stop`, undefined, headers))

		const [row] = await db.select().from(sessions).where(eq(sessions.id, session.id))
		expect(row?.status).toBe('running')
	})
})
