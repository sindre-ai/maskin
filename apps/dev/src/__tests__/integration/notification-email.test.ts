/**
 * Email for each kind of notification against real Postgres: who gets one, what it holds, the
 * push rules reused for how often (rollup, per-hour cap), muted workspaces, the killswitch, two
 * replicas on one notification, a failed send, and the kind-only stop. Mail is captured, never sent.
 */
import { EventEmitter } from 'node:events'
import { notificationPreferences, notifications } from '@maskin/db/schema'
import { FOR_YOU_KIND } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

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
import { NotificationEmailFanout } from '../../services/notification-email'
import { insertActor, insertNotification, insertObject, insertWorkspace } from '../factories'
import { db } from './global-setup'

const ENV = { RESEND_API_KEY: 're_test', APP_URL: 'https://maskin.test', NODE_ENV: 'test' }

const fanout = (env: NodeJS.ProcessEnv = ENV) =>
	new NotificationEmailFanout(db, new EventEmitter() as never, env)

async function world() {
	const person = await insertActor(db, { type: 'human' })
	const personId = person.id as string
	const ws = await insertWorkspace(db, personId)
	const workspaceId = ws?.id as string
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
	const card = await insertObject(db, workspaceId, personId, { type: 'task', title: 'Pick a plan' })
	return {
		person,
		personId,
		workspaceId,
		agentId: agent.id as string,
		objectId: card?.id as string,
	}
}

type World = Awaited<ReturnType<typeof world>>

async function notify(w: World, overrides: Record<string, unknown> = {}) {
	const row = await insertNotification(db, w.workspaceId, w.agentId, {
		targetActorId: w.personId,
		objectId: w.objectId,
		title: 'Approve the plan',
		content: 'The agent needs a yes before it can start.',
		...overrides,
	})
	return { id: row?.id as string }
}

const event = (w: World, id: string) => ({
	workspace_id: w.workspaceId,
	actor_id: w.agentId,
	action: 'created',
	entity_type: 'notification',
	entity_id: id,
	event_id: '1',
})

async function optIn(
	w: World,
	emailCategories: Record<string, boolean>,
	prefs: Partial<typeof notificationPreferences.$inferInsert> = {},
) {
	await db
		.insert(notificationPreferences)
		.values({ actorId: w.personId, emailCategories, ...prefs })
}

const mails = (w: World) => sendEmail.mock.calls.filter(([m]) => m.to === w.person.email)

beforeEach(() => {
	sendEmail.mockReset()
	sendEmail.mockResolvedValue(true)
})

