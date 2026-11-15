import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, doneWhenLines, doneWhenSkips, jobGoAheads } from '@maskin/db/schema'
import type { CommentDecision } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import {
	approveDraftDoneWhen,
	getDoneWhen,
	hasApprovedDoneWhen,
	resolveDoneWhenTap,
	writeDraftDoneWhen,
} from '../../lib/done-when'
import { createApiError, formatZodError } from '../../lib/errors'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: doneWhenRoutes } = await import('../../routes/object-done-when')

/**
 * A job's done-when list, against real Postgres. An agent can only write draft rows; the approval
 * exists only when a person taps, and it also records the go-ahead. A skip on a bet, a target or a
 * job with a target behind it is refused and logged. Only a person ticks a line.
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
	app.route('/api/objects', doneWhenRoutes as never)
	return app
}

const BLOCK = {
	lines: [
		{ text: 'The first 10 emails are sent', checked_by: 'person' as const, needs_yes: true },
		{ text: 'A report is filed', checked_by: 'person' as const },
	],
}

async function setup(type = 'task') {
	const person = getTestActorId()
	const workspace = await insertWorkspace(db, person)
	const agent = await insertActor(db, { type: 'agent', name: 'Prospector' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	const job = await insertObject(db, workspace.id, person, {
		type,
		status: type === 'bet' ? 'active' : 'in_progress',
		driver: agent.id,
	})
	return { person, workspace, agent, job }
}

/** Posts a card row like the comment route does, then writes the draft under that card's id. */
async function draft(workspaceId: string, objectId: string, actorId: string, block = BLOCK) {
	const [card] = await db
		.insert(events)
		.values({
			workspaceId,
			actorId,
			entityType: 'object',
			entityId: objectId,
			action: 'commented',
			data: { content: 'List ready' },
		})
		.returning()
	if (!card) throw new Error('no card')
	const cardEventId = Number(card.id)
	await db.transaction((tx) =>
		writeDraftDoneWhen(tx, { workspaceId, objectId, actorId, cardEventId, block }),
	)
	return cardEventId
}

describe('the done-when draft and its approval', () => {
	it('writes a draft, replaces it on a rewrite, and shows it as not approved', async () => {
		const { workspace, agent, job } = await setup()
		await draft(workspace.id, job.id, agent.id)
		await draft(workspace.id, job.id, agent.id)
		const list = await getDoneWhen(db, job.id)
		expect(list).toMatchObject({ status: 'draft', total: 2, true_count: 0, approved_by: null })
		expect(list?.lines.map((l) => l.text)).toEqual(BLOCK.lines.map((l) => l.text))
	})

	it('a person approving makes the list approved and records a card go-ahead', async () => {
		const { person, workspace, agent, job } = await setup()
		const cardEventId = await draft(workspace.id, job.id, agent.id)
		expect(
			await db.transaction((tx) =>
				approveDraftDoneWhen(tx, { objectId: job.id, actorId: person, cardEventId }),
			),
		).toBe(true)

		expect(await hasApprovedDoneWhen(db, job.id)).toBe(true)
		expect(await getDoneWhen(db, job.id)).toMatchObject({ status: 'approved', approved_by: person })
		const [goAhead] = await db.select().from(jobGoAheads).where(eq(jobGoAheads.objectId, job.id))
		expect(goAhead).toMatchObject({ via: 'card', grantedBy: person })
	})

	it('an agent can never approve', async () => {
		const { workspace, agent, job } = await setup()
		const cardEventId = await draft(workspace.id, job.id, agent.id)
		await expect(
			db.transaction((tx) =>
				approveDraftDoneWhen(tx, { objectId: job.id, actorId: agent.id, cardEventId }),
			),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })
		expect(await hasApprovedDoneWhen(db, job.id)).toBe(false)
	})

	it('a tap on a card the agent has since replaced approves nothing', async () => {
		const { person, workspace, agent, job } = await setup()
		const cardA = await draft(workspace.id, job.id, agent.id)
		const reposted = {
			lines: [{ text: 'A different line the person never saw', checked_by: 'person' as const }],
		}
		const cardB = await draft(workspace.id, job.id, agent.id, reposted)

		await expect(
			db.transaction((tx) =>
				approveDraftDoneWhen(tx, { objectId: job.id, actorId: person, cardEventId: cardA }),
			),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' })
		expect(await hasApprovedDoneWhen(db, job.id)).toBe(false)
		expect(
			await db.select().from(jobGoAheads).where(eq(jobGoAheads.objectId, job.id)),
		).toHaveLength(0)

		// The newer card still approves, and only its own text.
		expect(
			await db.transaction((tx) =>
				approveDraftDoneWhen(tx, { objectId: job.id, actorId: person, cardEventId: cardB }),
			),
		).toBe(true)
		const list = await getDoneWhen(db, job.id)
		expect(list).toMatchObject({ status: 'approved', total: 1 })
		expect(list?.lines.map((l) => l.text)).toEqual(['A different line the person never saw'])
	})

	it('the same card tapped twice approves once and does not fail', async () => {
		const { person, workspace, agent, job } = await setup()
		const cardEventId = await draft(workspace.id, job.id, agent.id)
		const approve = () =>
			db.transaction((tx) =>
				approveDraftDoneWhen(tx, { objectId: job.id, actorId: person, cardEventId }),
			)
		expect(await approve()).toBe(true)
		expect(await approve()).toBe(false)
	})

	it('an agent cannot replace a list once it is approved, even past the route check', async () => {
		const { person, workspace, agent, job } = await setup()
		const cardEventId = await draft(workspace.id, job.id, agent.id)
		await db.transaction((tx) =>
			approveDraftDoneWhen(tx, { objectId: job.id, actorId: person, cardEventId }),
		)
		await expect(draft(workspace.id, job.id, agent.id)).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		expect(await getDoneWhen(db, job.id)).toMatchObject({ status: 'approved', total: 2 })
	})

	it('reads a tap only from the option with approve_done_when on a card with a list', async () => {
		const { workspace, agent, job } = await setup()
		const decision: CommentDecision = {
			title: 'Is this the list?',
			summary: 'Two lines are drafted. Approval is open.',
			options: [
				{
					label: 'Approve',
					recommended: true,
					approve_done_when: true,
					consequences: ['Starts', 'Asks'],
				},
				{ label: 'Hold', consequences: ['Waits', 'Stays a draft'] },
			],
			done_when: BLOCK,
		}
		const [card] = await db
			.insert(events)
			.values({
				workspaceId: workspace.id,
				actorId: agent.id,
				entityType: 'object',
				entityId: job.id,
				action: 'commented',
				data: { content: 'List ready', decision },
			})
			.returning()
		if (!card) throw new Error('no card')
		const tap = (content: string) =>
			resolveDoneWhenTap(db, {
				workspaceId: workspace.id,
				entityId: job.id,
				parentEventId: Number(card.id),
				content,
			})
		expect(await tap('Approve')).toEqual({ objectId: job.id, cardEventId: Number(card.id) })
		expect(await tap('Hold')).toBeNull()
		expect(await tap('approve everything')).toBeNull()
	})
})

