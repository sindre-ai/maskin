import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { events, doneWhenLines, jobOutcomes, objects, outcomeChecks } from '@maskin/db/schema'
import type { PgNotifyBridge } from '@maskin/realtime'
import { and, eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { createApiError, formatZodError } from '../../lib/errors'
import { applyObjectUpdate } from '../../lib/object-update'
import {
	OutcomeCheckRequiredError,
	acceptOutcome,
	blindSampleAgreement,
	endOutcomeByPerson,
	getOutcomeState,
	recordBlindMarks,
	runOutcomeCheck,
} from '../../lib/outcome-check'
import type { OutcomeChecker } from '../../lib/outcome-checker'
import { recordReading } from '../../lib/readings'
import { recordSendOutcome } from '../../lib/send-closure'
import { ensureWorkspaceMember, insertActor, insertObject, insertWorkspace } from '../factories'
import { jsonRequest } from '../helpers'
import { db, getTestActorId } from './global-setup'

const { default: objectsRoutes } = await import('../../routes/objects')
const { default: outcomeRoutes } = await import('../../routes/object-outcome')

/**
 * The outcome check, against real Postgres: an agent's close of a job with an approved done-when
 * list is held and marked line by line, a person's own write is not, round 4 never starts, a stale
 * reading is "cannot tell", and the ending and a person's acceptance are two separate things.
 */

type Env = {
	Variables: { db: Database; actorId: string; actorType: string; notifyBridge: PgNotifyBridge }
}

function appAs(actorId: string, actorType: 'human' | 'agent') {
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
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})
	app.route('/api/objects', outcomeRoutes as never)
	app.route('/api/objects', objectsRoutes)
	return app
}

type LineSeed = {
	text: string
	checkedBy: 'code' | 'checker' | 'person'
	reading?: string
	comparison?: string
}

async function setup(lines: LineSeed[], type = 'task') {
	const person = getTestActorId()
	const workspace = await insertWorkspace(db, person)
	const agent = await insertActor(db, { type: 'agent', name: 'Prospector' })
	await ensureWorkspaceMember(db, workspace.id, agent.id)
	const job = await insertObject(db, workspace.id, person, {
		type,
		status: 'in_review',
		driver: agent.id,
		title: 'Outreach report',
		content: 'Ten emails were sent and logged.',
	})
	const rows = await db
		.insert(doneWhenLines)
		.values(
			lines.map((line, index) => ({
				workspaceId: workspace.id,
				objectId: job.id,
				position: index,
				text: line.text,
				checkedBy: line.checkedBy,
				reading: line.reading ?? null,
				comparison: line.comparison ?? null,
				listStatus: 'approved',
				approvedBy: person,
				approvedAt: new Date(),
				createdBy: agent.id,
			})),
		)
		.returning()
	return { person, workspace, agent, job, lines: rows }
}

/** A checker that marks by the text of the line, never by anything the agent says. */
const checkerSaying =
	(marks: Record<string, 'yes' | 'no' | 'cannot_tell'>): OutcomeChecker =>
	async ({ lines }) => ({
		model: 'test-model',
		verdicts: new Map(
			lines.map((l) => [l.id, { mark: marks[l.text] ?? 'cannot_tell', reason: 'test' }]),
		),
	})

async function statusOf(id: string) {
	const [row] = await db.select({ status: objects.status }).from(objects).where(eq(objects.id, id))
	return row?.status
}

