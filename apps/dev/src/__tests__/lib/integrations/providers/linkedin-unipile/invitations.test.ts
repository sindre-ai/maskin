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

import { LinkedInIntegrationError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'
import {
	cancelRelationRequestPath,
	inviteAgeDays,
	listRelationRequestsPath,
	nextSentOffset,
	parseSentInvitations,
} from '../../../../../lib/integrations/providers/linkedin-unipile/invitations'
import {
	__setLinkedInClientForTests,
	listLinkedInSentInvitations,
} from '../../../../../lib/integrations/providers/linkedin-unipile/operations'
import { createLinkedInHttpClient } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * The sent-invitations payload below follows the Unipile v2 reference for
 * GET /v2/{account_id}/users/me/relation-requests?type=sent: rows of
 * { id, type, created_at (optional), message, user: { id, public_identifier, display_name,
 * description, profile_url } } inside { data, total_count }. It is NOT a live capture, and the
 * names are stand-ins. Whether sent invitations really carry created_at is the open question
 * the first-hour probe on the action log task answers; replace this fixture with that capture.
 */
const DAY = 24 * 60 * 60 * 1000
const NOW = new Date('2026-10-22T12:00:00.000Z')
const daysAgo = (days: number, extraHours = 0) =>
	new Date(NOW.getTime() - days * DAY - extraHours * 60 * 60 * 1000).toISOString()

function row(id: string, createdAt: string | undefined, extra: Record<string, unknown> = {}) {
	return {
		object: 'RelationRequest',
		id,
		type: 'sent',
		...(createdAt === undefined ? {} : { created_at: createdAt }),
		message: 'Hi, would like to connect',
		user: {
			id: `ACoAA-${id}`,
			object: 'User',
			public_identifier: `person-${id}`,
			display_name: `Person ${id}`,
			description: 'Head of Growth',
			profile_url: `https://www.linkedin.com/in/person-${id}`,
		},
		...extra,
	}
}

const ctx = { db: {} as Database, actorId: 'actor-1', workspaceId: 'ws-1' }

describe('relation-requests client routes', () => {
	function clientWith(response: unknown = {}) {
		const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response), { status: 200 }))
		const client = createLinkedInHttpClient({
			baseUrl: 'https://unipile.test',
			apiKey: 'k',
			fetchImpl: fetchImpl as never,
		})
		return { client, fetchImpl }
	}

	it('GETs the sent list with type, offset and limit in the query', async () => {
		const { client, fetchImpl } = clientWith({ data: [] })
		await client.listRelationRequests({ account_id: 'acc_1', offset: 100, limit: 50 })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe(
			'https://unipile.test/v2/acc_1/users/me/relation-requests?type=sent&offset=100&limit=50',
		)
		expect(init.method).toBe('GET')
	})

	it('asks for type=sent even when no paging is given', () => {
		expect(listRelationRequestsPath({ account_id: 'acc_1' })).toBe(
			'/v2/acc_1/users/me/relation-requests?type=sent',
		)
	})

	it('keeps offset 0 in the query instead of dropping it', () => {
		expect(listRelationRequestsPath({ account_id: 'acc_1', offset: 0, limit: 1 })).toBe(
			'/v2/acc_1/users/me/relation-requests?type=sent&offset=0&limit=1',
		)
	})

	it('POSTs the cancel route for one request id, with no body', async () => {
		const { client, fetchImpl } = clientWith({ object: 'RelationRequestCanceled' })
		await client.cancelRelationRequest({ account_id: 'acc_1', request_id: 'req_9' })
		const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit]
		expect(url).toBe('https://unipile.test/v2/acc_1/users/me/relation-requests/req_9/cancel')
		expect(init.method).toBe('POST')
		expect(init.body).toBeUndefined()
	})

	it('url-encodes the account and request ids in the paths', () => {
		expect(cancelRelationRequestPath({ account_id: 'acc/1', request_id: 'a b/c' })).toBe(
			'/v2/acc%2F1/users/me/relation-requests/a%20b%2Fc/cancel',
		)
		expect(listRelationRequestsPath({ account_id: 'acc/1' })).toContain('/v2/acc%2F1/')
	})
})

