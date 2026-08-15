/**
 * Encodes the `approver ≠ PR author` rule for autonomous PR reviews.
 *
 * The four GitHub identities the merge pipeline uses are configurable, and any
 * one of them can be offline at a given moment. This module resolves a
 * fallback-ordered approver: walk the ordered list, skip any identity whose
 * GitHub user id equals the PR author's, return the first survivor. If every
 * candidate is either the author or missing, no approver is returned — the
 * caller must not fall back to "approve anyway".
 *
 * PAT era: identity `id` is often unknown, so we compare on `login` from
 * `GET /user`. Once GitHub Apps land (sister bet 9e819672), install the
 * installation-scoped user id and use `id` as the source of truth.
 */

/**
 * Default fallback order across the four GitHub identities. New identities
 * added later must append to this list — never prepend — so the primary
 * approver stays stable.
 */
export const DEFAULT_APPROVER_ORDER: readonly string[] = Object.freeze([
	'github_approver',
	'github-vaerksted-ai',
	'github-sindre-ai',
])

export type GitHubIdentity = {
	/** The MCP identity name (e.g. `github_approver`, `github-vaerksted-ai`). */
	name: string
	/** GitHub `login` from `GET /user` — used to match the PR author in the PAT era. */
	login: string
	/** GitHub numeric user id — preferred match key once App identities land. */
	id?: number
}

export type PullRequestAuthor = {
	login: string
	id?: number
}

export type ResolveApproverInput = {
	prAuthor: PullRequestAuthor
	identities: Record<string, GitHubIdentity>
	/** Explicit ordering. Defaults to {@link DEFAULT_APPROVER_ORDER}. */
	order?: readonly string[]
}

const sameActor = (identity: GitHubIdentity, author: PullRequestAuthor): boolean => {
	if (identity.id !== undefined && author.id !== undefined) {
		return identity.id === author.id
	}
	return identity.login.toLowerCase() === author.login.toLowerCase()
}

/**
 * Walk `order`, return the first identity whose GitHub user id (or login, in
 * the PAT era) is not the PR author's. Missing identities are skipped without
 * error — the fallback exists so a single-identity outage does not block the
 * merge. Returns `null` when every candidate is either the author or absent.
 */
export const resolveApprover = ({
	prAuthor,
	identities,
	order = DEFAULT_APPROVER_ORDER,
}: ResolveApproverInput): GitHubIdentity | null => {
	for (const name of order) {
		const identity = identities[name]
		if (!identity) continue
		if (sameActor(identity, prAuthor)) continue
		return identity
	}
	return null
}

/**
 * Hard guardrail: throw if a resolved approver equals the PR author. Callers
 * MUST invoke this immediately before submitting the review — there is no
 * silent "approve anyway" fallback on this bet.
 */
export const assertApproverNotAuthor = (
	approver: GitHubIdentity,
	prAuthor: PullRequestAuthor,
): void => {
	if (sameActor(approver, prAuthor)) {
		throw new Error(
			`Refusing to approve: approver identity "${approver.name}" (${approver.login}) is the PR author.`,
		)
	}
}