describe('an agent closing a job with an approved list', () => {
	it('is held when a line waits for a person, and the job stays where it is', async () => {
		const { agent, job } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])

		const res = await appAs(agent.id, 'agent').request(
			jsonRequest('PATCH', `/api/objects/${job.id}`, { status: 'done' }),
		)

		expect(res.status).toBe(409)
		expect(await statusOf(job.id)).toBe('in_review')
		const state = await getOutcomeState(db, job.id)
		expect(state.rounds).toHaveLength(1)
		// A round that only waits for a person has no number and uses up none of the three.
		expect(state.rounds[0]).toMatchObject({ kind: 'round', round: null, ending: null })
		expect(state.rounds[0]?.marks[0]).toMatchObject({ mark: 'cannot_tell', by: 'person' })
		expect(state.ending).toBeNull()
	})

	it('closes once a person has ticked the line, stores checks_passed and leaves acceptance empty', async () => {
		const { person, agent, job, lines } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])
		await db
			.update(doneWhenLines)
			.set({ state: 'true', stateSetBy: person, stateSetAt: new Date() })
			.where(eq(doneWhenLines.id, lines[0]?.id as string))

		const res = await appAs(agent.id, 'agent').request(
			jsonRequest('PATCH', `/api/objects/${job.id}`, { status: 'done' }),
		)

		expect(res.status).toBe(200)
		expect(await statusOf(job.id)).toBe('done')
		const state = await getOutcomeState(db, job.id)
		expect(state.ending).toBe('checks_passed')
		expect(state.accepted_by).toBeNull()
		expect(state.rounds[0]?.marks[0]).toMatchObject({ mark: 'yes', by: 'person' })
	})

	it('does not hold a person closing the same job', async () => {
		const { person, job } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])

		const res = await appAs(person, 'human').request(
			jsonRequest('PATCH', `/api/objects/${job.id}`, { status: 'done' }),
		)

		expect(res.status).toBe(200)
		expect(await statusOf(job.id)).toBe('done')
		expect((await getOutcomeState(db, job.id)).rounds).toHaveLength(0)
	})

	it('does not hold a move that is not a gated close', async () => {
		const { agent, job } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])

		const res = await appAs(agent.id, 'agent').request(
			jsonRequest('PATCH', `/api/objects/${job.id}`, { status: 'in_progress' }),
		)

		expect(res.status).toBe(200)
		expect((await getOutcomeState(db, job.id)).rounds).toHaveLength(0)
	})

	it('does not hold a job with no approved list', async () => {
		const { agent, workspace, person } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])
		const other = await insertObject(db, workspace.id, person, {
			type: 'task',
			status: 'in_review',
			driver: agent.id,
		})

		const res = await appAs(agent.id, 'agent').request(
			jsonRequest('PATCH', `/api/objects/${other.id}`, { status: 'done' }),
		)

		expect(res.status).toBe(200)
		expect(await statusOf(other.id)).toBe('done')
	})
})

describe('the hold point refuses a close that skipped the check', () => {
	it('throws when the write is asked for by an agent with no passed round', async () => {
		const { agent, job } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])

		await expect(
			db.transaction((tx) =>
				applyObjectUpdate(tx, {
					id: job.id,
					actorId: agent.id,
					actorType: 'agent',
					body: { status: 'done' },
				}),
			),
		).rejects.toBeInstanceOf(OutcomeCheckRequiredError)
		expect(await statusOf(job.id)).toBe('in_review')
	})

	it('refuses a passed round that was run for a different status', async () => {
		const { person, agent, job, lines } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])
		await db
			.update(doneWhenLines)
			.set({ state: 'true', stateSetBy: person, stateSetAt: new Date() })
			.where(eq(doneWhenLines.id, lines[0]?.id as string))
		const passed = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'validated',
			actorId: agent.id,
		})
		expect(passed.verdict).toBe('passed')

		await expect(
			db.transaction((tx) =>
				applyObjectUpdate(tx, {
					id: job.id,
					actorId: agent.id,
					actorType: 'agent',
					body: { status: 'done' },
					outcomeCheckId: passed.checkId,
				}),
			),
		).rejects.toBeInstanceOf(OutcomeCheckRequiredError)
	})

	it('answers a bulk close by an agent with a refusal that names the single update', async () => {
		const { agent, workspace, job } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])

		const res = await appAs(agent.id, 'agent').request(
			new Request('http://localhost/api/objects/bulk-update', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'X-Workspace-Id': workspace.id },
				body: JSON.stringify({ ids: [job.id], patch: { status: 'done' } }),
			}),
		)

		const body = (await res.json()) as { results: Array<{ ok: boolean; error?: string }> }
		expect(body.results[0]?.ok).toBe(false)
		expect(body.results[0]?.error).toContain('outcome check')
		expect(await statusOf(job.id)).toBe('in_review')
	})

	it('leaves a job with an approved list open when an agent sends the message it carries', async () => {
		const { agent, workspace, job } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])

		const out = await recordSendOutcome(db, {
			workspaceId: workspace.id,
			actorId: agent.id,
			target: { id: job.id, type: 'task' } as never,
			provider: 'test',
		})

		expect(out.delivered).toBe(true)
		expect(out.task_closed).toBe(false)
		expect(await statusOf(job.id)).toBe('in_review')
	})
})

