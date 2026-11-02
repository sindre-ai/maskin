import { events, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { isWorkspaceIdleSinceLastRun } from '../../services/trigger-runner'
import { insertActor, insertSession, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Integration proof for the skip_when_idle cron guard against real Postgres:
// the joins on actors.type and the "since the last trigger_fired" window are
// what a mocked DB cannot check.
describe('isWorkspaceIdleSinceLastRun (integration)', () => {
	const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000)

	async function setup() {
		const human = await insertActor(db, { type: 'human' })
		const agent = await insertActor(db, { type: 'agent', email: null })
		const ws = await insertWorkspace(db, human.id)
		const trigger = await insertTrigger(db, ws.id, human.id, agent.id, {
			type: 'cron',
			config: { expression: '0 9 * * *', skip_when_idle: true },
			createdAt: minutesAgo(600),
		})
		return { human, agent, ws, trigger }
	}

	async function recordFired(wsId: string, agentId: string, triggerId: string, createdAt: Date) {
		await db.insert(events).values({
			workspaceId: wsId,
			actorId: agentId,
			action: 'trigger_fired',
			entityType: 'trigger',
			entityId: triggerId,
			data: {},
			createdAt,
		})
	}

	async function recordEventBy(wsId: string, actorId: string, createdAt: Date, action = 'updated') {
		await db.insert(events).values({
			workspaceId: wsId,
			actorId,
			action,
			entityType: 'object',
			entityId: crypto.randomUUID(),
			data: {},
			createdAt,
		})
	}

	it('is idle when only agents acted since the last run', async () => {
		const { agent, ws, trigger } = await setup()
		await recordFired(ws.id, agent.id, trigger.id, minutesAgo(120))
		await recordEventBy(ws.id, agent.id, minutesAgo(60))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(true)
	})

	it('is not idle when a person made a change since the last run', async () => {
		const { human, agent, ws, trigger } = await setup()
		await recordFired(ws.id, agent.id, trigger.id, minutesAgo(120))
		await recordEventBy(ws.id, human.id, minutesAgo(60))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(false)
	})

	it('ignores person activity from before the last run', async () => {
		const { human, agent, ws, trigger } = await setup()
		await recordEventBy(ws.id, human.id, minutesAgo(300))
		await recordFired(ws.id, agent.id, trigger.id, minutesAgo(120))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(true)
	})

	it('is not idle when a person started a session since the last run', async () => {
		const { human, agent, ws, trigger } = await setup()
		await recordFired(ws.id, agent.id, trigger.id, minutesAgo(120))
		const session = await insertSession(db, ws.id, agent.id, human.id, { triggerId: null })
		await db
			.update(sessions)
			.set({ createdAt: minutesAgo(30) })
			.where(eq(sessions.id, session.id))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(false)
	})

	it('does not count a session another trigger started, even though a person owns the trigger', async () => {
		const { human, agent, ws, trigger } = await setup()
		await recordFired(ws.id, agent.id, trigger.id, minutesAgo(120))
		const session = await insertSession(db, ws.id, agent.id, human.id, { triggerId: trigger.id })
		await db
			.update(sessions)
			.set({ createdAt: minutesAgo(30) })
			.where(eq(sessions.id, session.id))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(true)
	})

	it('uses the trigger creation time when it has never fired', async () => {
		const { human, ws, trigger } = await setup()
		await recordEventBy(ws.id, human.id, minutesAgo(10))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(false)
	})

	it('does not look at another workspace', async () => {
		const { agent, ws, trigger } = await setup()
		await recordFired(ws.id, agent.id, trigger.id, minutesAgo(120))
		const other = await insertWorkspace(db, getTestActorId())
		await recordEventBy(other.id, getTestActorId(), minutesAgo(60))

		expect(await isWorkspaceIdleSinceLastRun(db, trigger)).toBe(true)
	})
})
