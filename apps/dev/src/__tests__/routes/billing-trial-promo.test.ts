import { randomUUID } from 'node:crypto'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/stripe', async () => {
	const actual = await vi.importActual<typeof import('../../lib/stripe')>('../../lib/stripe')
	return { ...actual, getStripeClient: vi.fn(() => ({}) as unknown) }
})
vi.mock('../../lib/trial-card', async () => {
	const actual =
		await vi.importActual<typeof import('../../lib/trial-card')>('../../lib/trial-card')
	return { ...actual, startTrial: vi.fn() }
})
vi.mock('../../lib/trial-promo', async () => {
	const actual =
		await vi.importActual<typeof import('../../lib/trial-promo')>('../../lib/trial-promo')
	return { ...actual, promoCodeTrialDays: vi.fn(), startTrialWithPromo: vi.fn() }
})

import { startTrial } from '../../lib/trial-card'
import {
	TrialPromoCodeInvalidError,
	promoCodeTrialDays,
	resetPromoRateLimitForTests,
	startTrialWithPromo,
} from '../../lib/trial-promo'
import billingRoutes from '../../routes/billing'
import { jsonRequest } from '../helpers'
import { createTestApp } from '../setup'

// The promo code half of the billing routes: the check route only looks, the start route needs a
// card setup or a code, and guessing is rate limited.

const OWNER_CALLER = { role: 'owner', type: 'human' } as const
const WAITING = { settings: { billing: { plan: 'trial', trial_state: 'awaiting_card' } } }

function setup(row: Record<string, unknown> = WAITING) {
	const { app, mockResults } = createTestApp(billingRoutes, '/api/billing')
	const workspaceId = randomUUID()
	mockResults.select = [{ id: workspaceId, ...OWNER_CALLER, ...row }]
	const post = (path: string, body: unknown) =>
		app.request(jsonRequest('POST', `/api/billing${path}`, body, { 'X-Workspace-Id': workspaceId }))
	return { post }
}

beforeEach(() => {
	resetPromoRateLimitForTests()
	vi.mocked(promoCodeTrialDays).mockReset()
	vi.mocked(startTrialWithPromo).mockReset()
	vi.mocked(startTrial).mockReset()
})

describe('POST /api/billing/trial/promo/check', () => {
	it('says valid for a good code', async () => {
		vi.mocked(promoCodeTrialDays).mockResolvedValue(14)
		const res = await setup().post('/trial/promo/check', { code: 'FRIENDS-2026' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ valid: true, trial_days: 14 })
	})

	it('says not valid for a wrong, expired or used up code, with the same answer', async () => {
		vi.mocked(promoCodeTrialDays).mockResolvedValue(null)
		const res = await setup().post('/trial/promo/check', { code: 'NOPE-1234' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ valid: false, trial_days: null })
	})

	it('does not look at the code for a workspace that is not waiting for a card', async () => {
		const res = await setup({ settings: { billing: { plan: 'pro' } } }).post('/trial/promo/check', {
			code: 'FRIENDS-2026',
		})
		expect(res.status).toBe(409)
		expect(promoCodeTrialDays).not.toHaveBeenCalled()
	})

	it('answers 429 with Retry-After after 10 tries in a minute', async () => {
		vi.mocked(promoCodeTrialDays).mockResolvedValue(null)
		const { post } = setup()
		for (let i = 0; i < 10; i++) {
			expect((await post('/trial/promo/check', { code: `GUESS-${i}00` })).status).toBe(200)
		}
		const res = await post('/trial/promo/check', { code: 'GUESS-1100' })
		expect(res.status).toBe(429)
		expect(Number(res.headers.get('Retry-After'))).toBeGreaterThan(0)
		expect(promoCodeTrialDays).toHaveBeenCalledTimes(10)
	})
})

describe('POST /api/billing/trial/start with a promo code', () => {
	it('starts the trial with no card for a good code', async () => {
		vi.mocked(startTrialWithPromo).mockResolvedValue({ trialEndsAt: 1_800_604_800 })
		const res = await setup().post('/trial/start', { promo_code: 'FRIENDS-2026' })
		expect(res.status).toBe(200)
		expect(await res.json()).toEqual({ trial_state: 'started', trial_ends_at: 1_800_604_800 })
		expect(startTrial).not.toHaveBeenCalled()
	})

	it('answers 400 TRIAL_PROMO_CODE_INVALID when the server finds the code no longer valid', async () => {
		vi.mocked(startTrialWithPromo).mockRejectedValue(new TrialPromoCodeInvalidError())
		const res = await setup().post('/trial/start', { promo_code: 'FRIENDS-2026' })
		expect(res.status).toBe(400)
		expect(await res.json()).toMatchObject({ error: { code: 'TRIAL_PROMO_CODE_INVALID' } })
	})

	it('refuses a start with no card and no code', async () => {
		const res = await setup().post('/trial/start', {})
		expect(res.status).toBe(400)
		expect(startTrialWithPromo).not.toHaveBeenCalled()
		expect(startTrial).not.toHaveBeenCalled()
	})

	it('refuses a start that sends both a card setup and a code', async () => {
		const res = await setup().post('/trial/start', {
			setup_intent_id: 'seti_1',
			promo_code: 'FRIENDS-2026',
		})
		expect(res.status).toBe(400)
		expect(startTrialWithPromo).not.toHaveBeenCalled()
		expect(startTrial).not.toHaveBeenCalled()
	})

	it('counts code tries against the same limit as the check route', async () => {
		vi.mocked(startTrialWithPromo).mockRejectedValue(new TrialPromoCodeInvalidError())
		const { post } = setup()
		for (let i = 0; i < 10; i++) {
			expect((await post('/trial/start', { promo_code: `GUESS-${i}00` })).status).toBe(400)
		}
		expect((await post('/trial/start', { promo_code: 'GUESS-1100' })).status).toBe(429)
	})

	it('still starts from a card setup', async () => {
		vi.mocked(startTrial).mockResolvedValue({ trialEndsAt: 1_800_604_800 })
		const res = await setup().post('/trial/start', { setup_intent_id: 'seti_1' })
		expect(res.status).toBe(200)
		expect(startTrial).toHaveBeenCalledTimes(1)
		expect(startTrialWithPromo).not.toHaveBeenCalled()
	})
})
