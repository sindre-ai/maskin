// The mail to the billing owner when a workspace uses up its plan (task "Email when a workspace
// uses up its plan"). Off unless the workspace has the plan-limit-email flag; once per workspace
// and billing period, kept across restarts by a plan_limit_emails row.

import { actors, planLimitEmails, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetFeatureFlagConfig } from '../../lib/feature-flags'
import { notifyPlanLimitReached, resetPlanLimitEmailForTest } from '../../services/plan-limit-email'
import { ensureWorkspaceMember, insertActor, insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

const { sendEmailMock } = vi.hoisted(() => ({
	sendEmailMock: vi.fn(
		async (_p: { to: string; subject: string; text: string; html: string }) => true,
	),
}))

const PERIOD_END = Date.UTC(2026, 11, 3)
const NEXT_PERIOD_END = Date.UTC(2027, 0, 3)

describe('notifyPlanLimitReached', () => {
	let workspaceId: string
	let ownerId: string
	let previousFeatures: string | undefined
	let previousTeam: string | undefined

	const rows = () =>
		db.select().from(planLimitEmails).where(eq(planLimitEmails.workspaceId, workspaceId))
	const notify = (over: Partial<{ plan: string; periodEnd: number | null }> = {}) =>
		notifyPlanLimitReached(
			{ db, workspaceId, plan: 'pro', periodEnd: PERIOD_END, ...over },
			{ env: { NODE_ENV: 'test' }, send: sendEmailMock },
		)

	function setFlag(on: boolean) {
		process.env.FF_WORKSPACE_FEATURES = on ? `${workspaceId}:plan-limit-email` : ''
		_resetFeatureFlagConfig()
	}

	beforeEach(async () => {
		sendEmailMock.mockClear()
		sendEmailMock.mockResolvedValue(true)
		resetPlanLimitEmailForTest()
		previousFeatures = process.env.FF_WORKSPACE_FEATURES
		previousTeam = process.env.POSTHOG_TEAM_WORKSPACE_ID
		ownerId = getTestActorId()
		workspaceId = (await insertWorkspace(db, ownerId, { name: 'Acme' })).id
		setFlag(true)
	})

	afterEach(() => {
		if (previousFeatures === undefined) Reflect.deleteProperty(process.env, 'FF_WORKSPACE_FEATURES')
		else process.env.FF_WORKSPACE_FEATURES = previousFeatures
		if (previousTeam === undefined) Reflect.deleteProperty(process.env, 'POSTHOG_TEAM_WORKSPACE_ID')
		else process.env.POSTHOG_TEAM_WORKSPACE_ID = previousTeam
		_resetFeatureFlagConfig()
	})

	it('sends one mail to the billing owner and a second refusal in the period sends none', async () => {
		await notify()
		await notify()

		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(await rows()).toHaveLength(1)
		expect(sendEmailMock.mock.calls[0]?.[0].subject).toBe(
			'Your Maskin plan is used up for this month',
		)
	})

	it('sends nothing, and stores nothing, with the flag off', async () => {
		setFlag(false)

		await notify()

		expect(sendEmailMock).not.toHaveBeenCalled()
		expect(await rows()).toHaveLength(0)
	})

	it('does not send twice after a restart, because the claim is stored', async () => {
		await notify()
		resetPlanLimitEmailForTest()
		await notify()

		expect(sendEmailMock).toHaveBeenCalledTimes(1)
	})

	it('sends again in the next billing period', async () => {
		await notify()
		await notify({ periodEnd: NEXT_PERIOD_END })

		expect(sendEmailMock).toHaveBeenCalledTimes(2)
		expect(await rows()).toHaveLength(2)
	})

	it('sends nothing when the period end is unknown', async () => {
		await notify({ periodEnd: null })

		expect(sendEmailMock).not.toHaveBeenCalled()
		expect(await rows()).toHaveLength(0)
	})

	it('sends the trial wording for a trial workspace', async () => {
		await notify({ plan: 'trial' })

		expect(sendEmailMock.mock.calls[0]?.[0].subject).toBe('Your Maskin trial usage is used up')
	})

	it('skips the internal workspace', async () => {
		process.env.POSTHOG_TEAM_WORKSPACE_ID = workspaceId

		await notify()

		expect(sendEmailMock).not.toHaveBeenCalled()
		expect(await rows()).toHaveLength(0)
	})

	it('sends to the billing owner when that is not the workspace owner', async () => {
		const payer = await insertActor(db, { email: 'payer@test.com' })
		await ensureWorkspaceMember(db, workspaceId, payer.id)
		await db
			.update(workspaces)
			.set({ billingOwnerId: payer.id })
			.where(eq(workspaces.id, workspaceId))

		await notify()

		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(sendEmailMock.mock.calls[0]?.[0].to).toBe('payer@test.com')
	})

	it('falls back to the workspace owners when there is no billing owner', async () => {
		await db.update(workspaces).set({ billingOwnerId: null }).where(eq(workspaces.id, workspaceId))
		const [owner] = await db
			.select({ email: actors.email })
			.from(actors)
			.where(eq(actors.id, ownerId))

		await notify()

		expect(sendEmailMock).toHaveBeenCalledTimes(1)
		expect(sendEmailMock.mock.calls[0]?.[0].to).toBe(owner?.email)
	})

	it('releases the claim when the send fails, so the next refusal can try again', async () => {
		sendEmailMock.mockRejectedValueOnce(new Error('provider down'))

		await notify()
		expect(await rows()).toHaveLength(0)

		await notify()
		expect(sendEmailMock).toHaveBeenCalledTimes(2)
		expect(await rows()).toHaveLength(1)
	})

	it('refuses a second row for the same workspace, period and kind', async () => {
		await notify()

		await expect(
			db.insert(planLimitEmails).values({
				workspaceId,
				periodEnd: new Date(PERIOD_END),
				kind: 'plan_used_up',
			}),
		).rejects.toThrow()
	})
})