describe('inviteAgeDays', () => {
	it('counts whole days, rounding down: 13 days 23 hours is 13, 14 days 0 hours is 14', () => {
		expect(inviteAgeDays(daysAgo(13, 23), NOW)).toBe(13)
		expect(inviteAgeDays(daysAgo(14), NOW)).toBe(14)
	})

	it('is null when there is no date', () => {
		expect(inviteAgeDays(null, NOW)).toBeNull()
	})

	it('treats a date in the future as 0 days old', () => {
		expect(inviteAgeDays(daysAgo(-3), NOW)).toBe(0)
	})
})

describe('parseSentInvitations', () => {
	it('maps a row onto the tool shape, reading the person from user', () => {
		const sentAt = daysAgo(20)
		const page = parseSentInvitations({ data: [row('r1', sentAt)], total_count: 7 }, NOW)
		expect(page).toEqual({
			invitations: [
				{
					invitation_id: 'r1',
					recipient_provider_id: 'ACoAA-r1',
					public_identifier: 'person-r1',
					name: 'Person r1',
					headline: 'Head of Growth',
					sent_at: sentAt,
					age_days: 20,
					message: 'Hi, would like to connect',
				},
			],
			row_count: 1,
			total: 7,
		})
	})

	it('gives sent_at and age_days as null when LinkedIn sent no date', () => {
		const [inv] = parseSentInvitations({ data: [row('r1', undefined)] }, NOW).invitations
		expect(inv?.sent_at).toBeNull()
		expect(inv?.age_days).toBeNull()
	})

	it('treats a date that does not parse as no date, never as an old one', () => {
		const [inv] = parseSentInvitations({ data: [row('r1', 'not-a-date')] }, NOW).invitations
		expect(inv?.sent_at).toBeNull()
		expect(inv?.age_days).toBeNull()
	})

	it('drops a row with no id but still counts it, because the offset moves by rows returned', () => {
		const page = parseSentInvitations({ data: [{ type: 'sent' }, row('r2', daysAgo(1))] }, NOW)
		expect(page.invitations.map((i) => i.invitation_id)).toEqual(['r2'])
		expect(page.row_count).toBe(2)
	})

	it('answers an empty page for a body it does not recognise', () => {
		for (const body of [null, 'oops', {}, { data: 'x' }]) {
			expect(parseSentInvitations(body, NOW)).toEqual({
				invitations: [],
				row_count: 0,
				total: null,
			})
		}
	})

	it('ignores a total_count that is not a count', () => {
		expect(parseSentInvitations({ data: [], total_count: 'many' }, NOW).total).toBeNull()
		expect(parseSentInvitations({ data: [], total_count: -1 }, NOW).total).toBeNull()
	})
})

describe('nextSentOffset', () => {
	it('with a total: moves on while rows remain, null at the end', () => {
		expect(nextSentOffset(0, 50, { row_count: 50, total: 120 })).toBe(50)
		expect(nextSentOffset(100, 50, { row_count: 20, total: 120 })).toBeNull()
		expect(nextSentOffset(0, 50, { row_count: 50, total: 50 })).toBeNull()
	})

	it('without a total: a full page may have more, a short page is the last', () => {
		expect(nextSentOffset(0, 50, { row_count: 50, total: null })).toBe(50)
		expect(nextSentOffset(50, 50, { row_count: 12, total: null })).toBeNull()
	})

	it('is null for an empty page', () => {
		expect(nextSentOffset(0, 50, { row_count: 0, total: null })).toBeNull()
		expect(nextSentOffset(0, 50, { row_count: 0, total: 9 })).toBeNull()
	})
})

