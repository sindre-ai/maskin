import type { Database } from '@maskin/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { credentialMock } = vi.hoisted(() => ({ credentialMock: vi.fn() }))
vi.mock('../../../../../lib/integrations/lookup', () => ({
	actorScopedProviders: new Set(['linkedin-unipile']),
	getIntegrationCredential: credentialMock,
}))
vi.mock('../../../../../lib/workspace-auth', () => ({ isWorkspaceMember: async () => true }))
vi.mock('../../../../../lib/crypto', () => ({
	decrypt: () => JSON.stringify({ account_id: 'acc_1' }),
	encrypt: (v: string) => v,
}))

import { LinkedInIntegrationError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'
import {
	__setUnipileClientForTests,
	getLinkedInProfile,
	listLinkedInConnections,
	listLinkedInMessages,
	searchLinkedInPeople,
} from '../../../../../lib/integrations/providers/linkedin-unipile/operations'
import { buildPeopleSearchUrl } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * The read tools, checked against payload SHAPES captured from
 * api.unipile.com on 2026-09-04.
 *
 * The structure, field names, key order and id formats are exactly as the live
 * API returned them — that is what these fixtures exist to pin. The identifying
 * values are not: real names and LinkedIn member URNs belong to third parties
 * who have no stake in this repo, so they are replaced with stand-ins of the
 * same shape. Never paste a live capture in unedited.
 *
 * Pinning the real payloads matters more than usual here: three separate bugs
 * in this provider (`data.link`, the `/chats` route, `/users/relations`)
 * shipped green because the mock server agreed with the client while both
 * disagreed with Unipile. A canned response that came from the live API is the
 * only kind that can catch that.
 */

const ctx = { db: {} as Database, actorId: 'actor-1', workspaceId: 'ws-1' }

/** Captured from GET /v2/{acc}/chats/{chat}/messages. */
const LIVE_MESSAGES = {
	data: [
		{
			object: 'Message',
			id: 'CLASSIC_2-MTc4ODQ0NjQ3MTgxNGI3MjQyOS0xMDA=',
			sender_id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx1',
			chat_id: 'CLASSIC_2-MDE0OWM0YjMtOWYxZA==',
			timestamp: '2026-09-03T14:41:11.814Z',
			is_sender: false,
			text: 'Hi there, thanks for connecting!',
		},
	],
	next_cursor: 'cur-msg',
}

/** Captured from GET /v2/{acc}/users/me/relations — person nests under `user`. */
const LIVE_RELATIONS = {
	data: [
		{
			id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx2',
			object: 'UserRelation',
			created_at: '2026-07-02T00:00:00.000Z',
			user: {
				id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx2',
				object: 'User',
				type: 'individual',
				display_name: 'Ada Lovelace',
				first_name: 'Ada',
				last_name: 'Lovelace',
				description: 'Head of Growth',
				public_identifier: 'adalovelace',
				profile_url: 'https://www.linkedin.com/in/adalovelace',
			},
		},
	],
	next_cursor: 'cur-rel',
}

/** Captured from POST /v2/{acc}/linkedin/search — flat, with `headline`. */
const LIVE_SEARCH = {
	data: [
		{
			object: 'PeopleSearchResult',
			id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx3',
			display_name: 'Grace Hopper',
			network_distance: 'SECOND_DEGREE',
			member_id: '100000001',
			public_identifier: 'gracehopper',
			profile_url: 'https://www.linkedin.com/in/gracehopper',
			location: 'Budapest',
			headline: 'Software Engineer',
		},
	],
	next_cursor: 'cur-search',
}

/** Captured from GET /v2/{acc}/users/me. */
const LIVE_PROFILE = {
	id: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx4',
	object: 'UserProfile',
	type: 'individual',
	display_name: 'Alex Rivera',
	public_identifier: 'alexrivera',
	profile_url: 'https://www.linkedin.com/in/alexrivera',
}

type Recorded = { name: string; query: Record<string, unknown> }

function stubClient(response: unknown, status = 200) {
	const calls: Recorded[] = []
	__setUnipileClientForTests(() => {
		const record = (name: string) => async (query: Record<string, unknown>) => {
			calls.push({ name, query })
			return { status, body: response, headers: {} }
		}
		return {
			sendMessage: record('sendMessage'),
			reply: record('reply'),
			listConversations: record('listConversations'),
			listMessages: record('listMessages'),
			listRelations: record('listRelations'),
			searchPeople: record('searchPeople'),
			getProfile: record('getProfile'),
		} as never
	})
	return calls
}

beforeEach(() => {
	credentialMock.mockResolvedValue({
		id: 'int-1',
		actorId: 'actor-1',
		credentials: 'encrypted',
	})
})

afterEach(() => {
	__setUnipileClientForTests(null)
	vi.restoreAllMocks()
})

describe('listLinkedInMessages', () => {
	it('maps the live message payload onto the MCP shape', async () => {
		stubClient(LIVE_MESSAGES)
		const res = await listLinkedInMessages(ctx, { thread_id: 'chat-1' })
		expect(res.messages).toEqual([
			{
				message_id: 'CLASSIC_2-MTc4ODQ0NjQ3MTgxNGI3MjQyOS0xMDA=',
				text: 'Hi there, thanks for connecting!',
				sent_at: '2026-09-03T14:41:11.814Z',
				sender_urn: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx1',
				from_me: false,
			},
		])
		expect(res.next_cursor).toBe('cur-msg')
	})

	// v2 sends is_sender as 0/1 on some payloads and a boolean on others.
	it('reads a numeric is_sender the same as a boolean one', async () => {
		stubClient({ data: [{ id: 'm', text: 't', timestamp: 'x', sender_id: 's', is_sender: 1 }] })
		const res = await listLinkedInMessages(ctx, { thread_id: 'chat-1' })
		expect(res.messages[0].from_me).toBe(true)
	})

	it('rejects a missing thread_id without calling Unipile', async () => {
		const calls = stubClient(LIVE_MESSAGES)
		await expect(listLinkedInMessages(ctx, {})).rejects.toMatchObject({
			code: 'INVALID_INPUT',
		})
		expect(calls).toHaveLength(0)
	})

	// An empty array would be reported to the user as "no messages in this
	// thread", which is a wrong answer rather than a failed call.
	it('throws rather than returning empty when the page shape is unrecognised', async () => {
		stubClient({ unexpected: true })
		await expect(listLinkedInMessages(ctx, { thread_id: 'chat-1' })).rejects.toBeInstanceOf(
			LinkedInIntegrationError,
		)
	})
})

describe('listLinkedInConnections', () => {
	it('unwraps the nested `user` object a relation carries', async () => {
		stubClient(LIVE_RELATIONS)
		const res = await listLinkedInConnections(ctx, {})
		expect(res.people).toEqual([
			{
				recipient_urn: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx2',
				name: 'Ada Lovelace',
				headline: 'Head of Growth',
				profile_url: 'https://www.linkedin.com/in/adalovelace',
				public_identifier: 'adalovelace',
				network_distance: '',
				location: '',
			},
		])
		expect(res.next_cursor).toBe('cur-rel')
	})

	it('calls listRelations, never the profile-lookup route', async () => {
		const calls = stubClient(LIVE_RELATIONS)
		await listLinkedInConnections(ctx, { limit: 10 })
		expect(calls.map((c) => c.name)).toEqual(['listRelations'])
	})
})

describe('searchLinkedInPeople', () => {
	it('maps a live search result, keeping network_distance', async () => {
		stubClient(LIVE_SEARCH)
		const res = await searchLinkedInPeople(ctx, { keywords: 'engineer' })
		expect(res.people[0]).toMatchObject({
			recipient_urn: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx3',
			name: 'Grace Hopper',
			headline: 'Software Engineer',
			// The agent needs this to know a 2nd-degree person usually cannot
			// be DM'd without an invitation first.
			network_distance: 'SECOND_DEGREE',
		})
	})

	it('builds the LinkedIn search URL from plain keywords', async () => {
		const calls = stubClient(LIVE_SEARCH)
		await searchLinkedInPeople(ctx, { keywords: 'product manager oslo' })
		expect(calls[0].query.keywords).toBe('product manager oslo')
		expect(buildPeopleSearchUrl('product manager oslo')).toBe(
			'https://www.linkedin.com/search/results/people/?keywords=product%20manager%20oslo',
		)
	})

	it('requires keywords or search_url', async () => {
		const calls = stubClient(LIVE_SEARCH)
		await expect(searchLinkedInPeople(ctx, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(calls).toHaveLength(0)
	})

	// search_url is caller-supplied and rides a request made with the
	// customer's credential — it must not become a way to point that request
	// at another host.
	it('refuses a search_url that is not on linkedin.com', async () => {
		const calls = stubClient(LIVE_SEARCH)
		await expect(
			searchLinkedInPeople(ctx, { search_url: 'https://evil.example.com/harvest' }),
		).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(calls).toHaveLength(0)
	})

	it('accepts a genuine linkedin.com search URL', async () => {
		const calls = stubClient(LIVE_SEARCH)
		await searchLinkedInPeople(ctx, {
			search_url: 'https://www.linkedin.com/search/results/people/?keywords=cto&geoUrn=123',
		})
		expect(calls[0].query.url).toContain('geoUrn=123')
	})
})

describe('getLinkedInProfile', () => {
	it('maps a live profile payload', async () => {
		stubClient(LIVE_PROFILE)
		const person = await getLinkedInProfile(ctx, { identifier: 'me' })
		expect(person).toMatchObject({
			recipient_urn: 'ACoAAAxxxxxBxxxxxxxxxxxxxxxxxxxxxxxxxx4',
			name: 'Alex Rivera',
			public_identifier: 'alexrivera',
		})
	})

	it('requires an identifier', async () => {
		const calls = stubClient(LIVE_PROFILE)
		await expect(getLinkedInProfile(ctx, {})).rejects.toMatchObject({ code: 'INVALID_INPUT' })
		expect(calls).toHaveLength(0)
	})

	it('throws when the profile has no id to act on', async () => {
		stubClient({ object: 'UserProfile', display_name: 'No Id' })
		await expect(getLinkedInProfile(ctx, { identifier: 'x' })).rejects.toBeInstanceOf(
			LinkedInIntegrationError,
		)
	})
})

describe('credential errors surface unchanged on the read tools', () => {
	it('reports CREDENTIAL_NOT_CONNECTED when the workspace has no identity', async () => {
		credentialMock.mockResolvedValue(null)
		stubClient(LIVE_SEARCH)
		await expect(searchLinkedInPeople(ctx, { keywords: 'x' })).rejects.toMatchObject({
			code: 'CREDENTIAL_NOT_CONNECTED',
		})
	})
})
