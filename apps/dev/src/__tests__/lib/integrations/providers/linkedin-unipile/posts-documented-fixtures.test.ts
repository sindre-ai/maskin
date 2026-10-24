import { describe, expect, it } from 'vitest'
import companyProfile from '../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__/documented/company-profile.json'
import profileByHandle from '../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__/documented/profile.by-handle.json'
import companyPosts from '../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__/documented/user-posts.company.json'
import personPosts from '../../../../../lib/integrations/providers/linkedin-unipile/__fixtures__/documented/user-posts.person.json'
import { createPostsReadsClient } from '../../../../../lib/integrations/providers/linkedin-unipile/posts-reads'
import {
	type PostsToolDeps,
	getCompany,
	listUserPosts,
} from '../../../../../lib/integrations/providers/linkedin-unipile/posts-tools'
import {
	createLinkedInHttpCall,
	createLinkedInHttpClient,
} from '../../../../../lib/integrations/providers/linkedin-unipile/unipile-client'

/**
 * Unipile response bodies that are documented, not recorded: written from the v2 reference
 * pages, never captured from a live account (see __fixtures__/documented/README.md). They check
 * that our mapping reads those shapes and that the calls go out in the right order. They are not
 * evidence of what LinkedIn returns.
 */

const PERSON_ID = personPosts.data[0]?.author.id as string

/** Answers the documented routes from the fixtures and records every request path. */
function fixtureFetch() {
	const requests: string[] = []
	const json = (body: unknown) =>
		new Response(JSON.stringify(body), {
			status: 200,
			headers: { 'content-type': 'application/json' },
		})
	const fetchImpl = (async (url: string | URL | Request) => {
		const path = new URL(String(url)).pathname
		requests.push(path)
		if (path === `/v2/acc/users/${PERSON_ID}/posts`) return json(personPosts)
		if (path === '/v2/acc/users/1234567/posts') return json(companyPosts)
		if (path === '/v2/acc/users/adalovelace') return json(profileByHandle)
		if (path.startsWith('/v2/acc/linkedin/company/')) return json(companyProfile)
		return new Response('{}', { status: 404 })
	}) as typeof fetch
	const options = { baseUrl: 'http://unipile.test', apiKey: 'k', fetchImpl }
	const http = createLinkedInHttpClient(options)
	const deps: PostsToolDeps = {
		accountId: 'acc',
		posts: createPostsReadsClient(createLinkedInHttpCall(options)),
		getProfile: async (identifier) =>
			(await http.getProfile({ account_id: 'acc', identifier })).body as Record<string, unknown>,
		lookup: (_tool, run) => run(),
		checkLike: async () => ({ already_liked: false }),
	}
	return { deps, requests }
}

describe('documented Unipile bodies', () => {
	it('a provider id goes straight to the posts route', async () => {
		const { deps, requests } = fixtureFetch()
		const out = await listUserPosts(deps, { person: PERSON_ID })
		expect(requests).toEqual([`/v2/acc/users/${PERSON_ID}/posts`])
		expect(out.author).toEqual({
			provider_id: PERSON_ID,
			type: 'individual',
			name: 'Ada Lovelace',
			public_identifier: 'adalovelace',
		})
		expect(out.posts.map((p) => p.post_id)).toEqual(['fixture-post-1', 'fixture-post-2'])
		expect(out.posts[0]).toMatchObject({ reactions: 12, comments: 3, already_liked: false })
		// A repost carries the original author and a reaction already given.
		expect(out.posts[1]).toMatchObject({ is_repost: true, reactions: null, already_liked: true })
		expect(out.next_cursor).toBe('fixture-cursor-2')
	})

	it('a public handle is resolved to a provider id first, then the posts are read', async () => {
		const { deps, requests } = fixtureFetch()
		const out = await listUserPosts(deps, { person: 'adalovelace' })
		expect(requests).toEqual(['/v2/acc/users/adalovelace', `/v2/acc/users/${PERSON_ID}/posts`])
		expect(out.author.provider_id).toBe(PERSON_ID)
	})

	it('a company slug is resolved to its numeric id first, a numeric id is not', async () => {
		const slug = fixtureFetch()
		const bySlug = await listUserPosts(slug.deps, { company: 'analytical-engines' })
		expect(slug.requests).toEqual([
			'/v2/acc/linkedin/company/analytical-engines',
			'/v2/acc/users/1234567/posts',
		])
		expect(bySlug.author).toMatchObject({ provider_id: '1234567', type: 'organization' })
		expect(bySlug.next_cursor).toBeNull()

		const numeric = fixtureFetch()
		await listUserPosts(numeric.deps, { company: '1234567' })
		expect(numeric.requests).toEqual(['/v2/acc/users/1234567/posts'])
	})

	it('maps the documented company profile', async () => {
		const { deps } = fixtureFetch()
		expect(await getCompany(deps, { company: 'analytical-engines' })).toEqual({
			company_id: '1234567',
			name: 'Analytical Engines Ltd',
			public_identifier: 'analytical-engines',
			industry: 'Computer Software',
			size_band: '51-200',
			headcount: 87,
			headquarters: 'London, England, GB',
			website: 'https://analytical.example',
			follower_count: 4200,
			description: 'Mechanical computation.',
			url: 'https://www.linkedin.com/company/analytical-engines',
		})
	})
})
