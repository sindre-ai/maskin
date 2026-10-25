import { describe, expect, it, vi } from 'vitest'
import cancelFixture from '../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__/relation-requests.cancel.documented.json'
import sentFixture from '../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__/relation-requests.sent.documented.json'
import {
	type SentListCaches,
	addDays,
	findSentInvitation,
	forgetSentInvitation,
} from '../../../../../lib/integrations/providers/linkedin-unipile/invitation-withdrawal'
import {
	type SentInvitationsPage,
	parseSentInvitations,
} from '../../../../../lib/integrations/providers/linkedin-unipile/invitations'

const NOW = new Date('2026-10-22T12:00:00.000Z')
const MINUTE = 60 * 1000

function invitation(id: string) {
	return {
		invitation_id: id,
		recipient_provider_id: `ACoAA-${id}`,
		public_identifier: null,
		name: null,
		headline: null,
		sent_at: null,
		age_days: null,
		message: null,
	}
}

/** A sent list of `total` ids (i-0 .. i-N) served in pages the way LinkedIn pages it. */
function pagedList(total: number) {
	const fetchPage = vi.fn(async (offset: number, limit: number): Promise<SentInvitationsPage> => {
		const ids = Array.from({ length: total }, (_, i) => `i-${i}`).slice(offset, offset + limit)
		return { invitations: ids.map(invitation), row_count: ids.length, total }
	})
	return fetchPage
}

describe('the documented invitation fixtures (documented, not recorded)', () => {
	it('say so in their provenance note', () => {
		expect(sentFixture._provenance).toMatch(/^DOCUMENTED, NOT RECORDED/)
		expect(cancelFixture._provenance).toMatch(/^DOCUMENTED, NOT RECORDED/)
	})

	it('parse with the created date optional: dated, undated and unreadable dates', () => {
		const page = parseSentInvitations(sentFixture, NOW)
		expect(page.total).toBe(3)
		expect(page.row_count).toBe(3)
		const byId = Object.fromEntries(page.invitations.map((i) => [i.invitation_id, i]))
		expect(byId['rr-with-date']).toMatchObject({
			sent_at: '2026-09-28T09:15:00.000Z',
			age_days: 24,
			recipient_provider_id: 'ACoAA-with-date',
		})
		expect(byId['rr-without-date']).toMatchObject({ sent_at: null, age_days: null, message: null })
		expect(byId['rr-bad-date']).toMatchObject({ sent_at: null, age_days: null })
	})

	it('describe a cancel answer that carries no data we depend on', () => {
		expect(cancelFixture.object).toBe('RelationRequestCanceled')
	})
})

describe('addDays', () => {
	it('adds whole days to a date without touching the original', () => {
		const plus21 = addDays(NOW, 21)
		expect(plus21.toISOString()).toBe('2026-11-12T12:00:00.000Z')
		expect(NOW.toISOString()).toBe('2026-10-22T12:00:00.000Z')
	})
})

describe('findSentInvitation', () => {
	const lookup = (
		fetchPage: ReturnType<typeof pagedList>,
		caches: SentListCaches,
		invitationId: string,
		nowMs = NOW.getTime(),
	) => findSentInvitation({ accountKey: 'acc-1', invitationId, nowMs, fetchPage, caches })

	it('pages the list until it finds the id and reads nothing after that', async () => {
		const fetchPage = pagedList(250)
		const found = await lookup(fetchPage, new Map(), 'i-120')
		expect(found?.invitation_id).toBe('i-120')
		expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 100])
	})

	it('reads the whole list and returns null for an id that is not in it', async () => {
		const fetchPage = pagedList(250)
		expect(await lookup(fetchPage, new Map(), 'received-from-someone')).toBeNull()
		expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 100, 200])
	})

	it('answers a second lookup from the cache without calling Unipile', async () => {
		const fetchPage = pagedList(250)
		const caches: SentListCaches = new Map()
		await lookup(fetchPage, caches, 'i-120')
		await lookup(fetchPage, caches, 'i-5', NOW.getTime() + 9 * MINUTE)
		expect(fetchPage).toHaveBeenCalledTimes(2)
	})

	it('continues from where the cached read stopped when the next id is further down', async () => {
		const fetchPage = pagedList(250)
		const caches: SentListCaches = new Map()
		await lookup(fetchPage, caches, 'i-5')
		const found = await lookup(fetchPage, caches, 'i-205', NOW.getTime() + MINUTE)
		expect(found?.invitation_id).toBe('i-205')
		expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 100, 200])
	})

	it('starts over from the first page once the cache is 10 minutes old', async () => {
		const fetchPage = pagedList(250)
		const caches: SentListCaches = new Map()
		await lookup(fetchPage, caches, 'i-5')
		await lookup(fetchPage, caches, 'i-5', NOW.getTime() + 10 * MINUTE)
		expect(fetchPage.mock.calls.map((c) => c[0])).toEqual([0, 0])
	})

	it('keeps one cache per account', async () => {
		const fetchPage = pagedList(10)
		const caches: SentListCaches = new Map()
		await findSentInvitation({
			accountKey: 'acc-1',
			invitationId: 'i-1',
			nowMs: NOW.getTime(),
			fetchPage,
			caches,
		})
		await findSentInvitation({
			accountKey: 'acc-2',
			invitationId: 'i-1',
			nowMs: NOW.getTime(),
			fetchPage,
			caches,
		})
		expect(fetchPage).toHaveBeenCalledTimes(2)
	})

	it('forgets an invitation once it has been withdrawn', async () => {
		const fetchPage = pagedList(10)
		const caches: SentListCaches = new Map()
		await findSentInvitation({
			accountKey: 'acc-1',
			invitationId: 'i-1',
			nowMs: NOW.getTime(),
			fetchPage,
			caches,
		})
		forgetSentInvitation('acc-1', 'i-1', caches)
		// The cached read already reached the end of the short list, so the id is simply gone.
		const again = await findSentInvitation({
			accountKey: 'acc-1',
			invitationId: 'i-1',
			nowMs: NOW.getTime() + MINUTE,
			fetchPage,
			caches,
		})
		expect(again).toBeNull()
		expect(fetchPage).toHaveBeenCalledTimes(1)
	})

	it('hands every page it reads to onPage', async () => {
		const fetchPage = pagedList(250)
		const onPage = vi.fn(async () => {})
		await findSentInvitation({
			accountKey: 'acc-1',
			invitationId: 'i-120',
			nowMs: NOW.getTime(),
			fetchPage,
			onPage,
			caches: new Map(),
		})
		expect(onPage).toHaveBeenCalledTimes(2)
	})
})
