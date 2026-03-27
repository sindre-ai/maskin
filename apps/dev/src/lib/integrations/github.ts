import { createHmac, createPrivateKey, createSign, timingSafeEqual } from 'node:crypto'
import type {
	EventDefinition,
	IntegrationCredentials,
	IntegrationProvider,
	NormalizedEvent,
} from './types'

const GITHUB_EVENTS: EventDefinition[] = [
	{
		entityType: 'github.pull_request',
		actions: ['opened', 'closed', 'synchronize', 'review_requested', 'merged'],
		label: 'Pull Request',
	},
	{
		entityType: 'github.issue',
		actions: ['opened', 'closed', 'labeled', 'assigned'],
		label: 'Issue',
	},
	{
		entityType: 'github.push',
		actions: ['pushed'],
		label: 'Push',
	},
	{
		entityType: 'github.review',
		actions: ['submitted', 'dismissed'],
		label: 'Pull Request Review',
	},
]

// Map X-GitHub-Event header values to our entity types
const EVENT_TYPE_MAP: Record<string, string> = {
	pull_request: 'github.pull_request',
	issues: 'github.issue',
	push: 'github.push',
	pull_request_review: 'github.review',
}

function getEnvOrThrow(name: string): string {
	const value = process.env[name]
	if (!value) throw new Error(`${name} environment variable is required`)
	return value
}

function createJwt(appId: string, privateKeyPem: string): string {
	const now = Math.floor(Date.now() / 1000)
	const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url')
	const payload = Buffer.from(
		JSON.stringify({
			iat: now - 60,
			exp: now + 600,
			iss: Number(appId),
		}),
	).toString('base64url')

	// Use createPrivateKey to normalize any PEM format (PKCS#1 or PKCS#8) for OpenSSL 3
	const key = createPrivateKey(privateKeyPem)
	const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(key, 'base64url')

	return `${header}.${payload}.${signature}`
}

export class GitHubProvider implements IntegrationProvider {
	name = 'github'
	displayName = 'GitHub'

	getInstallUrl(state: string): string {
		return `https://github.com/apps/${process.env.GITHUB_APP_SLUG || 'ai-native-oss'}/installations/new?state=${encodeURIComponent(state)}`
	}

	async handleCallback(params: Record<string, string>): Promise<IntegrationCredentials> {
		const installationId = params.installation_id
		if (!installationId) {
			throw new Error('Missing installation_id in callback')
		}
		return { installation_id: installationId }
	}

	verifyWebhook(body: string, signature: string): boolean {
		const secret = process.env.GITHUB_APP_WEBHOOK_SECRET
		if (!secret) {
			throw new Error(
				'GITHUB_APP_WEBHOOK_SECRET environment variable is required for webhook verification',
			)
		}

		const expected = Buffer.from(
			`sha256=${createHmac('sha256', secret).update(body).digest('hex')}`,
		)
		const actual = Buffer.from(signature)
		if (expected.length !== actual.length) return false
		return timingSafeEqual(expected, actual)
	}

	normalizeEvent(payload: unknown, headers: Record<string, string>): NormalizedEvent | null {
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

	getAvailableEvents(): EventDefinition[] {
		return GITHUB_EVENTS
	}

	async getAccessToken(credentials: IntegrationCredentials): Promise<string> {
		const appId = getEnvOrThrow('GITHUB_APP_ID')
		const privateKeyRaw = getEnvOrThrow('GITHUB_APP_PRIVATE_KEY')
		// Support PEM with literal \n sequences (common in env vars) or base64-encoded PEM
		const privateKey = privateKeyRaw.includes('-----BEGIN')
			? privateKeyRaw.replace(/\\n/g, '\n').replace(/\\r/g, '')
			: Buffer.from(privateKeyRaw, 'base64').toString('utf8')

		const jwt = createJwt(appId, privateKey)

		const response = await fetch(
			`https://api.github.com/app/installations/${credentials.installation_id}/access_tokens`,
			{
				method: 'POST',
				headers: {
					Authorization: `Bearer ${jwt}`,
					Accept: 'application/vnd.github+json',
					'X-GitHub-Api-Version': '2022-11-28',
				},
			},
		)

		if (!response.ok) {
			const text = await response.text()
			throw new Error(`Failed to get installation access token: ${response.status} ${text}`)
		}

		const data = (await response.json()) as { token: string }
		return data.token
	}

	getMcpCommand(): { command: string; args: string[]; envKey: string } {
		return {
			command: 'npx',
			args: ['-y', '@modelcontextprotocol/server-github'],
			envKey: 'GITHUB_PERSONAL_ACCESS_TOKEN',
		}
	}
}
