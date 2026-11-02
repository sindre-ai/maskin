import { objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import {
	ensureWorkspaceMember,
	insertActor,
	insertConversation,
	insertObject,
	insertSession,
	insertWorkspace,
} from '../factories'
import { jsonGet } from '../helpers'
import { createIntegrationApp, db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')

function createApp() {
	return createIntegrationApp({ path: '/api/objects', module: objectsRoutes })
}

async function readLastSession(objectId: string) {
	const res = await createApp().request(jsonGet(`/api/objects/${objectId}`))
	expect(res.status).toBe(200)
	return (await res.json()).last_session
}

describe('GET /api/objects/:id last_session', () => {
	let workspaceId: string
	let agentId: string
	let objectId: string

	beforeEach(async () => {
		const ws = await insertWorkspace(db, getTestActorId())
		workspaceId = ws.id
		const agent = await insertActor(db, { type: 'agent' })
		agentId = agent.id
		objectId = (await insertObject(db, workspaceId, getTestActorId())).id
	})

	it('is null for an object with no session', async () => {
		expect(await readLastSession(objectId)).toBeNull()
	})

	it('summarises a failed session with a short reason and no raw output', async () => {
		const chat = await insertConversation(db, workspaceId, getTestActorId())
		const longMessage = `Provider said no. ${'x'.repeat(500)}`
		const session = await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'failed',
			initiatedFromObjectId: objectId,
			conversationId: chat.id,
			completedAt: new Date(),
			result: {
				exit_code: 1,
				error: 'raw stderr that must not be used',
				failure_reason: {
					provider: 'anthropic',
					reason_code: 'rate_limited',
					human_message: longMessage,
					http_status: 429,
					reset_at: null,
					verbatim_output: 'SECRET-TOKEN-IN-LOG',
				},
			},
		})

		const last = await readLastSession(objectId)
		expect(last).toMatchObject({
			id: session.id,
			status: 'failed',
			agent_id: agentId,
			chat_id: chat.id,
			created_by_actor_id: getTestActorId(),
		})
		expect(last.started_at).toEqual(expect.any(String))
		expect(last.failure_reason.length).toBeLessThanOrEqual(200)
		expect(last.failure_reason.startsWith('Provider said no.')).toBe(true)
		expect(JSON.stringify(last)).not.toContain('SECRET-TOKEN-IN-LOG')
		expect(JSON.stringify(last)).not.toContain('raw stderr')
	})

	it('returns the running session with no failure reason', async () => {
		const session = await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'running',
			initiatedFromObjectId: objectId,
			result: { error: 'stale error from a previous attempt' },
		})
		await db.update(objects).set({ activeSessionId: session.id }).where(eq(objects.id, objectId))

		const last = await readLastSession(objectId)
		expect(last).toMatchObject({ id: session.id, status: 'running', failure_reason: null })
		expect(last.chat_id).toBeNull()
	})

	it('picks the newest session when several were started for the object', async () => {
		await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'failed',
			initiatedFromObjectId: objectId,
			createdAt: new Date('2026-01-01T00:00:00Z'),
		})
		const newest = await insertSession(db, workspaceId, agentId, getTestActorId(), {
			status: 'completed',
			initiatedFromObjectId: objectId,
			createdAt: new Date('2026-02-01T00:00:00Z'),
		})
		expect((await readLastSession(objectId)).id).toBe(newest.id)
	})

	it('hides a session a person started from other members of the workspace', async () => {
		const owner = await insertActor(db, { type: 'human' })
		const ws = await insertWorkspace(db, owner.id)
		await ensureWorkspaceMember(db, ws.id, getTestActorId())
		const obj = await insertObject(db, ws.id, owner.id)
		await insertSession(db, ws.id, agentId, owner.id, {
			status: 'failed',
			initiatedFromObjectId: obj.id,
		})
		expect(await readLastSession(obj.id)).toBeNull()
	})
})
