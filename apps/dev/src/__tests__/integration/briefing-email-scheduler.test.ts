/**
 * Summary email scheduler against real Postgres: the recipient rule (including the two activity
 * row kinds that do not count), the exactly-once claim, the released claim on a failed send, and
 * the skips (no key in production, killswitch). Mail is captured, never sent.
 */
import { randomUUID } from 'node:crypto'
import {
	events,
	conversationParticipants,
	notificationPreferences,
	workspaceMembers,
} from '@maskin/db/schema'
import { EmailSendError } from '@maskin/email'
import { FOR_YOU_KIND } from '@maskin/shared'
import { eq, sql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmail = vi.fn()
const capturePosthogEvent = vi.fn(async (..._args: unknown[]) => {})

vi.mock('@maskin/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maskin/email')>()),
	sendEmail: (...args: unknown[]) => sendEmail(...args),
}))
vi.mock('../../lib/analytics/posthog', () => ({
	capturePosthogEvent: (...args: unknown[]) => capturePosthogEvent(...args),
}))
vi.mock('../../lib/email-stop-link', () => ({
	buildEmailStopUrl: (actorId: string) => `https://maskin.test/email/stop?a=${actorId}`,
}))

import { buildForYouItems } from '../../lib/for-you-items'
import {
	BriefingEmailScheduler,
	emailRecipientRuleSql,
	selectEmailRecipients,
} from '../../services/briefing-email-scheduler'
import { STEP_LESSON } from '../../services/briefing-email-text'
import { loadDigest } from '../../services/digest-email-data'
import {
	insertActor,
	insertConversation,
	insertNotification,
	insertObject,
	insertWorkspace,
} from '../factories'
import { db } from './global-setup'

const DAY = 24 * 3600_000
// 08:10 UTC: inside the 08:00 UTC window for people with no stored timezone.
const NOW = new Date('2026-03-10T08:10:00Z')
const ENV = { RESEND_API_KEY: 're_test', APP_URL: 'https://maskin.test', NODE_ENV: 'test' }

async function person(opts: { daysOld: number; card?: boolean }) {
	const actor = await insertActor(db, {
		type: 'human',
		createdAt: new Date(NOW.getTime() - opts.daysOld * DAY),
	})
	const actorId = actor.id as string
	const ws = await insertWorkspace(db, actorId)
	const workspaceId = ws?.id as string
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
	await db
		.insert(workspaceMembers)
		.values({ workspaceId, actorId: agent.id as string, role: 'member' })
	if (opts.card !== false) {
		await insertNotification(db, workspaceId, agent.id as string, {
			targetActorId: actorId,
			type: 'needs_input',
			status: 'pending',
			metadata: { kind: FOR_YOU_KIND, rank: 1, headline: 'Approve the launch email' },
		})
	}
	return { actorId, email: actor.email as string, workspaceId }
}

const prefsRow = async (actorId: string) =>
	(
		await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
	)[0]

/** An unread notification for `targetId` about a new object, sent by an agent `hoursAgo` hours before NOW. */
async function unread(
	workspaceId: string,
	targetId: string,
	title: string,
	hoursAgo: number,
	extra: Record<string, unknown> = {},
) {
	const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
	const o = await insertObject(db, workspaceId, targetId, { title })
	return insertNotification(db, workspaceId, agent.id as string, {
		targetActorId: targetId,
		type: 'good_news',
		title: `Bet succeeded: ${title}`,
		status: 'pending',
		objectId: o?.id,
		createdAt: new Date(NOW.getTime() - hoursAgo * 3600_000),
		...extra,
	})
}

async function activity(
	workspaceId: string,
	actorId: string,
	entityType: string,
	action: string,
	at = new Date(NOW.getTime() - 2 * DAY),
) {
	await db
		.insert(events)
		.values({ workspaceId, actorId, action, entityType, entityId: randomUUID(), createdAt: at })
}

const sentTo = (email: string) => sendEmail.mock.calls.filter(([m]) => m.to === email)

beforeEach(() => {
	sendEmail.mockReset()
	capturePosthogEvent.mockClear()
	sendEmail.mockResolvedValue(true)
})

