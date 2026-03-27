import type { CustomEventNormalizer, NormalizedEvent } from '../../types'

/** Map X-GitHub-Event header values to normalized entity types */
const EVENT_TYPE_MAP: Record<string, string> = {
	pull_request: 'github.pull_request',
	issues: 'github.issue',
	push: 'github.push',
	pull_request_review: 'github.review',
}

export const githubEventNormalizer: CustomEventNormalizer = (
	payload: unknown,
	headers: Record<string, string>,
): NormalizedEvent | null => {
	const githubEvent = headers['x-github-event']
	if (!githubEvent) return null

	const entityType = EVENT_TYPE_MAP[githubEvent]
	if (!entityType) return null

	const body = payload as Record<string, unknown>
	const installation = body.installation as Record<string, unknown> | undefined
	const installationId = installation?.id ? String(installation.id) : ''
	if (!installationId) return null

	// Determine action
	let action: string
	if (githubEvent === 'push') {
		action = 'pushed'
	} else if (
		githubEvent === 'pull_request' &&
		body.action === 'closed' &&
		(body.pull_request as Record<string, unknown>)?.merged
	) {
		action = 'merged'
	} else {
		action = (body.action as string) || 'unknown'
	}

	// Extract common fields for data
	const repo = body.repository as Record<string, unknown> | undefined
	const data: Record<string, unknown> = {
		repository: repo?.full_name,
		sender: (body.sender as Record<string, unknown>)?.login,
		installation_id: installationId,
	}

	// Add type-specific fields
	if (githubEvent === 'pull_request' || githubEvent === 'pull_request_review') {
		const pr = body.pull_request as Record<string, unknown> | undefined
		if (pr) {
			data.pr_number = pr.number
			data.pr_title = pr.title
			data.pr_url = pr.html_url
			data.pr_diff_url = pr.diff_url
			data.pr_head_sha = (pr.head as Record<string, unknown>)?.sha
			data.pr_base_branch = (pr.base as Record<string, unknown>)?.ref
		}
	}

	if (githubEvent === 'issues') {
		const issue = body.issue as Record<string, unknown> | undefined
		if (issue) {
			data.issue_number = issue.number
			data.issue_title = issue.title
			data.issue_url = issue.html_url
		}
	}

	if (githubEvent === 'push') {
		data.ref = body.ref
		data.commits_count = (body.commits as unknown[])?.length
		data.head_commit = (body.head_commit as Record<string, unknown>)?.message
	}

	if (githubEvent === 'pull_request_review') {
		const review = body.review as Record<string, unknown> | undefined
		if (review) {
			data.review_state = review.state
			data.review_body = review.body
		}
	}

	return { entityType, action, installationId, data }
}
