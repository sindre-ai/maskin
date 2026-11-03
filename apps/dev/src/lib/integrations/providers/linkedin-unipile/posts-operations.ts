import type { ActionLogContext } from './action-log'
import { LinkedInIntegrationError } from './errors'
import { checkLikeRules } from './like-rules'
import {
	type LinkedInOperationContext,
	buildLinkedInClient,
	callLinkedInWithRetry,
	preamble,
} from './operations'
import { type CompanySummary, type PostsReadsClient, createPostsReadsClient } from './posts-reads'
import {
	type ListUserPostsInput,
	type ListUserPostsResult,
	type PostsToolDeps,
	type ReactToPostInput,
	type ReactToPostResult,
	getCompany,
	listUserPosts,
	reactToPost,
} from './posts-tools'
import { createLinkedInHttpCall } from './unipile-client'

/**
 * list_user_posts, get_company and react_to_post as operations: the credential lookup and the
 * retry policy around the plain functions in posts-tools.ts. The action log, the caps and the
 * registration are the MCP server's (mcp-server.ts).
 */

function buildPostsReadsClient(): PostsReadsClient {
	const baseUrl = process.env.UNIPILE_BASE_URL
	const apiKey = process.env.UNIPILE_API_KEY
	if (!baseUrl || !apiKey) {
		throw new LinkedInIntegrationError(
			'LINKEDIN_UNAVAILABLE',
			'LinkedIn client is not configured (missing UNIPILE_BASE_URL or UNIPILE_API_KEY)',
		)
	}
	const raw = createPostsReadsClient(createLinkedInHttpCall({ baseUrl, apiKey }))
	return {
		listUserPosts: (query) => callLinkedInWithRetry(() => raw.listUserPosts(query)),
		getCompanyProfile: (query) => callLinkedInWithRetry(() => raw.getCompanyProfile(query)),
		// A 5xx on a like may still have liked the post, so it is never replayed.
		addPostReaction: (payload) =>
			callLinkedInWithRetry(() => raw.addPostReaction(payload), { mutating: true }),
	}
}

async function postsToolDeps(
	ctx: LinkedInOperationContext,
	hooks: Pick<PostsToolDeps, 'lookup' | 'checkLike'>,
): Promise<PostsToolDeps> {
	const pre = await preamble(ctx.db, ctx.actorId, ctx.workspaceId, { identity: ctx.identity })
	if (!pre.ok) throw pre.error
	const client = buildLinkedInClient(pre.credentials)
	const accountId = pre.credentials.account_id
	return {
		accountId,
		posts: buildPostsReadsClient(),
		getProfile: async (identifier) =>
			(
				await callLinkedInWithRetry<Record<string, unknown>>(() =>
					client.getProfile({ account_id: accountId, identifier }),
				)
			).body,
		...hooks,
	}
}

/**
 * The profile-view budget is spent by the caller's own log row (`list_user_posts`); a handle
 * or slug that needs a lookup first spends one more through `lookup`.
 */
export async function listLinkedInUserPosts(
	ctx: LinkedInOperationContext,
	input: ListUserPostsInput,
	lookup: PostsToolDeps['lookup'],
): Promise<ListUserPostsResult> {
	return listUserPosts(await postsToolDeps(ctx, { lookup, checkLike: noLikeCheck }), input)
}

export async function getLinkedInCompany(
	ctx: LinkedInOperationContext,
	input: { company?: unknown },
): Promise<CompanySummary> {
	return getCompany(await postsToolDeps(ctx, { lookup: noLookup, checkLike: noLikeCheck }), input)
}

/** `logCtx` is the same context the tool's `withActionLog` runs under, so the rules read its log. */
export async function reactToLinkedInPost(
	ctx: LinkedInOperationContext,
	logCtx: ActionLogContext,
	input: ReactToPostInput,
): Promise<ReactToPostResult> {
	const deps = await postsToolDeps(ctx, {
		lookup: noLookup,
		checkLike: (like) =>
			checkLikeRules(logCtx.db, {
				integrationId: logCtx.integrationId,
				postId: like.post_id,
				authorProviderId: like.author_provider_id,
				now: logCtx.now,
			}),
	})
	return reactToPost(deps, input)
}

// The hooks a tool never reaches. Reaching one is a wiring mistake, so it fails loudly.
const noLookup: PostsToolDeps['lookup'] = () => {
	throw new Error('this tool does not resolve handles')
}
const noLikeCheck: PostsToolDeps['checkLike'] = () => {
	throw new Error('this tool does not like posts')
}
