/**
 * The opt-in Marketplace pick in the summary email, against real Postgres: nobody who did not
 * switch picks on sees one, none in the first three mails, one a week, an installed flow is never
 * picked, a dismissal is honoured, no match leaves the block out, and a pick alone sends nothing.
 * Mail is captured, never sent.
 */
import { randomUUID } from 'node:crypto'
import {
	installedLoops,
	marketplaceLoops,
	notificationPreferences,
	workspaceMembers,
} from '@maskin/db/schema'
import { EmailSendError } from '@maskin/email'
import { FOR_YOU_KIND } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const sendEmail = vi.fn()

vi.mock('@maskin/email', async (importOriginal) => ({
	...(await importOriginal<typeof import('@maskin/email')>()),
	sendEmail: (...args: unknown[]) => sendEmail(...args),
}))
vi.mock('../../lib/email-stop-link', () => ({
	buildEmailStopUrl: (actorId: string) => `https://maskin.test/email/stop?a=${actorId}`,
}))
vi.mock('../../lib/email-pick-token', () => ({
	buildEmailPickDismissUrl: (actorId: string, loopId: string) =>
		`https://maskin.test/api/email/pick-dismiss?a=${actorId}&l=${loopId}`,
}))
vi.mock('../../lib/email-stop-token', () => ({
	isEmailStopConfigured: () => true,
}))

import { BriefingEmailScheduler } from '../../services/briefing-email-scheduler'
import { insertActor, insertNotification, insertWorkspace } from '../factories'
import { db } from './global-setup'

const DAY = 24 * 3600_000
// 08:10 UTC: inside the 08:00 UTC window for people with no stored timezone.
const NOW = new Date('2026-03-10T08:10:00Z')
const ENV = { RESEND_API_KEY: 're_test', APP_URL: 'https://maskin.test', NODE_ENV: 'test' }

/** A person past the three onboarding mails, with a card waiting (so a mail goes out). */
async function person(
	opts: {
		picks?: boolean
		step?: number
		card?: boolean
		dismissed?: string[]
		emailOn?: boolean
		lastPickOn?: string | null
	} = {},
) {
	const actor = await insertActor(db, {
		type: 'human',
		createdAt: new Date(NOW.getTime() - 90 * DAY),
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
	await db.insert(notificationPreferences).values({
		actorId,
		emailDigestEnabled: opts.emailOn ?? true,
		emailOnboardingStep: opts.step ?? 3,
		emailLastSentOn: '2026-03-01',
		marketplacePicksEnabled: opts.picks ?? false,
		marketplaceDismissedLoopIds: opts.dismissed ?? [],
		marketplacePickLastSentOn: opts.lastPickOn ?? null,
	})
	return { actorId, email: actor.email as string, workspaceId }
}

/** A catalog flow. A fresh use case per test keeps flows from other tests out of the match. */
async function flow(name: string, useCase: string | null) {
	const [row] = await db
		.insert(marketplaceLoops)
		.values({
			name,
			slug: `${name.toLowerCase().replace(/\W+/g, '-')}-${randomUUID().slice(0, 8)}`,
			description: `${name} does its job on a schedule.`,
			version: '1.0.0',
			useCase,
		})
		.returning()
	return row as { id: string; name: string }
}

async function install(workspaceId: string, loopId: string) {
	await db
		.insert(installedLoops)
		.values({ workspaceId, sourceLoopId: loopId, installedVersion: '1.0.0' })
}

const prefsRow = async (actorId: string) =>
	(
		await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, actorId))
	)[0]

const sentTo = (email: string) => sendEmail.mock.calls.filter(([m]) => m.to === email)
const tick = (at: Date) => new BriefingEmailScheduler(db, ENV).tick(at)

beforeEach(() => {
	sendEmail.mockReset()
	sendEmail.mockResolvedValue(true)
})