describe('summary email: who gets it', () => {
	it('a saved "on" gets step 1 once their account is a day old, even with two ticks at once', async () => {
		const p = await person({ daysOld: 1 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: p.actorId, emailDigestEnabled: true })

		await Promise.all([
			new BriefingEmailScheduler(db, ENV).tick(NOW),
			new BriefingEmailScheduler(db, ENV).tick(NOW),
		])

		expect(sentTo(p.email)).toHaveLength(1)
		const mail = sentTo(p.email)[0]?.[0]
		expect(mail.subject).toBe('1 needs you')
		expect(mail.headers['List-Unsubscribe']).toContain('/email/stop')
		expect(mail.text).toContain(`${ENV.APP_URL}/${p.workspaceId}?surface=email`)
		expect(await prefsRow(p.actorId)).toMatchObject({
			emailOnboardingStep: 1,
			emailLastSentOn: '2026-03-10',
		})

		// Later the same day, and a restarted instance: nothing more.
		await new BriefingEmailScheduler(db, ENV).tick(new Date('2026-03-10T09:00:00Z'))
		expect(sentTo(p.email)).toHaveLength(1)
	})

	it('sends nothing on sign-up day, and does not use up the step when there is nothing to say', async () => {
		const fresh = await person({ daysOld: 0 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: fresh.actorId, emailDigestEnabled: true })
		const quiet = await person({ daysOld: 3, card: false })
		await db
			.insert(notificationPreferences)
			.values({ actorId: quiet.actorId, emailDigestEnabled: true })

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		expect(sentTo(fresh.email)).toHaveLength(0)
		expect(sentTo(quiet.email)).toHaveLength(0)
		expect(await prefsRow(quiet.actorId)).toMatchObject({
			emailOnboardingStep: 0,
			emailLastSentOn: null,
		})
	})

	it('an empty choice (row or no row) with a real action in 30 days starts at step 1 and gets a row', async () => {
		const noRow = await person({ daysOld: 90 })
		await activity(noRow.workspaceId, noRow.actorId, 'object', 'created')
		const emptyRow = await person({ daysOld: 90 })
		await db.insert(notificationPreferences).values({ actorId: emptyRow.actorId })
		await activity(emptyRow.workspaceId, emptyRow.actorId, 'object', 'updated')

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		for (const p of [noRow, emptyRow]) {
			expect(sentTo(p.email)).toHaveLength(1)
			expect(sentTo(p.email)[0]?.[0].text).toContain(STEP_LESSON[1])
			expect(await prefsRow(p.actorId)).toMatchObject({
				emailDigestEnabled: true,
				emailOnboardingStep: 1,
				emailLastSentOn: '2026-03-10',
			})
		}
		// Same spacing as a new sign-up: step 2 two days later, step 3 four days after that.
		const sends = async (days: number) => {
			await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + days * DAY))
			return sentTo(noRow.email).length
		}
		expect(await sends(1)).toBe(1)
		expect(await sends(2)).toBe(2)
		expect(sentTo(noRow.email)[1]?.[0].text).toContain(STEP_LESSON[2])
		expect(await sends(5)).toBe(2)
		expect(await sends(6)).toBe(3)
		expect(sentTo(noRow.email)[2]?.[0].text).toContain(STEP_LESSON[3])
	})

	it('after step 3 it is one mail every day, and none on a day with nothing to say', async () => {
		const p = await person({ daysOld: 30 })
		await db.insert(notificationPreferences).values({
			actorId: p.actorId,
			emailDigestEnabled: true,
			emailOnboardingStep: 3,
			emailLastSentOn: '2026-03-09',
		})

		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 60_000))
		expect(sentTo(p.email)).toHaveLength(1)
		const text = sentTo(p.email)[0]?.[0].text as string
		for (const lesson of Object.values(STEP_LESSON)) expect(text).not.toContain(lesson)
		expect(text).toContain('Needs you (1)')
		expect(text).toContain('Next step')

		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + DAY))
		expect(sentTo(p.email)).toHaveLength(2)

		// Card answered: nothing waits, nothing unread, so nothing goes out and the day stays free.
		await db.execute(
			sql`UPDATE notifications SET status = 'resolved' WHERE target_actor_id = ${p.actorId}`,
		)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 2 * DAY))
		expect(sentTo(p.email)).toHaveLength(2)
		expect(await prefsRow(p.actorId)).toMatchObject({ emailLastSentOn: '2026-03-11' })
	})

	it('lists the unread updates of the last day and a first-flow step when nothing waits', async () => {
		const p = await person({ daysOld: 30, card: false })
		await db.insert(notificationPreferences).values({
			actorId: p.actorId,
			emailDigestEnabled: true,
			emailOnboardingStep: 3,
			emailLastSentOn: '2026-03-08',
		})
		// Six inside the last 24 hours, one from 3 days ago that no longer counts.
		for (let i = 1; i <= 6; i++) await unread(p.workspaceId, p.actorId, `Report ${i}`, i * 2)
		await unread(p.workspaceId, p.actorId, 'Too old', 72)

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		const mail = sentTo(p.email)[0]?.[0]
		expect(mail.subject).toBe('6 updates')
		const text = mail.text as string
		expect(text).toContain('Updates (6)')
		expect(text).toContain('Objects (6)')
		// Five rows, newest first, then the rest as a count.
		expect(text).toContain('Report 1:')
		expect(text).toContain('Report 5:')
		expect(text).not.toContain('Report 6:')
		expect(text).not.toContain('Too old')
		expect(text).toContain('1 more in Maskin')
		expect(text).not.toContain('Needs you')
		expect(text).toContain('Create your first flow')

		// Once a flow exists the owner is still alone, so the next step is to invite a teammate.
		await insertObject(db, p.workspaceId, p.actorId, { type: 'loop', title: 'Weekly review' })
		await unread(p.workspaceId, p.actorId, 'Fresh', -20)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + DAY))
		expect(sentTo(p.email)).toHaveLength(2)
		expect(sentTo(p.email)[1]?.[0].text).toContain('Invite a teammate')

		// With a second human in the workspace there is no next-step line.
		const teammate = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: p.workspaceId, actorId: teammate.id as string, role: 'member' })
		await unread(p.workspaceId, p.actorId, 'Fresher', -44)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 2 * DAY))
		expect(sentTo(p.email)).toHaveLength(3)
		expect(sentTo(p.email)[2]?.[0].text).not.toContain('Next step')
	})

	it('a plain member gets no setup steps, and the mail says which role it was written for', async () => {
		const owner = await person({ daysOld: 30, card: false })
		const memberActor = await insertActor(db, {
			type: 'human',
			createdAt: new Date(NOW.getTime() - 30 * DAY),
		})
		const memberId = memberActor.id as string
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: owner.workspaceId, actorId: memberId, role: 'member' })
		for (const actorId of [owner.actorId, memberId]) {
			await db.insert(notificationPreferences).values({
				actorId,
				emailDigestEnabled: true,
				emailOnboardingStep: 3,
				emailLastSentOn: '2026-03-08',
			})
		}
		for (const actorId of [owner.actorId, memberId]) {
			await unread(owner.workspaceId, actorId, 'Report', 1)
		}

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		// No flow yet: the owner is told to create one, the plain member gets no next step.
		expect(sentTo(owner.email)[0]?.[0].text).toContain('Create your first flow')
		expect(sentTo(memberActor.email as string)[0]?.[0].text).not.toContain('Next step')
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'email_sent',
			owner.actorId,
			expect.objectContaining({ role: 'owner_admin' }),
		)
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'email_sent',
			memberId,
			expect.objectContaining({ role: 'member' }),
		)
	})

	it('gets nothing: no action, only left-out rows, action older than 30 days, or switched off', async () => {
		const idle = await person({ daysOld: 90 })
		const botOnly = await person({ daysOld: 90 })
		await activity(botOnly.workspaceId, botOnly.actorId, 'integration', 'created')
		await activity(botOnly.workspaceId, botOnly.actorId, 'notification_preferences', 'created')
		const stale = await person({ daysOld: 90 })
		await activity(
			stale.workspaceId,
			stale.actorId,
			'object',
			'created',
			new Date(NOW.getTime() - 31 * DAY),
		)
		const off = await person({ daysOld: 90 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: off.actorId, emailDigestEnabled: false })
		await activity(off.workspaceId, off.actorId, 'object', 'created')

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		for (const p of [idle, botOnly, stale, off]) expect(sentTo(p.email)).toHaveLength(0)
		expect(await prefsRow(off.actorId)).toMatchObject({ emailDigestEnabled: false })
	})

	it('the standalone rule query returns the same people as the scheduler reads', async () => {
		const on = await person({ daysOld: 5 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: on.actorId, emailDigestEnabled: true })
		const active = await person({ daysOld: 90 })
		await activity(active.workspaceId, active.actorId, 'object', 'created')
		const idle = await person({ daysOld: 90 })

		const viaScheduler = (await selectEmailRecipients(db, NOW)).map((r) => r.actorId)
		const viaStandalone = (
			(await db.execute(
				sql.raw(
					emailRecipientRuleSql(
						`'${new Date(NOW.getTime() - 30 * DAY).toISOString()}'::timestamptz`,
					),
				),
			)) as unknown as Array<{ actor_id: string }>
		).map((r) => r.actor_id)

		for (const id of [on.actorId, active.actorId]) {
			expect(viaScheduler).toContain(id)
			expect(viaStandalone).toContain(id)
		}
		expect(viaScheduler).not.toContain(idle.actorId)
		expect(viaStandalone).not.toContain(idle.actorId)
	})
})