describe('listLinkedInSentInvitations', () => {
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
					listRelationRequests: async (query: Record<string, unknown>) => {
						calls.push(query)
						return { status, body, headers: {} }
					},
				}) as never,
		)
		return calls
	}
	const now = () => NOW

	const MIXED = {
		data: [
			row('old', daysAgo(30)),
			row('edge', daysAgo(14)),
			row('young', daysAgo(13, 23)),
			row('undated', undefined),
		],
		total_count: 4,
	}

	it('asks for 50 rows from offset 0 by default', async () => {
		const calls = stub(200, MIXED)
		await listLinkedInSentInvitations(ctx, {}, now)
		expect(calls).toEqual([{ account_id: 'acc_1', offset: 0, limit: 50 }])
	})

	it('passes limit and offset through', async () => {
		const calls = stub(200, MIXED)
		await listLinkedInSentInvitations(ctx, { limit: 100, offset: 200 }, now)
		expect(calls).toEqual([{ account_id: 'acc_1', offset: 200, limit: 100 }])
	})

	it('returns every row, with total_pending, a null next_offset on the last page and the undated count', async () => {
		stub(200, MIXED)
		const res = await listLinkedInSentInvitations(ctx, {}, now)
		expect(res.invitations.map((i) => i.invitation_id)).toEqual(['old', 'edge', 'young', 'undated'])
		expect(res.total_pending).toBe(4)
		expect(res.next_offset).toBeNull()
		expect(res.rows_without_date).toBe(1)
	})

	it('older_than_days keeps rows at least that old and never matches a row with no date', async () => {
		stub(200, MIXED)
		const res = await listLinkedInSentInvitations(ctx, { older_than_days: 14 }, now)
		expect(res.invitations.map((i) => i.invitation_id)).toEqual(['old', 'edge'])
		expect(res.rows_without_date).toBe(1)
	})

	it('older_than_days 0 still skips the undated row', async () => {
		stub(200, MIXED)
		const res = await listLinkedInSentInvitations(ctx, { older_than_days: 0 }, now)
		expect(res.invitations.map((i) => i.invitation_id)).not.toContain('undated')
		expect(res.invitations).toHaveLength(3)
	})

	it('moves next_offset by the rows LinkedIn returned, not the rows the filter kept', async () => {
		stub(200, { data: [row('a', daysAgo(1)), row('b', daysAgo(2))], total_count: 10 })
		const res = await listLinkedInSentInvitations(
			ctx,
			{ limit: 2, offset: 4, older_than_days: 30 },
			now,
		)
		expect(res.invitations).toEqual([])
		expect(res.next_offset).toBe(6)
		expect(res.total_pending).toBe(10)
	})

	it('reports a null total_pending when LinkedIn sent none', async () => {
		stub(200, { data: [row('a', daysAgo(1))] })
		const res = await listLinkedInSentInvitations(ctx, {}, now)
		expect(res.total_pending).toBeNull()
		expect(res.next_offset).toBeNull()
	})

	it.each([
		['limit', { limit: 0 }],
		['limit', { limit: 101 }],
		['limit', { limit: 1.5 }],
		['limit', { limit: '10' }],
		['offset', { offset: -1 }],
		['offset', { offset: 0.5 }],
		['older_than_days', { older_than_days: -1 }],
		['older_than_days', { older_than_days: 2.5 }],
	])('refuses a bad %s with INVALID_INPUT and calls nothing', async (field, input) => {
		const calls = stub(200, MIXED)
		const err = await listLinkedInSentInvitations(ctx, input, now).catch((e) => e)
		expect(err).toBeInstanceOf(LinkedInIntegrationError)
		expect(err.code).toBe('INVALID_INPUT')
		expect(err.message).toContain(field)
		expect(calls).toEqual([])
	})

	it('surfaces a LinkedIn error from the list call', async () => {
		stub(401, { error_code: 'unauthorized' })
		await expect(listLinkedInSentInvitations(ctx, {}, now)).rejects.toBeInstanceOf(
			LinkedInIntegrationError,
		)
	})
})