describe('code lines and readings', () => {
	it('marks a fresh reading that meets the comparison yes, and one that misses it no', async () => {
		const { workspace, agent, job } = await setup([
			{
				text: '3 payments were read',
				checkedBy: 'code',
				reading: 'stripe.payments',
				comparison: '>= 3',
			},
		])
		await recordReading(db, {
			workspaceId: workspace.id,
			subjectId: job.id,
			measure: 'stripe.payments',
			value: 2,
			readAt: new Date(),
			source: 'stripe',
			sourceRef: 'r1',
		})

		const miss = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
		})
		expect(miss.verdict).toBe('sent_back')
		expect(miss.lines[0]).toMatchObject({ mark: 'no', by: 'code' })
		expect(miss.message).toContain('3 payments were read')

		await recordReading(db, {
			workspaceId: workspace.id,
			subjectId: job.id,
			measure: 'stripe.payments',
			value: 4,
			readAt: new Date(),
			source: 'stripe',
			sourceRef: 'r2',
		})
		const hit = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
		})
		expect(hit.verdict).toBe('passed')
		const state = await getOutcomeState(db, job.id)
		expect(state.rounds[1]?.readings[0]).toMatchObject({ measure: 'stripe.payments', value: 4 })
	})

	it('marks a reading older than 30 minutes cannot tell, never yes', async () => {
		const { workspace, agent, job } = await setup([
			{
				text: '3 payments were read',
				checkedBy: 'code',
				reading: 'stripe.payments',
				comparison: '>= 3',
			},
		])
		await recordReading(db, {
			workspaceId: workspace.id,
			subjectId: job.id,
			measure: 'stripe.payments',
			value: 10,
			readAt: new Date(Date.now() - 31 * 60 * 1000),
			source: 'stripe',
			sourceRef: 'old',
		})

		const result = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
		})

		expect(result.verdict).toBe('waiting_for_person')
		expect(result.lines[0]).toMatchObject({ mark: 'cannot_tell', by: 'code' })
	})

	it('marks a code line with no named reading cannot tell, so a number the agent wrote cannot pass it', async () => {
		const { agent, job } = await setup([
			{
				text: '3 payments were read',
				checkedBy: 'code',
				reading: 'three of them',
				comparison: '>= 3',
			},
		])

		const result = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
		})

		expect(result.lines[0]).toMatchObject({ mark: 'cannot_tell', by: 'code' })
	})
})

