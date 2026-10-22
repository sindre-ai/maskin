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
 * client and a guard. Credential lookup, retry and the registration in the MCP
 * server wrap these (see the wiring layer); keeping the decisions here makes
 * them testable without a database.
 *
 * The guard is the seam to the action log and caps (task "Every LinkedIn tool
 * call lands in the permanent action log"): the daily budgets, the per-author
 * rule and the prior-success lookup all live behind it.
 */

export interface LikeReservation {
	/** The like went out: record it so caps and the per-author rule see it. */
	commit(): Promise<void>
	/** The like did not go out: release the slot. */
	abort(error: unknown): Promise<void>
}

export interface PostsToolGuards {
	/**
	 * Spend `count` profile views from the shared daily budget, all or nothing.
	 * Throws RATE_LIMITED_LINKEDIN (with the reset time) when they do not fit;
	 * nothing has been sent at that point.
	 */
	takeProfileViews(count: number): Promise<void>
	/**
	 * Run the like checks in order: flag, daily cap, per-author rule, prior
	 * success on this post. Throws on a refusal. Returns null when this account
	 * already liked the post (nothing to send), else a reservation for the call.
	 */
	reserveLike(input: { post_id: string; author_provider_id: string }): Promise<LikeReservation | null>
}

export interface PostsToolDeps {
	accountId: string
	posts: PostsReadsClient
	/** `GET users/{identifier}` body; one call, already wrapped in the retry policy. */
	getProfile(identifier: string): Promise<Record<string, unknown>>
	guards: PostsToolGuards
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
	// Set when the input is not already a provider id and one lookup is needed.
	let resolve: (() => Promise<PostAuthor>) | null = null
	if (person) {
		kind = 'individual'
		providerId = normalizePersonInput(person)
		if (!isMemberProviderId(providerId)) resolve = () => resolvePerson(deps, providerId)
	} else {
		const ref = normalizeCompanyInput(company as string)
		if (!ref) throw invalid('company must be a numeric id, a slug or a linkedin.com/company URL')
		kind = 'organization'
		providerId = ref.value
		if (ref.kind === 'slug') resolve = () => resolveCompany(deps, ref.value)
	}

	// The resolution lookup is a profile view of its own, so budget for both up
	// front: a call that cannot afford both must not send the first.
	await deps.guards.takeProfileViews(resolve ? 2 : 1)
	const known = resolve ? await resolve() : null
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
	await deps.guards.takeProfileViews(1)
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

	const reservation = await deps.guards.reserveLike({
		post_id: postId,
		author_provider_id: authorProviderId,
	})
	if (!reservation) return { post_id: postId, reaction: 'like', already_liked: true }

	try {
		await deps.posts.addPostReaction({ account_id: deps.accountId, post_id: postId })
	} catch (err) {
		await reservation.abort(err)
		throw err
	}
	await reservation.commit()
	return { post_id: postId, reaction: 'like', already_liked: false }
}
