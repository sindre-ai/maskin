/**
 * Summary email scheduler against real Postgres: the recipient rule (including the two activity
 * row kinds that do not count), the exactly-once claim, the released claim on a failed send, and
 * the skips (no key in production, killswitch). Mail is captured, never sent.
 */
import { randomUUID } from 'node:crypto'
import { events, notificationPreferences, workspaceMembers } from '@maskin/db/schema'
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

import {
	BriefingEmailScheduler,
	emailRecipientRuleSql,
	selectEmailRecipients,
} from '../../services/briefing-email-scheduler'
import { STEP_LESSON } from '../../services/briefing-email-text'
import {
	insertActor,
	insertNotification,
	insertObject,
	insertSession,
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
		expect(mail.subject).toBe('1 thing needs you')
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
		expect(text).toContain('Waiting on you')
		expect(text).toContain('Next step')

		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + DAY))
		expect(sentTo(p.email)).toHaveLength(2)

		// Card answered: nothing waits, nothing finished, so nothing goes out and the day stays free.
		await db.execute(
			sql`UPDATE notifications SET status = 'resolved' WHERE target_actor_id = ${p.actorId}`,
		)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + 2 * DAY))
		expect(sentTo(p.email)).toHaveLength(2)
		expect(await prefsRow(p.actorId)).toMatchObject({ emailLastSentOn: '2026-03-11' })
	})

	it('shows the finished runs since the last mail and a first-loop step when nothing waits', async () => {
		const p = await person({ daysOld: 30, card: false })
		await db.insert(notificationPreferences).values({
			actorId: p.actorId,
			emailDigestEnabled: true,
			emailOnboardingStep: 3,
			emailLastSentOn: '2026-03-08',
		})
		const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
		const finish = async (title: string, hoursAgo: number) => {
			const o = await insertObject(db, p.workspaceId, p.actorId, { title })
			await insertSession(db, p.workspaceId, agent.id as string, p.actorId, {
				status: 'completed',
				interactive: false,
				initiatedFromObjectId: o?.id,
				completedAt: new Date(NOW.getTime() - hoursAgo * 3600_000),
			})
		}
		// Two days since the last mail, so runs from the last 48 hours count; one from 3 days ago does not.
		for (let i = 1; i <= 6; i++) await finish(`Report ${i}`, i * 2)
		await finish('Too old', 72)

		await new BriefingEmailScheduler(db, ENV).tick(NOW)

		const text = sentTo(p.email)[0]?.[0].text as string
		expect(text).toContain("Researcher finished 'Report 1'")
		expect(text).toContain("Researcher finished 'Report 5'")
		expect(text).not.toContain('Report 6')
		expect(text).not.toContain('Too old')
		expect(text).toContain('and 1 more')
		expect(text).not.toContain('Waiting on you')
		expect(text).toContain('Create your first flow')

		// Once a flow exists the owner is still alone, so the next step is to invite a teammate.
		await insertObject(db, p.workspaceId, p.actorId, { type: 'loop', title: 'Weekly review' })
		await finish('Fresh', -20)
		await new BriefingEmailScheduler(db, ENV).tick(new Date(NOW.getTime() + DAY))
		expect(sentTo(p.email)).toHaveLength(2)
		expect(sentTo(p.email)[1]?.[0].text).toContain('Invite a teammate')

		// With a second human in the workspace there is no next-step line.
		const teammate = await insertActor(db, { type: 'human' })
		await db
			.insert(workspaceMembers)
			.values({ workspaceId: p.workspaceId, actorId: teammate.id as string, role: 'member' })
		await finish('Fresher', -44)
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
		const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
		for (const actorId of [owner.actorId, memberId]) {
			const o = await insertObject(db, owner.workspaceId, actorId, { title: 'Report' })
			await insertSession(db, owner.workspaceId, agent.id as string, actorId, {
				status: 'completed',
				interactive: false,
				initiatedFromObjectId: o?.id,
				completedAt: new Date(NOW.getTime() - 3600_000),
			})
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
		const agent = await insertActor(db, { type: 'agent', name: 'Researcher' })
		const o = await insertObject(db, p.workspaceId, p.actorId, { title: 'Report from 5 days ago' })
		await insertSession(db, p.workspaceId, agent.id as string, p.actorId, {
			status: 'completed',
			interactive: false,
			initiatedFromObjectId: o?.id,
			completedAt: new Date(NOW.getTime() - 5 * DAY),
		})

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
		expect(texts[0]).toContain("Researcher finished 'Report from 5 days ago'")
		expect(await prefsRow(p.actorId)).toMatchObject({ emailOnboardingStep: 3 })
	})
})