describe('summary email: claim and skips', () => {
	it('a failed send releases the claim, and the next tick sends', async () => {
		const p = await person({ daysOld: 2 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: p.actorId, emailDigestEnabled: true })
		sendEmail.mockRejectedValueOnce(new EmailSendError('validation_error', 'nope'))

		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		expect(await prefsRow(p.actorId)).toMatchObject({
			emailOnboardingStep: 0,
			emailLastSentOn: null,
		})

		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 60_000))
		expect(sentTo(p.email)).toHaveLength(2) // the failed attempt and the real one
		expect(await prefsRow(p.actorId)).toMatchObject({ emailOnboardingStep: 1 })
	})

	it('a failed send for someone with no row leaves no row behind', async () => {
		const p = await person({ daysOld: 90 })
		await activity(p.workspaceId, p.actorId, 'object', 'created')
		sendEmail.mockRejectedValueOnce(new EmailSendError('validation_error', 'nope'))

		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		expect(await prefsRow(p.actorId)).toBeUndefined()
	})

	it('in production without a Resend key it sends nothing and claims nothing', async () => {
		const p = await person({ daysOld: 2 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: p.actorId, emailDigestEnabled: true })

		const sent = await new BriefingEmailScheduler(db, {
			NODE_ENV: 'production',
			APP_URL: 'https://maskin.test',
		}).tick(NOW)

		expect(sent).toBe(0)
		expect(sendEmail).not.toHaveBeenCalled()
		expect(await prefsRow(p.actorId)).toMatchObject({
			emailOnboardingStep: 0,
			emailLastSentOn: null,
		})
	})

	it('FEATURE_BRIEFING_EMAIL=0 sends nothing', async () => {
		const p = await person({ daysOld: 2 })
		await db
			.insert(notificationPreferences)
			.values({ actorId: p.actorId, emailDigestEnabled: true })

		expect(
			await new BriefingEmailScheduler(db, { ...ENV, FEATURE_BRIEFING_EMAIL: '0' }).tick(NOW),
		).toBe(0)
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
			const p = await person({ daysOld: 2 })
			await db
				.insert(notificationPreferences)
				.values({ actorId: p.actorId, emailDigestEnabled: true })
			const env = { ...PROD, FEATURE_BRIEFING_EMAIL: value }

			expect(await new BriefingEmailScheduler(db, env).tick(NOW)).toBe(0)
			expect(sendEmail).not.toHaveBeenCalled()
		})

		it('sends when FEATURE_BRIEFING_EMAIL is 1', async () => {
			const p = await person({ daysOld: 2 })
			await db
				.insert(notificationPreferences)
				.values({ actorId: p.actorId, emailDigestEnabled: true })

			await new BriefingEmailScheduler(db, { ...PROD, FEATURE_BRIEFING_EMAIL: '1' }).tick(NOW)

			expect(sentTo(p.email)).toHaveLength(1)
		})
	})
})

