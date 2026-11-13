/**
 * Flow activity against real Postgres: who is told when a flow finishes a run, the push row, the
 * one-email-per-person-per-flow-per-hour grouping, the runs that send nothing (chat turn, failed
 * run, no flow), a muted workspace, the killswitch, and the stop link that switches off Flow
 * activity email only. Mail is captured, never sent.
 */
import { EventEmitter } from 'node:events'
import {
	notificationPreferences,
	notifications,
	relationships,
	sessions,
	workspaceMembers,
} from '@maskin/db/schema'
import { EmailSendError } from '@maskin/email'
import { and, eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmail = vi.fn()

vi.mock('@maskin/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maskin/email')>()),
	sendEmail: (...args: unknown[]) => sendEmail(...args),
}))
vi.mock('../../lib/email-stop-link', () => ({
	buildEmailStopUrl: (actorId: string, _env: unknown, kind?: string) =>
		`https://maskin.test/email/stop?a=${actorId}&k=${kind ?? 'summary'}`,
}))

import { switchEmailKindOff } from '../../services/email-preferences'
import { FLOW_EMAIL_WINDOW_MS, FlowActivityNotifier } from '../../services/flow-activity'
import {
	insertActor,
	insertObject,
	insertSession,
	insertTrigger,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

const START = new Date('2026-03-10T10:00:00Z').getTime()
const MIN = 60_000
const ENV = { RESEND_API_KEY: 're_test', APP_URL: 'https://maskin.test', NODE_ENV: 'test' }

let clock = START
const notifier = (env: NodeJS.ProcessEnv = ENV) =>
	new FlowActivityNotifier(db, new EventEmitter() as never, env, () => clock)

async function world() {
	const owner = await insertActor(db, { type: 'human' })
	const ownerId = owner.id as string
	const ws = await insertWorkspace(db, ownerId)
	const workspaceId = ws?.id as string
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
	const flow = await insertObject(db, workspaceId, ownerId, {
		type: 'loop',
		title: 'Weekly research',
	})
	return { owner, ownerId, workspaceId, agentId: agent.id as string, flowId: flow?.id as string }
}

type World = Awaited<ReturnType<typeof world>>

/** A finished run that sits in the flow through the item it worked on (the in_loop link). */
async function finishedRun(w: World, opts: { title?: string; at?: number; flowId?: string } = {}) {
	const item = await insertObject(db, w.workspaceId, w.ownerId, {
		type: 'task',
		title: opts.title ?? 'Competitor update',
	})
	await db.insert(relationships).values({
		sourceType: 'object',
		sourceId: opts.flowId ?? w.flowId,
		targetType: 'object',
		targetId: item?.id as string,
		type: 'in_loop',
		createdBy: w.ownerId,
	})
	const run = await insertSession(db, w.workspaceId, w.agentId, w.ownerId, {
		status: 'completed',
		initiatedFromObjectId: item?.id,
		completedAt: new Date(opts.at ?? clock),
	})
	return run?.id as string
}

const event = (w: World, sessionId: string) => ({
	workspace_id: w.workspaceId,
	actor_id: w.agentId,
	action: 'session_completed',
	entity_type: 'session',
	entity_id: sessionId,
	event_id: '1',
})

async function optIn(
	actorId: string,
	prefs: Partial<typeof notificationPreferences.$inferInsert> = {},
) {
	await db
		.insert(notificationPreferences)
		.values({ actorId, emailCategories: { flow_activity: true }, ...prefs })
}

const mails = (email: string) => sendEmail.mock.calls.filter(([m]) => m.to === email)
const pushRows = (actorId: string) =>
	db
		.select()
		.from(notifications)
		.where(and(eq(notifications.targetActorId, actorId), eq(notifications.type, 'good_news')))

beforeEach(() => {
	clock = START
	sendEmail.mockReset()
	sendEmail.mockResolvedValue(true)
})

describe('flow activity email: who gets it', () => {
	it('an opted-in person gets one email naming the flow, with a button and a flow-only stop link', async () => {
		const w = await world()
		await optIn(w.ownerId)
		const run = await finishedRun(w)

		await notifier().handleEvent(event(w, run))

		const sent = mails(w.owner.email as string)
		expect(sent).toHaveLength(1)
		const mail = sent[0]?.[0]
		expect(mail.subject).toBe('Weekly research: 1 run finished')
		expect(mail.text).toContain("Researcher finished 'Competitor update'")
		expect(mail.text).toContain(`${ENV.APP_URL}/${w.workspaceId}/loops/${w.flowId}?surface=email`)
		expect(mail.text).toContain('k=flow_activity')
		expect(mail.headers['List-Unsubscribe']).toContain('k=flow_activity')
		expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
	})

	it('a person who did not opt in gets nothing, with or without a settings row', async () => {
		const w = await world()
		const noRow = await insertActor(db, { type: 'human' })
		await db
			.insert(notificationPreferences)
			.values({ actorId: w.ownerId, emailCategories: { flow_activity: false } })
		const run = await finishedRun(w)
		await insertSession(db, w.workspaceId, w.agentId, w.ownerId, { status: 'completed' })

		await notifier().handleEvent(event(w, run))

		expect(sendEmail).not.toHaveBeenCalled()
		expect(await pushRows(w.ownerId)).toHaveLength(0)
		expect(await pushRows(noRow.id as string)).toHaveLength(0)
	})

	it('a workspace the person muted sends nothing', async () => {
		const w = await world()
		await optIn(w.ownerId, {
			categories: { flow_activity: true },
			mutedWorkspaceIds: [w.workspaceId],
		})
		const run = await finishedRun(w)

		await notifier().handleEvent(event(w, run))

		expect(sendEmail).not.toHaveBeenCalled()
		expect(await pushRows(w.ownerId)).toHaveLength(0)
	})

	it('a run that ties to no flow, a chat turn and a failed run send nothing', async () => {
		const w = await world()
		await optIn(w.ownerId, { categories: { flow_activity: true } })
		const item = await insertObject(db, w.workspaceId, w.ownerId, { type: 'task' })
		const noFlow = await insertSession(db, w.workspaceId, w.agentId, w.ownerId, {
			status: 'completed',
			initiatedFromObjectId: item?.id,
			completedAt: new Date(clock),
		})
		const chat = await finishedRun(w)
		await db.update(sessions).set({ interactive: true }).where(eq(sessions.id, chat))
		const failed = await insertSession(db, w.workspaceId, w.agentId, w.ownerId, {
			status: 'failed',
			completedAt: new Date(clock),
		})

		for (const id of [noFlow?.id as string, chat, failed?.id as string]) {
			await notifier().handleEvent(event(w, id))
		}

		expect(sendEmail).not.toHaveBeenCalled()
		expect(await pushRows(w.ownerId)).toHaveLength(0)
	})

	it('finds the flow through the trigger the run came from', async () => {
		const w = await world()
		await optIn(w.ownerId)
		const trigger = await insertTrigger(db, w.workspaceId, w.ownerId, w.agentId)
		const triggered = await insertObject(db, w.workspaceId, w.ownerId, {
			type: 'loop',
			title: 'Triggered flow',
			metadata: { trigger_ids: [trigger?.id] },
		})
		const run = await insertSession(db, w.workspaceId, w.agentId, w.ownerId, {
			status: 'completed',
			triggerId: trigger?.id,
			completedAt: new Date(clock),
		})

		await notifier().handleEvent(event(w, run?.id as string))

		expect(mails(w.owner.email as string)[0]?.[0].subject).toBe('Triggered flow: 1 run finished')
		expect(triggered?.id).toBeTruthy()
	})
})

describe('flow activity email: one per person per flow per hour', () => {
	it('holds runs inside the hour and sends them together when it is up', async () => {
		const w = await world()
		await optIn(w.ownerId)
		const n = notifier()

		const first = await finishedRun(w, { title: 'First' })
		await n.handleEvent(event(w, first))
		expect(mails(w.owner.email as string)).toHaveLength(1)

		clock = START + 10 * MIN
		const second = await finishedRun(w, { title: 'Second' })
		await n.handleEvent(event(w, second))
		clock = START + 20 * MIN
		const third = await finishedRun(w, { title: 'Third' })
		await n.handleEvent(event(w, third))
		expect(mails(w.owner.email as string)).toHaveLength(1)

		// The hour is up: what the timer does.
		clock = START + FLOW_EMAIL_WINDOW_MS + MIN
		const sent = await n.sendOrHold(
			w.workspaceId,
			{ id: w.flowId, title: 'Weekly research' },
			w.ownerId,
			w.owner.email as string,
			null,
		)
		n.stop()

		expect(sent).toBe(true)
		const all = mails(w.owner.email as string)
		expect(all).toHaveLength(2)
		const grouped = all[1]?.[0]
		expect(grouped.subject).toBe('Weekly research: 2 runs finished')
		expect(grouped.text).toContain("'Second'")
		expect(grouped.text).toContain("'Third'")
		expect(grouped.text).not.toContain("'First'")
	})

	it('two ticks at once send once', async () => {
		const w = await world()
		await optIn(w.ownerId)
		const run = await finishedRun(w)

		await Promise.all([
			notifier().handleEvent(event(w, run)),
			notifier().handleEvent(event(w, run)),
		])

		expect(mails(w.owner.email as string)).toHaveLength(1)
	})

	it('another flow has its own hour', async () => {
		const w = await world()
		await optIn(w.ownerId)
		const other = await insertObject(db, w.workspaceId, w.ownerId, {
			type: 'loop',
			title: 'Daily triage',
		})
		const n = notifier()
		await n.handleEvent(event(w, await finishedRun(w)))
		clock = START + 5 * MIN
		await n.handleEvent(event(w, await finishedRun(w, { flowId: other?.id as string })))

		expect(mails(w.owner.email as string).map(([m]) => m.subject)).toEqual([
			'Weekly research: 1 run finished',
			'Daily triage: 1 run finished',
		])
	})

	it('a failed send gives the hour back, and so does a dev copy with no Resend key', async () => {
		const w = await world()
		await optIn(w.ownerId)
		sendEmail.mockRejectedValueOnce(new EmailSendError('rate_limit_exceeded', 'slow down'))
		await notifier().handleEvent(event(w, await finishedRun(w)))
		sendEmail.mockResolvedValueOnce(false)
		await notifier().handleEvent(event(w, await finishedRun(w)))

		const [row] = await db
			.select({ sent: notificationPreferences.flowEmailSent })
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, w.ownerId))
		expect(row?.sent?.[w.flowId]).toBeUndefined()

		await notifier().handleEvent(event(w, await finishedRun(w)))
		expect(sendEmail).toHaveBeenCalledTimes(3)
		expect(mails(w.owner.email as string)).toHaveLength(3)
	})

	it('production without a Resend key, or the killswitch at 0, sends nothing', async () => {
		const w = await world()
		await optIn(w.ownerId)
		await notifier({ NODE_ENV: 'production', APP_URL: 'https://maskin.test' }).handleEvent(
			event(w, await finishedRun(w)),
		)
		await notifier({ ...ENV, FEATURE_BRIEFING_EMAIL: '0' }).handleEvent(
			event(w, await finishedRun(w)),
		)
		expect(sendEmail).not.toHaveBeenCalled()
	})

	describe('in production the switch must be exactly 1', () => {
		const PROD = { ...ENV, NODE_ENV: 'production' }
		beforeEach(() => {
			vi.stubEnv('EMAIL_STOP_LINK_SECRET', 'x'.repeat(32))
		})
		afterEach(() => {
			vi.unstubAllEnvs()
		})

		it.each([
			['unset', undefined],
			['empty', ''],
			['0', '0'],
		])('sends nothing when FEATURE_BRIEFING_EMAIL is %s', async (_label, value) => {
			const w = await world()
			await optIn(w.ownerId)

			await notifier({ ...PROD, FEATURE_BRIEFING_EMAIL: value }).handleEvent(
				event(w, await finishedRun(w)),
			)

			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('sends when FEATURE_BRIEFING_EMAIL is 1', async () => {
			const w = await world()
			await optIn(w.ownerId)

			await notifier({ ...PROD, FEATURE_BRIEFING_EMAIL: '1' }).handleEvent(
				event(w, await finishedRun(w)),
			)

			expect(mails(w.owner.email as string)).toHaveLength(1)
		})
	})
})

describe('flow activity push and browser', () => {
	it('writes a push-only notification for a person with Push on, and none for email-only', async () => {
		const w = await world()
		await optIn(w.ownerId, { categories: { flow_activity: true }, emailCategories: null })
		const emailOnly = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: w.workspaceId, actorId: emailOnly.id as string, role: 'member' })
		await optIn(emailOnly.id as string)

		await notifier().handleEvent(event(w, await finishedRun(w)))

		const rows = await pushRows(w.ownerId)
		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({
			title: 'Weekly research',
			status: 'seen',
			objectId: w.flowId,
			metadata: expect.objectContaining({
				push_category: 'flow_activity',
				push_only: true,
				push_collapse_key: `flow:${w.flowId}`,
			}),
		})
		expect(await pushRows(emailOnly.id as string)).toHaveLength(0)
		expect(mails(emailOnly.email as string)).toHaveLength(1)
	})

	it('Browser alone is enough for the push row; the fan-out sends only to the browser', async () => {
		const w = await world()
		await optIn(w.ownerId, {
			categories: { flow_activity: false },
			browserCategories: { flow_activity: true },
			emailCategories: null,
		})

		await notifier().handleEvent(event(w, await finishedRun(w)))

		expect(await pushRows(w.ownerId)).toHaveLength(1)
	})
})

describe('flow activity stop link', () => {
	it('switches off Flow activity email and leaves the summary and Flow activity push alone', async () => {
		const w = await world()
		await optIn(w.ownerId, { emailDigestEnabled: true, categories: { flow_activity: true } })

		expect(await switchEmailKindOff(db, w.ownerId, 'flow_activity')).toBe(true)
		expect(await switchEmailKindOff(db, w.ownerId, 'flow_activity')).toBe(false)

		const [row] = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, w.ownerId))
		expect(row?.emailCategories).toEqual({ flow_activity: false })
		expect(row?.emailDigestEnabled).toBe(true)
		expect(row?.categories).toMatchObject({ flow_activity: true })

		await notifier().handleEvent(event(w, await finishedRun(w)))
		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('creates the settings row for someone who has none', async () => {
		const w = await world()
		await switchEmailKindOff(db, w.ownerId, 'flow_activity')
		const [row] = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, w.ownerId))
		expect(row?.emailCategories).toEqual({ flow_activity: false })
		expect(row?.emailDigestEnabled).toBeNull()
	})
})