describe('Marketplace pick in the summary email', () => {
	it('adds one pick below the summary for someone who switched picks on, with a reason and a Not useful link', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		const offer = await flow('Beta Watch', useCase)
		const p = await person({ picks: true })
		await install(p.workspaceId, have.id)

		await tick(NOW)

		expect(sentTo(p.email)).toHaveLength(1)
		const mail = sentTo(p.email)[0]?.[0]
		expect(mail.subject).toBe('1 thing needs you')
		expect(mail.text).toContain('Marketplace pick')
		expect(mail.text).toContain('Beta Watch')
		expect(mail.text).toContain('Why you see this: you already use Alpha Watch')
		expect(mail.text).toContain(
			`${ENV.APP_URL}/${p.workspaceId}/marketplace/${offer.id}?surface=email&block=pick`,
		)
		expect(mail.text).toContain(`l=${offer.id}`)
		expect(mail.text).toContain('Setup and cost are on its Marketplace page.')
		expect(mail.text.indexOf('Open it')).toBeLessThan(mail.text.indexOf('Marketplace pick'))
		expect(mail.text).toContain('block=summary')
		expect(await prefsRow(p.actorId)).toMatchObject({ marketplacePickLastSentOn: '2026-03-10' })
	})

	it('shows nothing to someone who did not switch picks on', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		await flow('Beta Watch', useCase)
		const p = await person({ picks: false })
		await install(p.workspaceId, have.id)

		await tick(NOW)

		expect(sentTo(p.email)).toHaveLength(1)
		expect(sentTo(p.email)[0]?.[0].text).not.toContain('Marketplace pick')
		expect((await prefsRow(p.actorId))?.marketplacePickLastSentOn).toBeNull()
	})

	it('puts no pick in the first three mails', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		await flow('Beta Watch', useCase)
		for (const step of [0, 1, 2]) {
			const p = await person({ picks: true, step })
			await install(p.workspaceId, have.id)
			await tick(NOW)
			expect(sentTo(p.email)).toHaveLength(1)
			expect(sentTo(p.email)[0]?.[0].text).not.toContain('Marketplace pick')
			expect((await prefsRow(p.actorId))?.marketplacePickLastSentOn).toBeNull()
		}
	})

	it('sends at most one pick a week', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		await flow('Beta Watch', useCase)
		const p = await person({ picks: true })
		await install(p.workspaceId, have.id)

		const picked = async (days: number) => {
			const before = sentTo(p.email).length
			await tick(new Date(NOW.getTime() + days * DAY))
			const mails = sentTo(p.email)
			expect(mails).toHaveLength(before + 1)
			return (mails[before]?.[0].text as string).includes('Marketplace pick')
		}
		expect(await picked(0)).toBe(true)
		for (const day of [1, 2, 3, 4, 5, 6]) expect(await picked(day)).toBe(false)
		expect(await picked(7)).toBe(true)
	})

	it('never picks a flow the workspace already installed', async () => {
		const useCase = `Case ${randomUUID()}`
		const a = await flow('Alpha Watch', useCase)
		const b = await flow('Beta Watch', useCase)
		const p = await person({ picks: true })
		await install(p.workspaceId, a.id)
		await install(p.workspaceId, b.id)

		await tick(NOW)

		expect(sentTo(p.email)).toHaveLength(1)
		expect(sentTo(p.email)[0]?.[0].text).not.toContain('Marketplace pick')
	})

	it('honours a dismissal: that flow is never suggested to that person again', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		const offer = await flow('Beta Watch', useCase)
		const p = await person({ picks: true, dismissed: [offer.id] })
		await install(p.workspaceId, have.id)
		const other = await person({ picks: true })
		await install(other.workspaceId, have.id)

		await tick(NOW)

		expect(sentTo(p.email)[0]?.[0].text).not.toContain('Marketplace pick')
		// Someone else who did not dismiss it still gets it.
		expect(sentTo(other.email)[0]?.[0].text).toContain('Beta Watch')
	})

	it('leaves the block out when no flow matches, and still sends the summary', async () => {
		const have = await flow('Alpha Watch', `Case ${randomUUID()}`)
		await flow('Other Topic', `Case ${randomUUID()}`)
		await flow('No Category', null)
		const p = await person({ picks: true })
		await install(p.workspaceId, have.id)

		await tick(NOW)

		expect(sentTo(p.email)).toHaveLength(1)
		expect(sentTo(p.email)[0]?.[0].text).not.toContain('Marketplace pick')
		expect((await prefsRow(p.actorId))?.marketplacePickLastSentOn).toBeNull()
	})

	it('never causes a send on its own: no activity, no mail, even with a pick waiting', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		await flow('Beta Watch', useCase)
		const p = await person({ picks: true, card: false })
		await install(p.workspaceId, have.id)

		await tick(NOW)

		expect(sentTo(p.email)).toHaveLength(0)
		expect(await prefsRow(p.actorId)).toMatchObject({
			emailLastSentOn: '2026-03-01',
			marketplacePickLastSentOn: null,
		})
	})

	it('stops with the email switch: a person who switched email off gets no pick either', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		await flow('Beta Watch', useCase)
		const p = await person({ picks: true, emailOn: false })
		await install(p.workspaceId, have.id)

		await tick(NOW)

		expect(sentTo(p.email)).toHaveLength(0)
	})

	it('gives the pick week back when the send fails', async () => {
		const useCase = `Case ${randomUUID()}`
		const have = await flow('Alpha Watch', useCase)
		await flow('Beta Watch', useCase)
		const p = await person({ picks: true })
		await install(p.workspaceId, have.id)
		sendEmail.mockRejectedValueOnce(new EmailSendError('provider_error', 'boom'))

		await tick(NOW)

		expect(await prefsRow(p.actorId)).toMatchObject({
			emailLastSentOn: '2026-03-01',
			marketplacePickLastSentOn: null,
		})
	})
})