describe('summary email: weekly rhythm', () => {
	const weeklyRow = (
		actorId: string,
		over: Partial<typeof notificationPreferences.$inferInsert> = {},
	) =>
		db.insert(notificationPreferences).values({
			actorId,
			emailDigestEnabled: true,
			emailRhythm: 'weekly',
			emailOnboardingStep: 3,
			...over,
		})

	it('sends one mail when the last send is 6 days back, not at 5, and then not again that week', async () => {
		const p = await person({ daysOld: 40 })
		await weeklyRow(p.actorId, { emailLastSentOn: '2026-03-05' }) // 5 days before NOW

		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		expect(sentTo(p.email)).toHaveLength(0)

		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + DAY)) // 6 days
		expect(sentTo(p.email)).toHaveLength(1)
		expect(await prefsRow(p.actorId)).toMatchObject({ emailLastSentOn: '2026-03-11' })

		for (let d = 2; d <= 6; d++) {
			await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + d * DAY))
		}
		expect(sentTo(p.email)).toHaveLength(1)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 7 * DAY))
		expect(sentTo(p.email)).toHaveLength(2)
	})

	it('an empty week sends nothing and does not use up the week', async () => {
		const p = await person({ daysOld: 40, card: false })
		await weeklyRow(p.actorId, { emailLastSentOn: '2026-03-03' }) // 7 days back, nothing to say

		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		expect(sentTo(p.email)).toHaveLength(0)
		expect(await prefsRow(p.actorId)).toMatchObject({ emailLastSentOn: '2026-03-03' })

		// Something now waits: the very next tick sends, no further wait.
		const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: p.workspaceId, actorId: agent.id as string, role: 'member' })
		await insertNotification(db, p.workspaceId, agent.id as string, {
			targetActorId: p.actorId,
			type: 'needs_input',
			status: 'pending',
			metadata: { kind: FOR_YOU_KIND, rank: 1, headline: 'Approve the launch email' },
		})
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + DAY))
		expect(sentTo(p.email)).toHaveLength(1)
	})

	it('an empty rhythm means daily', async () => {
		const p = await person({ daysOld: 40 })
		await db.insert(notificationPreferences).values({
			actorId: p.actorId,
			emailDigestEnabled: true,
			emailOnboardingStep: 3,
			emailLastSentOn: '2026-03-09', // yesterday
		})
		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		expect(sentTo(p.email)).toHaveLength(1)
	})

	it('a weekly mail looks back over the week and the first three mails keep their teaching blocks in order', async () => {
		const p = await person({ daysOld: 20 })
		await db.insert(notificationPreferences).values({
			actorId: p.actorId,
			emailDigestEnabled: true,
			emailRhythm: 'weekly',
		})
		await unread(p.workspaceId, p.actorId, 'Report from 5 days ago', 5 * 24)

		const days = [0, 6, 12]
		for (const d of days) {
			await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + d * DAY))
		}
		// Not one a day: 5 days after the first, nothing.
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 15 * DAY))

		const texts = sentTo(p.email).map(([m]) => m.text as string)
		expect(texts).toHaveLength(3)
		expect(texts[0]).toContain(STEP_LESSON[1])
		expect(texts[1]).toContain(STEP_LESSON[2])
		expect(texts[2]).toContain(STEP_LESSON[3])
		// The first weekly mail reaches back 7 days, past the daily 24 hours.
		expect(texts[0]).toContain('Report from 5 days ago')
		expect(texts[1]).not.toContain('Report from 5 days ago')
		expect(await prefsRow(p.actorId)).toMatchObject({ emailOnboardingStep: 3 })
	})
})

