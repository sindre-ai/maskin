import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
	POSTS_READS_AUTHOR_ID,
	POSTS_READS_FIRST_POST_ID,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/handlers/posts-reads'
import {
	type LinkedInMockServer,
	startLinkedInMock,
} from '../../../../../lib/integrations/providers/linkedin-unipile/__mocks__/unipile-server'
import { LinkedInIntegrationError } from '../../../../../lib/integrations/providers/linkedin-unipile/errors'
import { createPostsReadsClient } from '../../../../../lib/integrations/providers/linkedin-unipile/posts-reads'
import {
	type PostsToolDeps,
	getCompany,
	listUserPosts,
	reactToPost,
} from '../../../../../lib/integrations/providers/linkedin-unipile/posts-tools'
import {
	createLinkedInHttpCall,
	createLinkedInHttpClient,
} from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

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

const account_id = 'acc_1'

type Hooks = Pick<PostsToolDeps, 'lookup' | 'checkLike'>

/**
 * The hooks the action log provides in production, as spies: `lookups` records each resolution
 * lookup that took a profile view, `likes` each like check. Real budget and rule behaviour is
 * covered against Postgres in integration/linkedin-posts-tools.test.ts.
 */
function fakeHooks(overrides: Partial<Hooks> = {}): Hooks & { lookups: string[]; likes: string[] } {
	const lookups: string[] = []
	const likes: string[] = []
	return {
		lookups,
		likes,
		lookup: async (tool, run) => {
			lookups.push(tool)
			return run()
		},
		checkLike: async (input) => {
			likes.push(input.post_id)
			return { already_liked: false }
		},
		...overrides,
	}
}

