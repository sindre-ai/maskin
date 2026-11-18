import { randomUUID } from 'node:crypto'
import { objects, sendPermissions, sessions, triggers } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { decideSend } from '../../lib/send-gate'
import { flowsOfSession } from '../../lib/session-flow'
import {
	buildSession,
	buildTrigger,
	insertActor,
	insertObject,
	insertRelationship,
	insertWorkspace,
} from '../factories'
import { db, getTestActorId } from './global-setup'

async function setup() {
	const ws = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, { type: 'agent' })
	const [trigger] = await db
		.insert(triggers)
		.values(buildTrigger({ workspaceId: ws.id, targetActorId: agent.id, createdBy: agent.id }))
		.returning()
	return { ws, agent, trigger }
}

async function insertFlow(
	workspaceId: string,
	status: string,
	triggerIds: string[] = [],
	title = 'Flow',
) {
	return insertObject(db, workspaceId, getTestActorId(), {
		type: 'loop',
		title,
		status,
		metadata: { trigger_ids: triggerIds },
	})
}

async function insertSession(overrides: Record<string, unknown>) {
	const [row] = await db
		.insert(sessions)
		.values(buildSession({ createdBy: getTestActorId(), ...overrides }))
		.returning()
	return row
}

function setting(
	workspaceId: string,
	agentId: string,
	mode: 'always_allow' | 'ask_first' | 'deny',
	kind = 'email',
) {
	return db.insert(sendPermissions).values({
		workspaceId,
		agentId,
		kind,
		mode,
		updatedBy: getTestActorId(),
	} as never)
}

describe('a flow in pilot holds sends', () => {
	it('turns Always allow into needs_approval for a session whose trigger the pilot flow lists', async () => {
		const { ws, agent, trigger } = await setup()
		await insertFlow(ws.id, 'pilot', [trigger.id])
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		for (const kind of ['email', 'slack_message', 'linkedin_message', 'linkedin_post']) {
			expect(
				await decideSend(db, {
					workspaceId: ws.id,
					agentId: agent.id,
					kind,
					sessionId: session.id,
				}),
			).toBe('needs_approval')
		}
	})

	it('holds under the old stored name of pilot too, until the rename lands', async () => {
		const { ws, agent, trigger } = await setup()
		await insertFlow(ws.id, 'learning', [trigger.id])
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		expect(
			await decideSend(db, {
				workspaceId: ws.id,
				agentId: agent.id,
				kind: 'email',
				sessionId: session.id,
			}),
		).toBe('needs_approval')
	})

	it('sends as before under a supervised or live flow, and for a call with no session', async () => {
		const { ws, agent, trigger } = await setup()
		const flow = await insertFlow(ws.id, 'supervised', [trigger.id])
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		const params = { workspaceId: ws.id, agentId: agent.id, kind: 'email' }
		expect(await decideSend(db, { ...params, sessionId: session.id })).toBe('send_now')
		await db.update(objects).set({ status: 'live' }).where(eq(objects.id, flow.id))
		expect(await decideSend(db, { ...params, sessionId: session.id })).toBe('send_now')
		expect(await decideSend(db, params)).toBe('send_now')
	})

	it('keeps deny as deny and ask_first as ask_first', async () => {
		const { ws, agent, trigger } = await setup()
		await insertFlow(ws.id, 'pilot', [trigger.id])
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		await setting(ws.id, agent.id, 'deny', 'email')
		await setting(ws.id, agent.id, 'ask_first', 'slack_message')
		const base = { workspaceId: ws.id, agentId: agent.id, sessionId: session.id }
		expect(await decideSend(db, { ...base, kind: 'email' })).toBe('denied')
		expect(await decideSend(db, { ...base, kind: 'slack_message' })).toBe('needs_approval')
	})

	it('reads the flow status on every call, nothing cached', async () => {
		const { ws, agent, trigger } = await setup()
		const flow = await insertFlow(ws.id, 'pilot', [trigger.id])
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		const params = { workspaceId: ws.id, agentId: agent.id, kind: 'email', sessionId: session.id }
		expect(await decideSend(db, params)).toBe('needs_approval')
		await db.update(objects).set({ status: 'supervised' }).where(eq(objects.id, flow.id))
		expect(await decideSend(db, params)).toBe('send_now')
	})

	it('holds when any one of several qualifying flows is in pilot', async () => {
		const { ws, agent, trigger } = await setup()
		await insertFlow(ws.id, 'live', [trigger.id], 'Live flow')
		await insertFlow(ws.id, 'pilot', [trigger.id], 'Pilot flow')
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		expect(
			await decideSend(db, {
				workspaceId: ws.id,
				agentId: agent.id,
				kind: 'email',
				sessionId: session.id,
			}),
		).toBe('needs_approval')
	})

	it('finds the flow through the source item when the trigger is in no flow', async () => {
		const { ws, agent } = await setup()
		const flow = await insertFlow(ws.id, 'pilot')
		const item = await insertObject(db, ws.id, getTestActorId(), { type: 'task' })
		await insertRelationship(db, getTestActorId(), {
			sourceType: 'object',
			sourceId: flow.id,
			targetType: 'object',
			targetId: item.id,
			type: 'in_loop',
		})
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			initiatedFromObjectId: item.id,
		})
		expect(
			await decideSend(db, {
				workspaceId: ws.id,
				agentId: agent.id,
				kind: 'email',
				sessionId: session.id,
			}),
		).toBe('needs_approval')
	})

	it('lets a helper session inherit the flow of the session that started it', async () => {
		const { ws, agent, trigger } = await setup()
		const flow = await insertFlow(ws.id, 'pilot', [trigger.id])
		const parent = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		const helper = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			spawnedBySessionId: parent.id,
		})
		const flows = await flowsOfSession(db, {
			workspaceId: ws.id,
			agentId: agent.id,
			sessionId: helper.id,
		})
		expect(flows.map((f) => f.id)).toEqual([flow.id])
	})

	it('does not trust a session id from another workspace or another agent', async () => {
		const { ws, agent, trigger } = await setup()
		await insertFlow(ws.id, 'pilot', [trigger.id])
		const session = await insertSession({
			workspaceId: ws.id,
			actorId: agent.id,
			triggerId: trigger.id,
		})
		const other = await insertActor(db, { type: 'agent' })
		const elsewhere = await insertWorkspace(db, getTestActorId())
		expect(
			await flowsOfSession(db, { workspaceId: ws.id, agentId: other.id, sessionId: session.id }),
		).toEqual([])
		expect(
			await flowsOfSession(db, {
				workspaceId: elsewhere.id,
				agentId: agent.id,
				sessionId: session.id,
			}),
		).toEqual([])
		expect(
			await flowsOfSession(db, {
				workspaceId: ws.id,
				agentId: agent.id,
				sessionId: randomUUID(),
			}),
		).toEqual([])
	})

	it('holds the send when the flow lookup fails', async () => {
		const { ws, agent } = await setup()
		// The send setting is read first and passes; every read after it (the session) fails.
		let reads = 0
		const broken = new Proxy(db, {
			get(target, prop, receiver) {
				if (prop === 'select') {
					return (...args: unknown[]) => {
						if (++reads > 1) throw new Error('lookup failed')
						return (target.select as (...a: unknown[]) => unknown)(...args)
					}
				}
				return Reflect.get(target, prop, receiver)
			},
		})
		expect(
			await decideSend(broken, {
				workspaceId: ws.id,
				agentId: agent.id,
				kind: 'email',
				sessionId: randomUUID(),
			}),
		).toBe('needs_approval')
	})
})