describe('checker lines', () => {
	it('sends the work back naming the false line, and lets it pass once the thing changes', async () => {
		const { agent, job } = await setup([
			{ text: 'Ten emails are sent', checkedBy: 'checker' },
			{ text: 'A report is filed', checkedBy: 'checker' },
		])

		const first = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: checkerSaying({ 'Ten emails are sent': 'yes', 'A report is filed': 'no' }),
		})
		expect(first.verdict).toBe('sent_back')
		expect(first.message).toContain('A report is filed')
		expect(first.message).not.toContain('Ten emails are sent')
		expect((await getOutcomeState(db, job.id)).ending).toBe('sent_back')

		const second = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: checkerSaying({ 'Ten emails are sent': 'yes', 'A report is filed': 'yes' }),
		})
		expect(second.verdict).toBe('passed')
		expect((await getOutcomeState(db, job.id)).ending).toBe('checks_passed')
	})

	it('writes each line state, and never over a line a person ticked', async () => {
		const { person, agent, job, lines } = await setup([
			{ text: 'Ten emails are sent', checkedBy: 'checker' },
			{ text: 'A report is filed', checkedBy: 'checker' },
		])
		await db
			.update(doneWhenLines)
			.set({ state: 'true', stateSetBy: person, stateSetAt: new Date() })
			.where(eq(doneWhenLines.id, lines[1]?.id as string))

		await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: checkerSaying({ 'Ten emails are sent': 'no', 'A report is filed': 'no' }),
		})

		const rows = await db.select().from(doneWhenLines).where(eq(doneWhenLines.objectId, job.id))
		const byText = new Map(rows.map((r) => [r.text, r]))
		expect(byText.get('Ten emails are sent')).toMatchObject({ state: 'false', stateSetBy: null })
		expect(byText.get('A report is filed')).toMatchObject({ state: 'true', stateSetBy: person })
	})

	it('treats a model that cannot be reached as cannot tell, never yes', async () => {
		const { agent, job } = await setup([{ text: 'Ten emails are sent', checkedBy: 'checker' }])

		const result = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: async ({ lines }) => ({
				model: null,
				verdicts: new Map(lines.map((l) => [l.id, { mark: 'cannot_tell', reason: 'down' }])),
			}),
		})

		expect(result.verdict).toBe('waiting_for_person')
	})
})

describe('the round limit', () => {
	it('starts no fourth round and ends the third with round_limit_reached', async () => {
		const { agent, job } = await setup([{ text: 'A report is filed', checkedBy: 'checker' }])
		const failing = checkerSaying({ 'A report is filed': 'no' })

		const verdicts: string[] = []
		for (let i = 0; i < 3; i++) {
			const r = await runOutcomeCheck(db, {
				object: job as never,
				toStatus: 'done',
				actorId: agent.id,
				checker: failing,
			})
			verdicts.push(r.verdict)
		}
		expect(verdicts).toEqual(['sent_back', 'sent_back', 'round_limit_reached'])
		expect((await getOutcomeState(db, job.id)).ending).toBe('round_limit_reached')

		const fourth = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: failing,
		})
		expect(fourth.verdict).toBe('round_limit_reached')
		expect(fourth.checkId).toBeUndefined()
		const state = await getOutcomeState(db, job.id)
		expect(state.rounds).toHaveLength(3)
		expect(state.rounds.map((r) => r.round)).toEqual([1, 2, 3])
	})

	it('asks the person who approved the list once, with the lines still failing', async () => {
		const { person, workspace, agent, job } = await setup([
			{ text: 'A report is filed', checkedBy: 'checker' },
		])
		const failing = checkerSaying({ 'A report is filed': 'no' })
		for (let i = 0; i < 3; i++) {
			await runOutcomeCheck(db, {
				object: job as never,
				toStatus: 'done',
				actorId: agent.id,
				checker: failing,
			})
		}

		const comments = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, job.id), eq(events.action, 'commented')))
		expect(comments).toHaveLength(1)
		const data = comments[0]?.data as { content: string; mentions: string[] }
		expect(data.mentions).toEqual([person])
		expect(data.content).toContain('A report is filed')
		expect(workspace.id).toBeTruthy()
	})
})

describe('the read-only flag', () => {
	it('flags a session that wrote nothing and asked to close, without changing the verdict', async () => {
		const { person, agent, job, lines } = await setup([
			{ text: 'A person approves the tone', checkedBy: 'person' },
		])
		await db
			.update(doneWhenLines)
			.set({ state: 'true', stateSetBy: person, stateSetAt: new Date() })
			.where(eq(doneWhenLines.id, lines[0]?.id as string))

		const result = await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			sessionId: '00000000-0000-4000-8000-000000000001',
		})

		expect(result.verdict).toBe('passed')
		const state = await getOutcomeState(db, job.id)
		expect(state.rounds[0]?.flags).toEqual(['read_only_run'])
	})
})

