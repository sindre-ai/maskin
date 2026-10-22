import type { CapSpec } from './caps'
import { LinkedInIntegrationError } from './errors'
import {
	type CompanySummary,
	type PostAuthor,
	type PostSummary,
	type PostsReadsClient,
	isMemberProviderId,
	normalizeCompanyInput,
	normalizePersonInput,
	toCompanySummary,
	toPostsPage,
} from './posts-reads'

/**
 * list_user_posts, get_company and react_to_post, as plain functions over a
 * client and a few hooks. Credential lookup, retry, the action log and the
 * registration in the MCP server wrap these (see operations.ts and mcp-server.ts);
 * keeping the decisions here makes them testable without a database.
 */

/**
 * The shared profile-view budget: get_profile, list_user_posts and get_company
 * draw on one pool of 100 a day per connected account. The resolution lookups
 * inside list_user_posts are logged as get_profile or get_company rows, so they
 * are in the pool too. Enforced by the action log wrapper from this spec.
 */
export const PROFILE_VIEW_CAP: CapSpec = {
	name: 'profile_views',
	limit: 100,
	tools: ['get_profile', 'list_user_posts', 'get_company'],
}

/** react_to_post: 15 a day per connected account. */
export const REACT_TO_POST_CAP: CapSpec = {
	name: 'react_to_post',
	limit: 15,
	tools: ['react_to_post'],
}

export interface PostsToolDeps {
	accountId: string
	posts: PostsReadsClient
	/** `GET users/{identifier}` body; one call, already wrapped in the retry policy. */
	getProfile(identifier: string): Promise<Record<string, unknown>>
	/**
	 * Runs one resolution lookup as a profile view of its own: it takes a slot from the daily
	 * budget and is logged as a get_profile or get_company row. Throws RATE_LIMITED_LINKEDIN
	 * when the budget is spent, before `run` sends anything.
	 */
	lookup(tool: 'get_profile' | 'get_company', run: () => Promise<PostAuthor>): Promise<PostAuthor>
	/**
	 * The like rules that need the log: refuses (throws) a second like on this author inside
	 * 7 days, and says when this account already liked the post.
	 */
	checkLike(input: {
		post_id: string
		author_provider_id: string
	}): Promise<{ already_liked: boolean }>
}

const DEFAULT_LIMIT = 10
const MAX_LIMIT = 20

function invalid(message: string): LinkedInIntegrationError {
	return new LinkedInIntegrationError('INVALID_INPUT', message)
}

function readString(value: unknown): string | undefined {
	return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

function readLimit(value: unknown): number {
	if (value === undefined || value === null) return DEFAULT_LIMIT
	if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_LIMIT) {
		throw invalid(`limit must be a whole number from 1 to ${MAX_LIMIT}`)
	}
	return value
}

function unrecognised(what: string): LinkedInIntegrationError {
	return new LinkedInIntegrationError(
		'LINKEDIN_UNAVAILABLE',
		`LinkedIn ${what} response had an unrecognised shape`,
	)
}

// ── list_user_posts ─────────────────────────────────────────────────────

export type ListUserPostsInput = {
	person?: unknown
	company?: unknown
	limit?: unknown
	cursor?: unknown
}

export type ListUserPostsResult = {
	author: PostAuthor
	posts: PostSummary[]
	next_cursor: string | null
}

