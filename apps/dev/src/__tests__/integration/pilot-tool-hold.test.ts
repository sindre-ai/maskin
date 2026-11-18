import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, objects, sessions, triggers } from '@maskin/db/schema'
import { PILOT_REFUSAL } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { createApiError, formatZodError } from '../../lib/errors'
import {
	FLOW_APPROVAL_USED_ACTION,
	FLOW_CALL_ANSWERED_ACTION,
	FLOW_GATE_REFUSED_ACTION,
	checkPilotHold,
	recordFlowCallAnswer,
	resolveFlowCallTap,
} from '../../lib/pilot-hold'
import {
	buildSession,
	buildTrigger,
	ensureWorkspaceMember,
	insertActor,
	insertObject,
	insertWorkspace,
} from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: eventsRoutes } = await import('../../routes/events')

function appAs(actorId: string, actorType: string) {
	const app = new OpenAPIHono<{ Variables: Record<string, unknown> }>({
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
		c.set('db', db as Database)
		c.set('actorId', actorId)
		c.set('actorType', actorType)
		c.set('notifyBridge', {})
		await next()
	})
	app.route('/api/events', eventsRoutes as never)
	return app
}

async function setup(status = 'pilot') {
	const ws = await insertWorkspace(db, getTestActorId())
	const agent = await insertActor(db, { type: 'agent' })
	const [trigger] = await db
		.insert(triggers)
		.values(buildTrigger({ workspaceId: ws.id, targetActorId: agent.id, createdBy: agent.id }))
		.returning()
	const flow = await insertObject(db, ws.id, getTestActorId(), {
		type: 'loop',
		title: 'Weekly site update',
		status,
		metadata: { trigger_ids: [trigger.id] },
	})
	const [session] = await db
		.insert(sessions)
		.values(buildSession({ workspaceId: ws.id, actorId: agent.id, triggerId: trigger.id }))
		.returning()
	return { ws, agent, flow, session }
}

const call = (
	s: Awaited<ReturnType<typeof setup>>,
	args: unknown = { id: 'a' },
	tool = 'delete_object',
) =>
	checkPilotHold(db, {
		workspaceId: s.ws.id,
		agentId: s.agent.id,
		sessionId: s.session.id,
		tool,
		args,
	})

async function eventsOf(workspaceId: string, action: string) {
	return db
		.select()
		.from(events)
		.where(and(eq(events.workspaceId, workspaceId), eq(events.action, action)))
}

/** What the reply route does when a person answers the card: look the card up, record the answer. */
async function personAnswers(s: Awaited<ReturnType<typeof setup>>, answer: 'Approve' | 'Reject') {
	const [refused] = await eventsOf(s.ws.id, FLOW_GATE_REFUSED_ACTION)
	const cardId = Number((refused?.data as { card_event_id: string }).card_event_id)
	const tap = await resolveFlowCallTap(db, {
		workspaceId: s.ws.id,
		entityId: s.flow.id,
		parentEventId: cardId,
		content: answer,
	})
	expect(tap).not.toBeNull()
	await recordFlowCallAnswer(db, {
		workspaceId: s.ws.id,
		approverId: getTestActorId(),
		tap: tap as NonNullable<typeof tap>,
	})
}