describe('digest: what the mail lists', () => {
	const load = (actorId: string, mutedWorkspaceIds: string[] = [], lookbackMs = DAY) =>
		loadDigest(db, { actorId, mutedWorkspaceIds, now: NOW, lookbackMs })

	/** A chat with `actorId` in it, and a notification row about message `messageId` in it. */
	async function chat(
		p: { actorId: string; workspaceId: string },
		title: string,
		rows: Array<{
			messageId: number
			type: 'needs_input' | 'good_news'
			status: string
			at?: Date
		}>,
		lastRead: number | null = null,
	) {
		const agent = await insertActor(db, { type: 'agent', name: 'Strategist' })
		const conversation = await insertConversation(db, p.workspaceId, p.actorId, { title })
		const conversationId = conversation?.id as string
		await db.insert(conversationParticipants).values({
			conversationId,
			actorId: p.actorId,
			lastReadMessageId: lastRead,
		})
		for (const r of rows) {
			await insertNotification(db, p.workspaceId, agent.id as string, {
				targetActorId: p.actorId,
				type: r.type,
				status: r.status,
				title: 'Strategist has a question',
				content: 'A SECRET MESSAGE BODY',
				createdAt: r.at ?? new Date(NOW.getTime() - 3600_000),
				metadata:
					r.type === 'needs_input'
						? {
								push_category: 'needs_you',
								conversation_id: conversationId,
								message_id: r.messageId,
							}
						: {
								push_category: 'conversation',
								push_only: true,
								conversation_id: conversationId,
								message_id: r.messageId,
							},
			})
		}
		return conversationId
	}

	it('Needs you is the For You list plus unanswered chat questions, and an answered one is gone', async () => {
		const p = await person({ daysOld: 30 }) // one For You card
		const cards = await buildForYouItems(db, p.workspaceId, p.actorId)
		expect(cards).toHaveLength(1)
		const conversationId = await chat(p, 'Which sender?', [
			{ messageId: 7, type: 'needs_input', status: 'pending' },
		])

		const digest = await load(p.actorId)
		expect(digest.waitingCount).toBe(cards.length + 1)
		expect(digest.waiting.map((r) => r.buttonLabel)).toEqual(['Review', 'Reply'])
		const row = digest.waiting[1]
		expect(row).toMatchObject({
			title: 'Which sender?',
			line: '1 new message',
			typeLabel: 'Chat',
			path: `/${p.workspaceId}/chats/${conversationId}`,
		})
		// A chat row never carries message text.
		expect(JSON.stringify(digest)).not.toContain('SECRET MESSAGE BODY')

		await db.execute(
			sql`UPDATE notifications SET status = 'resolved' WHERE metadata->>'conversation_id' = ${conversationId}`,
		)
		expect((await load(p.actorId)).waitingCount).toBe(cards.length)
	})

	it('shows the top three waiting items and counts the rest', async () => {
		const p = await person({ daysOld: 30 })
		const agent = await insertActor(db, { type: 'agent', name: 'Strategist' })
		for (let i = 2; i <= 6; i++) {
			await insertNotification(db, p.workspaceId, agent.id as string, {
				targetActorId: p.actorId,
				type: 'needs_input',
				status: 'pending',
				metadata: { kind: FOR_YOU_KIND, rank: i, headline: `Card ${i}` },
			})
		}
		const digest = await load(p.actorId)
		expect(digest.waitingCount).toBe(6)
		expect(digest.waiting.map((r) => r.title)).toEqual([
			'Approve the launch email',
			'Card 2',
			'Card 3',
		])
	})

	it('lists only unread notifications meant for the person, grouped, five rows a group', async () => {
		const p = await person({ daysOld: 30, card: false })
		const other = await person({ daysOld: 30, card: false })
		for (let i = 1; i <= 7; i++) await unread(p.workspaceId, p.actorId, `Object ${i}`, i)
		// Opened (seen), resolved, older than the window, caused by the person, and for someone else.
		await unread(p.workspaceId, p.actorId, 'Opened', 1, { status: 'seen' })
		await unread(p.workspaceId, p.actorId, 'Resolved', 1, { status: 'resolved' })
		await unread(p.workspaceId, p.actorId, 'Too old', 30)
		await unread(p.workspaceId, p.actorId, 'Mine', 1, { sourceActorId: p.actorId })
		await unread(p.workspaceId, other.actorId, 'Not mine', 1)
		// A bare status change on an object creates no notification, so it cannot appear: nothing to add.

		// A flow's activity banner (seen + push only) and a loop object count under Flows.
		const flow = await insertObject(db, p.workspaceId, p.actorId, {
			type: 'loop',
			title: 'Weekly digest',
		})
		const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
		for (const hoursAgo of [2, 3]) {
			await insertNotification(db, p.workspaceId, agent.id as string, {
				targetActorId: p.actorId,
				type: 'good_news',
				status: 'seen',
				title: 'Weekly digest',
				objectId: flow?.id,
				createdAt: new Date(NOW.getTime() - hoursAgo * 3600_000),
				metadata: { push_category: 'flow_activity', push_only: true, kind: 'flow_activity' },
			})
		}
		// A chat the person has not read, and one they read through.
		const unreadChat = await chat(p, 'Design Studio', [
			{ messageId: 10, type: 'good_news', status: 'seen' },
			{ messageId: 11, type: 'good_news', status: 'seen' },
		])
		await chat(p, 'Read chat', [{ messageId: 3, type: 'good_news', status: 'seen' }], 5)

		const digest = await load(p.actorId)
		expect(digest.waitingCount).toBe(0)
		expect(digest.groups.map((g) => [g.kind, g.count, g.rows.length])).toEqual([
			['objects', 7, 5],
			['flows', 1, 1],
			['chats', 1, 1],
		])
		expect(digest.updatesCount).toBe(9)
		const objects = digest.groups[0]?.rows.map((r) => r.title)
		// Newest first.
		expect(objects).toEqual(['Object 1', 'Object 2', 'Object 3', 'Object 4', 'Object 5'])
		expect(digest.groups[1]?.rows[0]).toMatchObject({
			title: 'Weekly digest',
			line: 'Finished 2 runs',
			path: `/${p.workspaceId}/loops/${flow?.id}`,
		})
		expect(digest.groups[2]?.rows[0]).toMatchObject({
			title: 'Design Studio',
			line: '2 new messages',
			path: `/${p.workspaceId}/chats/${unreadChat}`,
		})
		expect(JSON.stringify(digest)).not.toContain('SECRET MESSAGE BODY')
	})

	it('does not repeat a waiting item under Updates, and leaves muted workspaces out of Updates only', async () => {
		const p = await person({ daysOld: 30 }) // a For You card, pending
		await unread(p.workspaceId, p.actorId, 'A mention', 2)
		const asked = await chat(p, 'Waiting chat', [
			{ messageId: 20, type: 'needs_input', status: 'pending' },
			{ messageId: 21, type: 'good_news', status: 'seen' },
		])

		const plain = await load(p.actorId)
		// The chat is waiting, so its newer reply only adds to the count there.
		expect(plain.waiting.find((r) => r.path.endsWith(asked))?.line).toBe('2 new messages')
		expect(plain.groups.map((g) => g.kind)).toEqual(['objects'])
		expect(plain.groups[0]?.rows.map((r) => r.title)).toEqual(['A mention'])

		const muted = await load(p.actorId, [p.workspaceId])
		expect(muted.waitingCount).toBe(plain.waitingCount)
		expect(muted.updatesCount).toBe(0)
	})

	it('a weekly person looks back seven days', async () => {
		const p = await person({ daysOld: 30, card: false })
		await unread(p.workspaceId, p.actorId, 'Five days old', 5 * 24)
		expect((await load(p.actorId)).updatesCount).toBe(0)
		expect((await load(p.actorId, [], 7 * DAY)).updatesCount).toBe(1)
	})
})