describe('ticking a line', () => {
	async function approved() {
		const ctx = await setup()
		const cardEventId = await draft(ctx.workspace.id, ctx.job.id, ctx.agent.id)
		await db.transaction((tx) =>
			approveDraftDoneWhen(tx, { objectId: ctx.job.id, actorId: ctx.person, cardEventId }),
		)
		const [line] = await db
			.select()
			.from(doneWhenLines)
			.where(eq(doneWhenLines.objectId, ctx.job.id))
		if (!line) throw new Error('no line')
		return { ...ctx, line }
	}

	it('lets a person set a line and counts it', async () => {
		const { person, job, line } = await approved()
		const res = await appAs(person, 'human').request(
			jsonRequest('PATCH', `/api/objects/${job.id}/done-when/lines/${line.id}`, { state: 'true' }),
		)
		expect(res.status).toBe(200)
		expect(await res.json()).toMatchObject({ true_count: 1, total: 2 })
	})

	it('refuses an agent', async () => {
		const { agent, job, line } = await approved()
		const res = await appAs(agent.id, 'agent').request(
			jsonRequest('PATCH', `/api/objects/${job.id}/done-when/lines/${line.id}`, { state: 'true' }),
		)
		expect(res.status).toBe(403)
		const [after] = await db.select().from(doneWhenLines).where(eq(doneWhenLines.id, line.id))
		expect(after?.state).toBe('not_checked')
	})

	it('refuses a tick on a draft list', async () => {
		const { person, workspace, agent, job } = await setup()
		await draft(workspace.id, job.id, agent.id)
		const [line] = await db.select().from(doneWhenLines).where(eq(doneWhenLines.objectId, job.id))
		const res = await appAs(person, 'human').request(
			jsonRequest('PATCH', `/api/objects/${job.id}/done-when/lines/${line?.id}`, { state: 'true' }),
		)
		expect(res.status).toBe(400)
	})
})

describe('skipping the list', () => {
	const skip = (as: { id: string; type: string }, jobId: string) =>
		appAs(as.id, as.type).request(
			jsonRequest('POST', `/api/objects/${jobId}/done-when/skip`, {
				reason: 'One session finishes it and nothing is sent',
			}),
		)

	it('records a skip on a plain job and logs it', async () => {
		const { agent, job } = await setup()
		const res = await skip({ id: agent.id, type: 'agent' }, job.id)
		expect(res.status).toBe(200)
		const rows = await db.select().from(doneWhenSkips).where(eq(doneWhenSkips.objectId, job.id))
		expect(rows).toHaveLength(1)
		const logged = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, job.id), eq(events.action, 'done_when_skipped')))
		expect(logged).toHaveLength(1)
	})

	it('refuses a skip on a bet, and counts the refusal', async () => {
		const { agent, job } = await setup('bet')
		const res = await skip({ id: agent.id, type: 'agent' }, job.id)
		expect(res.status).toBe(403)
		expect(
			await db.select().from(doneWhenSkips).where(eq(doneWhenSkips.objectId, job.id)),
		).toHaveLength(0)
		const refused = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, job.id), eq(events.action, 'done_when_skip_refused')))
		expect(refused).toHaveLength(1)
	})

	it('refuses a skip on a job that already has a list', async () => {
		const { workspace, agent, job } = await setup()
		await draft(workspace.id, job.id, agent.id)
		const res = await skip({ id: agent.id, type: 'agent' }, job.id)
		expect(res.status).toBe(400)
	})
})
