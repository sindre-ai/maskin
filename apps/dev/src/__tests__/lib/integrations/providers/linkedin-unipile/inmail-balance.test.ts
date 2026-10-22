import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { credentialMock } = vi.hoisted(() => ({ credentialMock: vi.fn() }))
vi.mock('../../../../../lib/integrations/lookup', () => ({
	actorScopedProviders: new Set(['linkedin-unipile']),
	findIntegrationRow: credentialMock,
	getCredential: vi.fn(async () => ({ value: JSON.stringify({ account_id: 'acc_1' }) })),
}))
vi.mock('../../../../../lib/workspace-auth', () => ({ isWorkspaceMember: async () => true }))
vi.mock('../../../../../lib/crypto', () => ({
	decrypt: () => JSON.stringify({ account_id: 'acc_1' }),
	encrypt: (v: string) => v,
}))

import {
	INMAIL_CREDIT_FLOOR,
	deriveInmailBalance,
	inmailCreditsPath,
	parseInmailCredits,
} from '../../../../../lib/integrations/providers/linkedin-unipile/inmail'
import {
	__setLinkedInClientForTests,
	getLinkedInInmailBalance,
} from '../../../../../lib/integrations/providers/linkedin-unipile/operations'
import { createLinkedInHttpClient } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * The credits payloads below follow the Unipile v2 reference for
 * GET /v2/{account_id}/linkedin/inmail-credits: `{ credits: { classic, recruiter,
 * sales_navigator } }`. They are NOT captured from a live account yet; the deploy check on
 * Sebk's account is the first live call and should replace PREMIUM with that capture.
 */
const PREMIUM = { credits: { classic: 15 } }

const ctx = { db: {} as Database, actorId: 'actor-1', workspaceId: 'ws-1' }

describe('InMail credits client', () => {
	it('GETs the classic credits route with the service query', async () => {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(PREMIUM), { status: 200 }))
		const client = createLinkedInHttpClient({
			baseUrl: 'https://unipile.test',
			apiKey: 'k',
			fetchImpl: fetchImpl as never,
		})
		const res = await client.getInmailCredits({ account_id: 'acc_1' })
		expect(res.status).toBe(200)
		expect(res.body).toEqual(PREMIUM)
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://unipile.test/v2/acc_1/linkedin/inmail-credits?service=classic')
		expect(init.method).toBe('GET')
	})

	it('url-encodes the account id in the path', () => {
		expect(inmailCreditsPath('acc/1')).toBe('/v2/acc%2F1/linkedin/inmail-credits?service=classic')
	})
})

describe('deriveInmailBalance', () => {
	it('a classic key means a premium seat', () => {
		expect(deriveInmailBalance(parseInmailCredits(PREMIUM))).toEqual({
			seat: 'premium',
			credits_classic: 15,
			credits_sales_navigator: null,
			sendable_now: 13,
		})
	})

	it('keeps the floor back: 2 credits send nothing, 3 send one', () => {
		expect(INMAIL_CREDIT_FLOOR).toBe(2)
		expect(deriveInmailBalance({ classic: 2, sales_navigator: null, recruiter: null })).toMatchObject({
			sendable_now: 0,
		})
		expect(deriveInmailBalance({ classic: 3, sales_navigator: null, recruiter: null })).toMatchObject({
			sendable_now: 1,
		})
		expect(deriveInmailBalance({ classic: 0, sales_navigator: null, recruiter: null })).toMatchObject(
			{ seat: 'premium', sendable_now: 0 },
		)
	})

	it('maps a sales_navigator or recruiter key to that seat only when no classic key is present', () => {
		const nav = deriveInmailBalance(parseInmailCredits({ credits: { sales_navigator: 30 } }))
		expect(nav).toEqual({
			seat: 'sales_navigator',
			credits_classic: null,
			credits_sales_navigator: 30,
			sendable_now: 0,
		})
		expect(deriveInmailBalance(parseInmailCredits({ credits: { recruiter: 10 } })).seat).toBe(
			'recruiter',
		)
		expect(
			deriveInmailBalance(parseInmailCredits({ credits: { classic: 5, sales_navigator: 30 } })).seat,
		).toBe('premium')
	})

	it('no keys, or no credits object at all, means a free account', () => {
		expect(deriveInmailBalance(parseInmailCredits({ credits: {} }))).toEqual({
			seat: 'free',
			credits_classic: null,
			credits_sales_navigator: null,
			sendable_now: 0,
		})
		expect(deriveInmailBalance(parseInmailCredits({})).seat).toBe('free')
		expect(deriveInmailBalance(parseInmailCredits(null)).seat).toBe('free')
	})

	it('ignores keys that are not a count', () => {
		expect(parseInmailCredits({ credits: { classic: 'many', recruiter: -1, sales_navigator: null } })).toEqual(
			{ classic: null, sales_navigator: null, recruiter: null },
		)
	})
})

describe('getLinkedInInmailBalance', () => {
	beforeEach(() => {
		credentialMock.mockResolvedValue({ id: 'int-1', actorId: 'actor-1', credentials: 'encrypted' })
	})
	afterEach(() => {
		__setLinkedInClientForTests(null)
		vi.restoreAllMocks()
	})

	function stub(status: number, body: unknown) {
		const calls: Array<Record<string, unknown>> = []
		__setLinkedInClientForTests(
			() =>
				({
					getInmailCredits: async (query: Record<string, unknown>) => {
						calls.push(query)
						return { status, body, headers: {} }
					},
				}) as never,
		)
		return calls
	}

	it('reads the credits once for the connected account and reports the balance', async () => {
		const calls = stub(200, PREMIUM)
		await expect(getLinkedInInmailBalance(ctx)).resolves.toEqual({
			seat: 'premium',
			credits_classic: 15,
			credits_sales_navigator: null,
			sendable_now: 13,
		})
		expect(calls).toEqual([{ account_id: 'acc_1' }])
	})

	it('answers seat unknown when the credits call fails, instead of throwing', async () => {
		stub(400, { error_code: 'bad_request' })
		await expect(getLinkedInInmailBalance(ctx)).resolves.toEqual({
			seat: 'unknown',
			credits_classic: null,
			credits_sales_navigator: null,
			sendable_now: 0,
		})
	})
})
