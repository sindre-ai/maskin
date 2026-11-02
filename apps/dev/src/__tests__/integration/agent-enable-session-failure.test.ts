import { events, actors, sessions, workspaceMembers } from '@maskin/db/schema'
import { and, eq } from 'drizzle-orm'
import { insertActor, insertSession, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: sessionsRoutes } = await import('../../routes/sessions')

// POST /api/actors/:id/enable lifts a person's pause without starting anything, and
// the session list and detail carry a short failure_reason, against real Postgres.

describe('POST /api/actors/:id/enable', () => {
	let workspaceId: string

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
	})

	async function agent(name: string, overrides: Record<string, unknown> = {}) {
		const row = await insertActor(db, { type: 'agent', name, ...overrides })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: row.id, role: 'member' })
		return row
	}

	const call = (path: string, ws = workspaceId) =>
		createIntegrationApp({ path: '/api/actors', module: actorsRoutes }).request(
			jsonRequest('POST', path, undefined, { 'x-workspace-id': ws }),
		)

	const stored = async (id: string) =>
		(
			await db
				.select({ agentState: actors.agentState, metadata: actors.metadata })
				.from(actors)
				.where(eq(actors.id, id))
		)[0]

	const sessionCount = async (agentId: string) =>
		(await db.select({ id: sessions.id }).from(sessions).where(eq(sessions.actorId, agentId)))
			.length

	it('clears a person’s pause, keeps other metadata and starts no session', async () => {
		const bot = await agent('Bot')
		expect((await call(`/api/actors/${bot.id}/pause`)).status).toBe(200)
		expect(await stored(bot.id)).toEqual({
			agentState: 'paused',
			metadata: { paused_by: 'human' },
		})
		await db
			.update(actors)
			.set({ metadata: { voice_enabled: true, paused_by: 'human' } })
			.where(eq(actors.id, bot.id))

		const res = await call(`/api/actors/${bot.id}/enable`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ id: bot.id, agentState: 'idle' })
		expect(await stored(bot.id)).toEqual({ agentState: 'idle', metadata: { voice_enabled: true } })
		expect(await sessionCount(bot.id)).toBe(0)

		const [event] = await db
			.select({ action: events.action })
			.from(events)
			.where(and(eq(events.entityId, bot.id), eq(events.action, 'agent_enabled')))
		expect(event).toBeDefined()
	})

	it('lands on running when a session is live, and leaves a paused session paused', async () => {
		const bot = await agent('Bot')
		await db
			.update(actors)
			.set({ agentState: 'paused', metadata: { paused_by: 'human' } })
			.where(eq(actors.id, bot.id))
		await insertSession(db, workspaceId, bot.id, getTestActorId(), { status: 'queued' })
		const paused = await insertSession(db, workspaceId, bot.id, getTestActorId(), {
			status: 'paused',
		})

		expect((await call(`/api/actors/${bot.id}/enable`)).status).toBe(200)
		expect(await stored(bot.id)).toEqual({ agentState: 'running', metadata: {} })
		const [after] = await db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, paused.id))
		expect(after?.status).toBe('paused')
		expect(await sessionCount(bot.id)).toBe(2)
	})

	it('returns an agent that is not paused unchanged', async () => {
		const bot = await agent('Bot')
		await db.update(actors).set({ agentState: 'failed' }).where(eq(actors.id, bot.id))

		const res = await call(`/api/actors/${bot.id}/enable`)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ agentState: 'failed' })
		expect((await stored(bot.id))?.agentState).toBe('failed')
		expect(await sessionCount(bot.id)).toBe(0)
	})

	it('404s for an agent outside the workspace and 400s for a person', async () => {
		const outsider = await insertActor(db, { type: 'agent', name: 'Outsider' })
		expect((await call(`/api/actors/${outsider.id}/enable`)).status).toBe(404)

		const person = await insertActor(db, { type: 'human', name: 'Person' })
		await db.insert(workspaceMembers).values({ workspaceId, actorId: person.id, role: 'member' })
		expect((await call(`/api/actors/${person.id}/enable`)).status).toBe(400)
	})
})

describe('session list and detail failure_reason', () => {
	let workspaceId: string
	let agentId: string

	beforeEach(async () => {
		workspaceId = (await insertWorkspace(db, getTestActorId())).id
		agentId = (await insertActor(db, { type: 'agent', name: 'Bot' })).id
	})

	const get = async (path: string) => {
		const res = await createIntegrationApp({
			path: '/api/sessions',
			module: sessionsRoutes,
		}).request(jsonGet(path, { 'x-workspace-id': workspaceId }))
		expect(res.status).toBe(200)
		return res.json()
	}

	const failed = (result: Record<string, unknown>) =>
		insertSession(db, workspaceId, agentId, getTestActorId(), { status: 'failed', result })

	it('is a short human message on failed sessions in the lean list, verbose list and detail', async () => {
		const session = await failed({
			exit_code: 1,
			error: 'raw stderr that must not be used',
			failure_reason: {
				provider: 'anthropic',
				reason_code: 'rate_limited',
				human_message: `Provider said no.\n  ${'x'.repeat(500)}`,
				http_status: 429,
				reset_at: null,
				verbatim_output: 'SECRET-TOKEN-IN-LOG',
			},
		})

		const lean = await get('/api/sessions')
		expect(lean).toHaveLength(1)
		expect(lean[0].id).toBe(session.id)
		expect(lean[0].failure_reason.length).toBeLessThanOrEqual(200)
		expect(lean[0].failure_reason.startsWith('Provider said no. xxx')).toBe(true)
		expect(JSON.stringify(lean)).not.toContain('SECRET-TOKEN-IN-LOG')
		expect(JSON.stringify(lean)).not.toContain('raw stderr')

		const verbose = await get('/api/sessions?verbose=true')
		expect(verbose[0].failure_reason).toBe(lean[0].failure_reason)

		const detail = await get(`/api/sessions/${session.id}`)
		expect(detail.failure_reason).toBe(lean[0].failure_reason)
	})

	it('falls back to the short error text when no classified reason was stored', async () => {
		await failed({ exit_code: 1, error: '  The run ended\n before it finished.  ' })
		const lean = await get('/api/sessions')
		expect(lean[0].failure_reason).toBe('The run ended before it finished.')
	})

	it('is null unless the session failed', async () => {
		await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'completed',
			result: { exit_code: 0, error: 'stale error from an earlier attempt' },
		})
		await failed({ exit_code: 1 })

		const lean = await get('/api/sessions')
		expect(lean).toHaveLength(2)
		const byStatus = Object.fromEntries(
			lean.map((row: { status: string; failure_reason: string | null }) => [
				row.status,
				row.failure_reason,
			]),
		)
		expect(byStatus.completed).toBeNull()
		expect(byStatus.failed).toBeNull()
	})
})
