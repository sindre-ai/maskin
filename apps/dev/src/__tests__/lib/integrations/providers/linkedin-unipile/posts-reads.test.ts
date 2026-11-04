import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	POSTS_READS_AUTHOR_ID,
	POSTS_READS_FIRST_POST_ID,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/handlers/posts-reads'
import {
	type LinkedInMockServer,
	startLinkedInMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import {
	createPostsReadsClient,
	isMemberProviderId,
	normalizeCompanyInput,
	normalizePersonInput,
	toCompanySummary,
	toPostsPage,
} from '../../../../../lib/integrations/providers/linkedin-unipile/posts-reads'
import { createLinkedInHttpCall } from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

let mock: LinkedInMockServer

beforeAll(async () => {
	mock = await startLinkedInMock()
})

afterAll(async () => {
	await mock.close()
})

beforeEach(() => {
	mock.resetInbox()
})

function client() {
	return createPostsReadsClient(
		createLinkedInHttpCall({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
	)
}

const account_id = 'acc_1'

describe('listUserPosts', () => {
	it('GETs /users/{user_id}/posts with no query string by default', async () => {
		await client().listUserPosts({ account_id, user_id: POSTS_READS_AUTHOR_ID })
		const call = mock.inbox().at(-1)
		expect(call?.method).toBe('GET')
		expect(call?.path).toBe(`/v2/acc_1/users/${POSTS_READS_AUTHOR_ID}/posts`)
	})

	it('sends cursor and limit as query params', async () => {
		await client().listUserPosts({
			account_id,
			user_id: POSTS_READS_AUTHOR_ID,
			cursor: 'abc',
			limit: 10,
		})
		expect(mock.inbox().at(-1)?.path).toBe(
			`/v2/acc_1/users/${POSTS_READS_AUTHOR_ID}/posts?cursor=abc&limit=10`,
		)
	})

	it('url-encodes the user id', async () => {
		await client().listUserPosts({ account_id, user_id: 'a/b c' })
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/users/a%2Fb%20c/posts')
	})
})

describe('getCompanyProfile', () => {
	it('GETs /linkedin/company/{company_id} for a numeric id', async () => {
		await client().getCompanyProfile({ account_id, company_id: '1234567' })
		const call = mock.inbox().at(-1)
		expect(call?.method).toBe('GET')
		expect(call?.path).toBe('/v2/acc_1/linkedin/company/1234567')
	})

	it('GETs the same route for a slug', async () => {
		await client().getCompanyProfile({ account_id, company_id: 'analytical-engines' })
		expect(mock.inbox().at(-1)?.path).toBe('/v2/acc_1/linkedin/company/analytical-engines')
	})
})

describe('addPostReaction', () => {
	it('POSTs { reaction: linkedin_like } and nothing else, with the post id unchanged', async () => {
		const res = await client().addPostReaction({ account_id, post_id: POSTS_READS_FIRST_POST_ID })
		expect(res.status).toBe(200)
		const call = mock.inbox().at(-1)
		expect(call?.method).toBe('POST')
		expect(call?.path).toBe(`/v2/acc_1/posts/${POSTS_READS_FIRST_POST_ID}/reactions`)
		expect(call?.body).toEqual({ reaction: 'linkedin_like' })
		expect(call?.body).not.toHaveProperty('react_as')
	})
})

describe('normalizers', () => {
	it('reduces a member URN like get_profile does', () => {
		expect(normalizePersonInput('urn:li:fsd_profile:ACoAAAx')).toBe('ACoAAAx')
		expect(normalizePersonInput(' janedoe ')).toBe('janedoe')
	})

	it('recognises a member provider id', () => {
		expect(isMemberProviderId('ACoAAAx_-1')).toBe(true)
		expect(isMemberProviderId('janedoe')).toBe(false)
	})

	it('reads a company as id, slug or URL', () => {
		expect(normalizeCompanyInput('1234567')).toEqual({ kind: 'id', value: '1234567' })
		expect(normalizeCompanyInput('analytical-engines')).toEqual({
			kind: 'slug',
			value: 'analytical-engines',
		})
		expect(
			normalizeCompanyInput('https://www.linkedin.com/company/analytical-engines/about/?x=1'),
		).toEqual({ kind: 'slug', value: 'analytical-engines' })
		expect(normalizeCompanyInput('https://www.linkedin.com/company/1234567/')).toEqual({
			kind: 'id',
			value: '1234567',
		})
		expect(normalizeCompanyInput('   ')).toBeNull()
		expect(normalizeCompanyInput('https://www.linkedin.com/company/')).toBeNull()
	})
})

describe('response mappers', () => {
	it('maps a posts page from the mock and keeps the Unipile post id unchanged', async () => {
		const res = await client().listUserPosts({ account_id, user_id: POSTS_READS_AUTHOR_ID })
		const page = toPostsPage(res.body, POSTS_READS_AUTHOR_ID)
		expect(page.next_cursor).toBe('page-2')
		expect(page.author).toEqual({
			type: 'individual',
			name: 'Ada Lovelace',
			public_identifier: 'adalovelace',
		})
		expect(page.posts).toHaveLength(2)
		const [first, second] = page.posts
		expect(first).toEqual({
			post_id: POSTS_READS_FIRST_POST_ID,
			posted_at: '2026-10-20T08:00:00.000Z',
			text: 'a'.repeat(500),
			is_repost: false,
			reactions: 12,
			comments: 3,
			already_liked: false,
			url: 'https://www.linkedin.com/posts/adalovelace_mock-1',
		})
		expect(second).toMatchObject({
			is_repost: true,
			reactions: null,
			comments: null,
			already_liked: true,
		})
	})

	it('drops rows with no id and reports an empty last page', () => {
		const page = toPostsPage({ data: [{ text: 'no id' }], next_cursor: null }, 'ACoAAAx')
		expect(page).toEqual({ posts: [], next_cursor: null, author: null })
	})

	it('does not take the author from a repost of someone else', () => {
		const page = toPostsPage(
			{ data: [{ id: 'p1', author: { id: 'ACoOther', display_name: 'Other' } }] },
			'ACoAAAx',
		)
		expect(page.author).toBeNull()
	})

	it('maps a company profile from the mock', async () => {
		const res = await client().getCompanyProfile({ account_id, company_id: '1234567' })
		expect(toCompanySummary(res.body)).toEqual({
			company_id: '1234567',
			name: 'Analytical Engines Ltd',
			public_identifier: 'analytical-engines',
			industry: 'Computer Software',
			size_band: '51-200',
			headcount: 87,
			headquarters: 'London, England, GB',
			website: 'https://analytical.example',
			follower_count: 4200,
			description: 'd'.repeat(500),
			url: 'https://www.linkedin.com/company/analytical-engines',
		})
	})

	it('returns null for a company body without an id', () => {
		expect(toCompanySummary({ name: 'x' })).toBeNull()
	})
})