describe('digest: subject and send rules', () => {
	const prefs = async (actorId: string) =>
		db.insert(notificationPreferences).values({
			actorId,
			emailDigestEnabled: true,
			emailOnboardingStep: 3,
			emailLastSentOn: '2026-03-09',
		})

	it('both parts, only updates, only waiting items', async () => {
		const both = await person({ daysOld: 30 })
		await unread(both.workspaceId, both.actorId, 'One', 2)
		await unread(both.workspaceId, both.actorId, 'Two', 3)
		const updatesOnly = await person({ daysOld: 30, card: false })
		await unread(updatesOnly.workspaceId, updatesOnly.actorId, 'One', 2)
		const waitingOnly = await person({ daysOld: 30 })
		for (const p of [both, updatesOnly, waitingOnly]) await prefs(p.actorId)

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		expect(sentTo(both.email)[0]?.[0].subject).toBe('1 needs you, 2 other updates')
		expect(sentTo(updatesOnly.email)[0]?.[0].subject).toBe('1 update')
		const only = sentTo(waitingOnly.email)[0]?.[0]
		expect(only.subject).toBe('1 needs you')
		expect(only.text).not.toContain('Updates (')
		expect(only.text).toContain('Needs you (1)')
		expect(only.text).toContain('Review:')
		// The mail says it is one email a day and when it goes out.
		expect(only.text).toContain('One email a day instead of one per notification')
		expect(only.text).toContain('at 08:00')
		expect(capturePosthogEvent).toHaveBeenCalledWith(
			'email_sent',
			both.actorId,
			expect.objectContaining({
				kind: 'digest',
				needs_you_count: 1,
				objects_count: 2,
				flows_count: 0,
				chats_count: 0,
			}),
		)
	})

	it('sends nothing when both parts are empty, and the day is not used up', async () => {
		const p = await person({ daysOld: 30, card: false })
		await prefs(p.actorId)
		await new BriefingEmailScheduler(db, ENV).tick(NOW)
		expect(sentTo(p.email)).toHaveLength(0)
		expect(await prefsRow(p.actorId)).toMatchObject({ emailLastSentOn: '2026-03-09' })
	})
})