describe('endings, acceptance and the blind sample', () => {
	it('keeps acceptance apart from the ending, and only a person sets either', async () => {
		const { person, agent, job } = await setup([{ text: 'A report is filed', checkedBy: 'person' }])

		await expect(acceptOutcome(db, { objectId: job.id, actorId: agent.id })).rejects.toMatchObject({
			code: 'FORBIDDEN',
		})
		await expect(
			endOutcomeByPerson(db, { objectId: job.id, actorId: agent.id, ending: 'stopped_by_person' }),
		).rejects.toMatchObject({ code: 'FORBIDDEN' })

		const ended = await endOutcomeByPerson(db, {
			objectId: job.id,
			actorId: person,
			ending: 'list_does_not_fit',
		})
		expect(ended).toMatchObject({ ending: 'list_does_not_fit', accepted_by: null })

		const accepted = await acceptOutcome(db, { objectId: job.id, actorId: person })
		expect(accepted).toMatchObject({ ending: 'list_does_not_fit', accepted_by: person })
		const [row] = await db.select().from(jobOutcomes).where(eq(jobOutcomes.objectId, job.id))
		expect(row?.ending).toBe('list_does_not_fit')
	})

	it('refuses an agent over the person routes', async () => {
		const { agent, job } = await setup([{ text: 'A report is filed', checkedBy: 'person' }])

		const res = await appAs(agent.id, 'agent').request(
			jsonRequest('POST', `/api/objects/${job.id}/outcome/accept`, {}),
		)

		expect(res.status).toBe(403)
		expect((await getOutcomeState(db, job.id)).accepted_by).toBeNull()
	})

	it('stores a person blind marks next to the rounds and counts agreement with the checker', async () => {
		const { person, agent, job, lines } = await setup([
			{ text: 'Ten emails are sent', checkedBy: 'checker' },
			{ text: 'A report is filed', checkedBy: 'checker' },
		])
		await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: checkerSaying({ 'Ten emails are sent': 'yes', 'A report is filed': 'no' }),
		})

		await recordBlindMarks(db, {
			objectId: job.id,
			actorId: person,
			marks: [
				{ line_id: lines[0]?.id as string, mark: 'yes' },
				{ line_id: lines[1]?.id as string, mark: 'yes' },
			],
		})

		const rows = await db.select().from(outcomeChecks).where(eq(outcomeChecks.objectId, job.id))
		expect(rows.map((r) => r.kind).sort()).toEqual(['blind', 'round'])
		expect(await blindSampleAgreement(db, job.workspaceId)).toEqual({
			pieces: 1,
			lines: 2,
			agreed: 1,
		})
	})

	it('refuses a blind mark for a line that is not on the list', async () => {
		const { person, job } = await setup([{ text: 'A report is filed', checkedBy: 'checker' }])

		await expect(
			recordBlindMarks(db, {
				objectId: job.id,
				actorId: person,
				marks: [{ line_id: '00000000-0000-4000-8000-000000000009', mark: 'yes' }],
			}),
		).rejects.toMatchObject({ code: 'BAD_REQUEST' })
	})
})

describe('the check event', () => {
	it('records the ending, the round and who checked, and no text', async () => {
		const { agent, job } = await setup([{ text: 'A report is filed', checkedBy: 'checker' }])

		await runOutcomeCheck(db, {
			object: job as never,
			toStatus: 'done',
			actorId: agent.id,
			checker: checkerSaying({ 'A report is filed': 'no' }),
		})

		const [event] = await db
			.select()
			.from(events)
			.where(and(eq(events.entityId, job.id), eq(events.action, 'outcome_checked')))
		expect(event?.data).toEqual({
			ending: 'sent_back',
			verdict: 'sent_back',
			round: 1,
			checked_by: ['checker'],
			flagged: false,
		})
	})
})