function depsFor(hooks: Hooks): PostsToolDeps {
	const call = createLinkedInHttpCall({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
	const http = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
	return {
		accountId: account_id,
		posts: createPostsReadsClient(call),
		getProfile: async (identifier) =>
			(await http.getProfile({ account_id, identifier })).body as Record<string, unknown>,
		...hooks,
	}
}

const paths = () => mock.inbox().map((c) => `${c.method} ${c.path}`)

async function rejection(p: Promise<unknown>): Promise<LinkedInIntegrationError> {
	try {
		await p
	} catch (err) {
		expect(err).toBeInstanceOf(LinkedInIntegrationError)
		return err as LinkedInIntegrationError
	}
	throw new Error('expected a rejection')
}

describe('list_user_posts', () => {
	it('takes exactly one of person or company', async () => {
		const deps = depsFor(fakeHooks())
		expect((await rejection(listUserPosts(deps, {}))).code).toBe('INVALID_INPUT')
		expect(
			(await rejection(listUserPosts(deps, { person: 'janedoe', company: 'acme' }))).code,
		).toBe('INVALID_INPUT')
		expect(mock.inbox()).toHaveLength(0)
	})

	it('rejects a limit outside 1 to 20', async () => {
		const deps = depsFor(fakeHooks())
		for (const limit of [0, 21, 1.5, '5']) {
			expect(
				(await rejection(listUserPosts(deps, { person: POSTS_READS_AUTHOR_ID, limit }))).code,
			).toBe('INVALID_INPUT')
		}
	})

	it('uses a provider id directly: no resolution lookup, limit defaults to 10', async () => {
		const hooks = fakeHooks()
		const out = await listUserPosts(depsFor(hooks), { person: POSTS_READS_AUTHOR_ID })
		expect(hooks.lookups).toEqual([])
		expect(paths()).toEqual([`GET /v2/acc_1/users/${POSTS_READS_AUTHOR_ID}/posts?limit=10`])
		expect(out.author).toEqual({
			provider_id: POSTS_READS_AUTHOR_ID,
			type: 'individual',
			name: 'Ada Lovelace',
			public_identifier: 'adalovelace',
		})
		expect(out.next_cursor).toBe('page-2')
		expect(out.posts.map((p) => p.post_id)).toEqual(['mock-post-1', 'mock-post-2'])
	})

	it('resolves a public handle with one get_profile lookup that takes its own view', async () => {
		const hooks = fakeHooks()
		const out = await listUserPosts(depsFor(hooks), { person: 'gracehopper', limit: 5 })
		expect(hooks.lookups).toEqual(['get_profile'])
		expect(paths()).toEqual([
			'GET /v2/acc_1/users/gracehopper',
			'GET /v2/acc_1/users/mock-user-2/posts?limit=5',
		])
		expect(out.author).toMatchObject({
			provider_id: 'mock-user-2',
			type: 'individual',
			name: 'Grace Hopper',
			public_identifier: 'gracehopper',
		})
	})

	it('reduces a member URN before deciding whether to resolve', async () => {
		const hooks = fakeHooks()
		await listUserPosts(depsFor(hooks), { person: `urn:li:fsd_profile:${POSTS_READS_AUTHOR_ID}` })
		expect(hooks.lookups).toEqual([])
		expect(paths()).toEqual([`GET /v2/acc_1/users/${POSTS_READS_AUTHOR_ID}/posts?limit=10`])
	})

	it('passes the cursor through', async () => {
		await listUserPosts(depsFor(fakeHooks()), {
			person: POSTS_READS_AUTHOR_ID,
			cursor: 'page-2',
			limit: 20,
		})
		expect(paths()).toEqual([
			`GET /v2/acc_1/users/${POSTS_READS_AUTHOR_ID}/posts?cursor=page-2&limit=20`,
		])
	})

	it('uses a numeric company id directly', async () => {
		const hooks = fakeHooks()
		const out = await listUserPosts(depsFor(hooks), { company: '1234567' })
		expect(hooks.lookups).toEqual([])
		expect(paths()).toEqual(['GET /v2/acc_1/users/1234567/posts?limit=10'])
		expect(out.author.provider_id).toBe('1234567')
		expect(out.author.type).toBe('organization')
	})

	it('resolves a company slug or URL with one get_company lookup that takes its own view', async () => {
		const hooks = fakeHooks()
		const out = await listUserPosts(depsFor(hooks), {
			company: 'https://www.linkedin.com/company/analytical-engines/',
		})
		expect(hooks.lookups).toEqual(['get_company'])
		expect(paths()).toEqual([
			'GET /v2/acc_1/linkedin/company/analytical-engines',
			'GET /v2/acc_1/users/1234567/posts?limit=10',
		])
		expect(out.author).toEqual({
			provider_id: '1234567',
			type: 'organization',
			name: 'Analytical Engines Ltd',
			public_identifier: 'analytical-engines',
		})
	})

	it('sends nothing when the budget refuses the lookup', async () => {
		const refuse = new LinkedInIntegrationError(
			'RATE_LIMITED_LINKEDIN',
			'profile-view budget used up, resets 2026-10-23T08:00:00Z',
		)
		const hooks = fakeHooks({
			lookup: async () => {
				throw refuse
			},
		})
		expect(await rejection(listUserPosts(depsFor(hooks), { person: 'gracehopper' }))).toBe(refuse)
		expect(mock.inbox()).toHaveLength(0)
	})
})

describe('get_company', () => {
	it('returns the summary for a slug', async () => {
		const out = await getCompany(depsFor(fakeHooks()), { company: 'analytical-engines' })
		expect(paths()).toEqual(['GET /v2/acc_1/linkedin/company/analytical-engines'])
		expect(out).toMatchObject({
			company_id: '1234567',
			size_band: '51-200',
			headquarters: 'London, England, GB',
			follower_count: 4200,
		})
	})

	it('reduces a company URL to the slug', async () => {
		await getCompany(depsFor(fakeHooks()), {
			company: 'https://www.linkedin.com/company/analytical-engines/about/',
		})
		expect(paths()).toEqual(['GET /v2/acc_1/linkedin/company/analytical-engines'])
	})

	it('refuses an empty company and sends nothing', async () => {
		expect((await rejection(getCompany(depsFor(fakeHooks()), { company: '  ' }))).code).toBe(
			'INVALID_INPUT',
		)
		expect(mock.inbox()).toHaveLength(0)
	})
})

describe('react_to_post', () => {
	const input = { post_id: POSTS_READS_FIRST_POST_ID, author_provider_id: POSTS_READS_AUTHOR_ID }

	it('checks the like rules, then sends { reaction: linkedin_like }', async () => {
		const hooks = fakeHooks()
		const out = await reactToPost(depsFor(hooks), input)
		expect(out).toEqual({ post_id: 'mock-post-1', reaction: 'like', already_liked: false })
		expect(hooks.likes).toEqual(['mock-post-1'])
		expect(mock.inbox().at(-1)).toMatchObject({
			method: 'POST',
			path: '/v2/acc_1/posts/mock-post-1/reactions',
			body: { reaction: 'linkedin_like' },
		})
	})

	it('returns already_liked and makes no call when the rules say it was already liked', async () => {
		const hooks = fakeHooks({ checkLike: async () => ({ already_liked: true }) })
		const out = await reactToPost(depsFor(hooks), input)
		expect(out).toEqual({ post_id: 'mock-post-1', reaction: 'like', already_liked: true })
		expect(mock.inbox()).toHaveLength(0)
	})

	it('accepts only like', async () => {
		const deps = depsFor(fakeHooks())
		for (const reaction of ['celebrate', 'linkedin_like', 'LIKE', 1]) {
			expect((await rejection(reactToPost(deps, { ...input, reaction }))).code).toBe(
				'INVALID_INPUT',
			)
		}
		await reactToPost(deps, { ...input, reaction: 'like' })
		expect(mock.inbox()).toHaveLength(1)
	})

	it('requires post_id and author_provider_id and checks nothing without them', async () => {
		const hooks = fakeHooks()
		const deps = depsFor(hooks)
		await rejection(reactToPost(deps, { author_provider_id: POSTS_READS_AUTHOR_ID }))
		await rejection(reactToPost(deps, { post_id: POSTS_READS_FIRST_POST_ID }))
		expect(hooks.likes).toEqual([])
	})

	it('lets a refusal from the rules through and sends nothing', async () => {
		const refuse = new LinkedInIntegrationError('INVALID_INPUT', 'one like per author per 7 days')
		const deps = depsFor(
			fakeHooks({
				checkLike: async () => {
					throw refuse
				},
			}),
		)
		expect(await rejection(reactToPost(deps, input))).toBe(refuse)
		expect(mock.inbox()).toHaveLength(0)
	})
})

// Unipile uses its own post ids everywhere except Get a Post. The id list_user_posts
// returns must reach react_to_post and read_post_comments unchanged, in the path.
describe('chained post id', () => {
	it('sends the post_id list_user_posts returned to react_to_post and read_post_comments', async () => {
		const deps = depsFor(fakeHooks())
		const listed = await listUserPosts(deps, { person: POSTS_READS_AUTHOR_ID })
		const post = listed.posts[0]
		expect(post?.post_id).toBe('mock-post-1')
		mock.resetInbox()

		await reactToPost(deps, {
			post_id: post?.post_id,
			author_provider_id: listed.author.provider_id,
		})
		const http = createLinkedInHttpClient({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' })
		const comments = await http.readPostComments({
			account_id,
			post_id: post?.post_id as string,
		})

		expect(paths()).toEqual([
			'POST /v2/acc_1/posts/mock-post-1/reactions',
			'GET /v2/acc_1/posts/mock-post-1/comments',
		])
		// The mock answers 400 to the comments route for any id but the one a list or
		// get-a-post response carries, so a 200 here is the proof.
		expect(comments.status).toBe(200)
	})

	it('the mock refuses a native activity id on the reaction route', async () => {
		const http = createPostsReadsClient(
			createLinkedInHttpCall({ baseUrl: mock.baseUrl, apiKey: 'test-api-key' }),
		)
		const res = await http.addPostReaction({
			account_id,
			post_id: 'urn:li:activity:7000000000000000000',
		})
		expect(res.status).toBe(400)
	})
})