describe('notification email: who gets it', () => {
	it('an opted-in kind sends one email with the notification text, a button to the card and a kind-only stop link', async () => {
		const w = await world()
		await optIn(w, { needs_you: true })
		const n = await notify(w)

		await fanout().handleEvent(event(w, n.id))

		const sent = mails(w)
		expect(sent).toHaveLength(1)
		const mail = sent[0]?.[0]
		expect(mail.subject).toBe('Approve the plan')
		expect(mail.text).toContain('The agent needs a yes before it can start.')
		expect(mail.text).toContain(
			`https://maskin.test/${w.workspaceId}/objects/${w.objectId}?surface=email&block=needs_you`,
		)
		expect(mail.text).toContain('k=needs_you')
		expect(mail.headers['List-Unsubscribe']).toContain('k=needs_you')
		expect(mail.headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click')
	})

	it('a kind that is off, or a person with no settings row, gets nothing', async () => {
		const w = await world()
		const noRow = await world()
		await optIn(w, { needs_you: false, conversation: true })
		const n = await notify(w)
		const other = await notify(noRow)

		await fanout().handleEvent(event(w, n.id))
		await fanout().handleEvent(event(noRow, other.id))

		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('Tips email arrives for a person who switched it on, although push holds tips back', async () => {
		const w = await world()
		await optIn(w, { tips: true })
		const n = await notify(w, { type: 'good_news', metadata: { push_category: 'tips' } })

		await fanout().handleEvent(event(w, n.id))

		expect(mails(w)).toHaveLength(1)
	})

	it('digests and flow activity are not sent from here, even with everything on', async () => {
		const w = await world()
		await optIn(w, { needs_you: true, conversation: true, tips: true, flow_activity: true })
		const digest = await notify(w, { type: 'good_news' })
		const flow = await notify(w, {
			type: 'good_news',
			metadata: { push_category: 'flow_activity' },
		})

		await fanout().handleEvent(event(w, digest.id))
		await fanout().handleEvent(event(w, flow.id))

		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('a notification the person caused themselves sends nothing', async () => {
		const w = await world()
		await optIn(w, { needs_you: true })
		const own = await insertNotification(db, w.workspaceId, w.personId, {
			targetActorId: w.personId,
		})

		await fanout().handleEvent(event(w, own?.id as string))

		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('a muted workspace sends nothing, Needs you included', async () => {
		const w = await world()
		await optIn(w, { needs_you: true }, { mutedWorkspaceIds: [w.workspaceId] })
		const n = await notify(w)

		await fanout().handleEvent(event(w, n.id))

		expect(sendEmail).not.toHaveBeenCalled()
	})

	it('FEATURE_BRIEFING_EMAIL=0 stops these emails too', async () => {
		const w = await world()
		await optIn(w, { needs_you: true })
		const n = await notify(w)

		await fanout({ ...ENV, FEATURE_BRIEFING_EMAIL: '0' }).handleEvent(event(w, n.id))

		expect(sendEmail).not.toHaveBeenCalled()
	})
})

describe('notification email: how often', () => {
	it('three For You cards in ten minutes become one "3 things need you" email, and a fourth adds none', async () => {
		const w = await world()
		await optIn(w, { needs_you: true })
		const instance = fanout()
		for (let i = 0; i < 4; i++) {
			const card = await insertObject(db, w.workspaceId, w.personId, { type: 'task' })
			const n = await notify(w, { objectId: card?.id, metadata: { kind: FOR_YOU_KIND } })
			await instance.handleEvent(event(w, n.id))
		}

		const subjects = mails(w).map(([m]) => m.subject)
		expect(subjects).toHaveLength(3)
		expect(subjects[2]).toBe('3 things need you')
	})

	it('chat replies are capped at six an hour', async () => {
		const w = await world()
		await optIn(w, { conversation: true })
		const instance = fanout()
		for (let i = 0; i < 8; i++) {
			const n = await notify(w, {
				type: 'good_news',
				metadata: { push_category: 'conversation', push_collapse_key: `chat:${i}` },
			})
			await instance.handleEvent(event(w, n.id))
		}

		expect(mails(w)).toHaveLength(6)
	})

	it('two replicas handling the same notification send one email', async () => {
		const w = await world()
		await optIn(w, { needs_you: true })
		const n = await notify(w)

		await Promise.all([fanout().handleEvent(event(w, n.id)), fanout().handleEvent(event(w, n.id))])

		expect(mails(w)).toHaveLength(1)
	})

	it('a failed send releases the claim so a retry can send', async () => {
		const w = await world()
		await optIn(w, { needs_you: true })
		const n = await notify(w)
		sendEmail.mockRejectedValueOnce(new Error('provider down'))

		await fanout().handleEvent(event(w, n.id))
		const [after] = await db.select().from(notifications).where(eq(notifications.id, n.id))
		expect((after?.metadata as Record<string, unknown> | null)?.email_claimed_at).toBeUndefined()

		await fanout().handleEvent(event(w, n.id))
		expect(mails(w)).toHaveLength(2)
	})
})

describe('notification email: the stop', () => {
	it('switching one kind off stops those emails and leaves the other kinds and the summary alone', async () => {
		const w = await world()
		await optIn(w, { needs_you: true, conversation: true }, { emailDigestEnabled: true })

		expect(await switchEmailKindOff(db, w.personId, 'needs_you')).toBe(true)

		const needs = await notify(w)
		const chat = await notify(w, { type: 'good_news', metadata: { push_category: 'conversation' } })
		await fanout().handleEvent(event(w, needs.id))
		await fanout().handleEvent(event(w, chat.id))

		expect(mails(w)).toHaveLength(1)
		const [prefs] = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, w.personId))
		expect(prefs?.emailDigestEnabled).toBe(true)
		expect(prefs?.emailCategories).toEqual({ needs_you: false, conversation: true })
	})
})