describe('a flow in pilot holds outbound tools', () => {
	it('refuses the call, posts one card, and lets the repeat through once after Approve', async () => {
		const s = await setup()
		const first = await call(s)
		expect(first.held).toBe(true)
		expect(first.held && first.message).toContain(PILOT_REFUSAL)

		const cards = await db
			.select()
			.from(events)
			.where(and(eq(events.workspaceId, s.ws.id), eq(events.action, 'commented')))
		expect(cards).toHaveLength(1)
		expect(cards[0]?.actorId).toBe(s.agent.id)

		// Still waiting: the same call posts no second card.
		expect((await call(s)).held).toBe(true)
		expect(
			await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, s.ws.id), eq(events.action, 'commented'))),
		).toHaveLength(1)

		await personAnswers(s, 'Approve')
		expect((await call(s)).held).toBe(false)
		expect(await eventsOf(s.ws.id, FLOW_APPROVAL_USED_ACTION)).toHaveLength(1)

		// One approval lets one call through: the next identical call needs a new card.
		expect((await call(s)).held).toBe(true)
		expect(
			await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, s.ws.id), eq(events.action, 'commented'))),
		).toHaveLength(2)
	})

	it('treats a changed argument as a new call that needs its own card', async () => {
		const s = await setup()
		await call(s, { id: 'a' })
		await personAnswers(s, 'Approve')
		expect((await call(s, { id: 'b' })).held).toBe(true)
		expect((await call(s, { id: 'a' })).held).toBe(false)
	})

	it('keeps a rejected call refused and posts no second card', async () => {
		const s = await setup()
		await call(s)
		await personAnswers(s, 'Reject')
		const again = await call(s)
		expect(again.held && again.message).toContain('rejected')
		expect(
			await db
				.select()
				.from(events)
				.where(and(eq(events.workspaceId, s.ws.id), eq(events.action, 'commented'))),
		).toHaveLength(1)
	})

	it('passes under supervised and live, with no card, and reads the status on every call', async () => {
		const s = await setup('supervised')
		expect((await call(s)).held).toBe(false)
		await db.update(objects).set({ status: 'live' }).where(eq(objects.id, s.flow.id))
		expect((await call(s)).held).toBe(false)
		await db.update(objects).set({ status: 'pilot' }).where(eq(objects.id, s.flow.id))
		expect((await call(s)).held).toBe(true)
		expect(await eventsOf(s.ws.id, FLOW_GATE_REFUSED_ACTION)).toHaveLength(1)
	})

	it('does not hold a call with no session, a session of another agent, or a session under no flow', async () => {
		const s = await setup()
		const base = { workspaceId: s.ws.id, agentId: s.agent.id, tool: 'delete_object', args: {} }
		expect((await checkPilotHold(db, base)).held).toBe(false)
		const other = await insertActor(db, { type: 'agent' })
		expect(
			(await checkPilotHold(db, { ...base, agentId: other.id, sessionId: s.session.id })).held,
		).toBe(false)
		const [free] = await db
			.insert(sessions)
			.values(buildSession({ workspaceId: s.ws.id, actorId: s.agent.id }))
			.returning()
		expect((await checkPilotHold(db, { ...base, sessionId: free?.id })).held).toBe(false)
	})

	it('holds a session woken on the flow itself, so the repeat call is checked too', async () => {
		const s = await setup()
		const [woken] = await db
			.insert(sessions)
			.values(
				buildSession({
					workspaceId: s.ws.id,
					actorId: s.agent.id,
					initiatedFromObjectId: s.flow.id,
				}),
			)
			.returning()
		const result = await checkPilotHold(db, {
			workspaceId: s.ws.id,
			agentId: s.agent.id,
			sessionId: woken?.id,
			tool: 'delete_object',
			args: {},
		})
		expect(result.held).toBe(true)
	})

	it('writes the events without the arguments', async () => {
		const s = await setup()
		await call(s, { id: 'secret-looking-value' })
		await personAnswers(s, 'Approve')
		await call(s, { id: 'secret-looking-value' })
		for (const action of [
			FLOW_GATE_REFUSED_ACTION,
			FLOW_CALL_ANSWERED_ACTION,
			FLOW_APPROVAL_USED_ACTION,
		]) {
			const rows = await eventsOf(s.ws.id, action)
			expect(rows.length).toBeGreaterThan(0)
			for (const row of rows) expect(JSON.stringify(row.data)).not.toContain('secret-looking')
		}
	})

	it('only counts a reply on a card Maskin recorded refusing a call with', async () => {
		const s = await setup()
		const tap = await resolveFlowCallTap(db, {
			workspaceId: s.ws.id,
			entityId: s.flow.id,
			parentEventId: 999999,
			content: 'Approve',
		})
		expect(tap).toBeNull()
	})
})

describe('only a person can answer a pilot hold card', () => {
	async function heldWithCard() {
		const s = await setup()
		await ensureWorkspaceMember(db, s.ws.id, s.agent.id)
		await call(s)
		const [refused] = await eventsOf(s.ws.id, FLOW_GATE_REFUSED_ACTION)
		const cardId = Number((refused?.data as { card_event_id: string }).card_event_id)
		return { s, cardId }
	}

	const reply = (
		s: Awaited<ReturnType<typeof setup>>,
		cardId: number,
		as: string,
		type: string,
		extra: Record<string, string> = {},
	) =>
		appAs(as, type).request(
			jsonRequest(
				'POST',
				'/api/events',
				{ entity_id: s.flow.id, content: 'Approve', parent_event_id: cardId },
				{ 'X-Workspace-Id': s.ws.id, ...extra },
			),
		)

	it('lets the repeated call through after a person taps Approve', async () => {
		const { s, cardId } = await heldWithCard()
		expect((await reply(s, cardId, getTestActorId(), 'human')).status).toBe(201)
		expect(await eventsOf(s.ws.id, FLOW_CALL_ANSWERED_ACTION)).toHaveLength(1)
		expect((await call(s)).held).toBe(false)
	})

	it('does not count a reply from the agent whose call was held', async () => {
		const { s, cardId } = await heldWithCard()
		await reply(s, cardId, s.agent.id, 'agent')
		expect(await eventsOf(s.ws.id, FLOW_CALL_ANSWERED_ACTION)).toHaveLength(0)
		expect((await call(s)).held).toBe(true)
	})

	it('does not count a tap sent through MCP, where a model holds the person key', async () => {
		const { s, cardId } = await heldWithCard()
		await reply(s, cardId, getTestActorId(), 'human', { 'X-Client-Source': 'mcp' })
		expect(await eventsOf(s.ws.id, FLOW_CALL_ANSWERED_ACTION)).toHaveLength(0)
		expect((await call(s)).held).toBe(true)
	})
})