export async function listUserPosts(
	deps: PostsToolDeps,
	input: ListUserPostsInput,
): Promise<ListUserPostsResult> {
	const person = readString(input.person)
	const company = readString(input.company)
	if ((person ? 1 : 0) + (company ? 1 : 0) !== 1) {
		throw invalid('pass exactly one of person or company')
	}
	const limit = readLimit(input.limit)
	const cursor = readString(input.cursor)

	let kind: 'individual' | 'organization'
	let providerId: string
	// Set when the input was a handle or slug and one lookup turned it into a provider id.
	let known: PostAuthor | null = null
	if (person) {
		kind = 'individual'
		providerId = normalizePersonInput(person)
		if (!isMemberProviderId(providerId)) {
			const handle = providerId
			known = await deps.lookup('get_profile', () => resolvePerson(deps, handle))
		}
	} else {
		const ref = normalizeCompanyInput(company as string)
		if (!ref) throw invalid('company must be a numeric id, a slug or a linkedin.com/company URL')
		kind = 'organization'
		providerId = ref.value
		if (ref.kind === 'slug') {
			known = await deps.lookup('get_company', () => resolveCompany(deps, ref.value))
		}
	}
	if (known) providerId = known.provider_id

	const upstream = await deps.posts.listUserPosts({
		account_id: deps.accountId,
		user_id: providerId,
		...(cursor ? { cursor } : {}),
		limit,
	})
	if (!Array.isArray((upstream.body as { data?: unknown } | null)?.data)) {
		throw unrecognised('posts')
	}
	const page = toPostsPage(upstream.body, providerId)
	return {
		author: {
			provider_id: providerId,
			type: known?.type ?? page.author?.type ?? kind,
			name: known?.name ?? page.author?.name ?? null,
			public_identifier: known?.public_identifier ?? page.author?.public_identifier ?? null,
		},
		posts: page.posts,
		next_cursor: page.next_cursor,
	}
}

async function resolvePerson(deps: PostsToolDeps, handle: string): Promise<PostAuthor> {
	const body = await deps.getProfile(handle)
	const id = readString(body.id)
	if (!id) throw unrecognised('profile')
	return {
		provider_id: id,
		type: 'individual',
		name: readString(body.display_name) ?? null,
		public_identifier: readString(body.public_identifier) ?? null,
	}
}

async function resolveCompany(deps: PostsToolDeps, slug: string): Promise<PostAuthor> {
	const res = await deps.posts.getCompanyProfile({ account_id: deps.accountId, company_id: slug })
	const company = toCompanySummary(res.body)
	if (!company) throw unrecognised('company')
	return {
		provider_id: company.company_id,
		type: 'organization',
		name: company.name,
		public_identifier: company.public_identifier,
	}
}

// ── get_company ─────────────────────────────────────────────────────────

export async function getCompany(
	deps: PostsToolDeps,
	input: { company?: unknown },
): Promise<CompanySummary> {
	const raw = readString(input.company)
	if (!raw) throw invalid('company is required')
	const ref = normalizeCompanyInput(raw)
	if (!ref) throw invalid('company must be a numeric id, a slug or a linkedin.com/company URL')
	const res = await deps.posts.getCompanyProfile({
		account_id: deps.accountId,
		company_id: ref.value,
	})
	const company = toCompanySummary(res.body)
	if (!company) throw unrecognised('company')
	return company
}

// ── react_to_post ───────────────────────────────────────────────────────

export type ReactToPostInput = {
	post_id?: unknown
	author_provider_id?: unknown
	reaction?: unknown
}

export type ReactToPostResult = { post_id: string; reaction: 'like'; already_liked: boolean }

export async function reactToPost(
	deps: PostsToolDeps,
	input: ReactToPostInput,
): Promise<ReactToPostResult> {
	const postId = readString(input.post_id)
	if (!postId) throw invalid('post_id is required: use the post_id list_user_posts returned')
	const authorProviderId = readString(input.author_provider_id)
	if (!authorProviderId) {
		throw invalid('author_provider_id is required: use author.provider_id from list_user_posts')
	}
	if (input.reaction !== undefined && input.reaction !== 'like') {
		throw invalid('reaction must be "like"; no other reaction is supported')
	}

	const { already_liked } = await deps.checkLike({
		post_id: postId,
		author_provider_id: authorProviderId,
	})
	if (already_liked) return { post_id: postId, reaction: 'like', already_liked: true }

	await deps.posts.addPostReaction({ account_id: deps.accountId, post_id: postId })
	return { post_id: postId, reaction: 'like', already_liked: false }
}
