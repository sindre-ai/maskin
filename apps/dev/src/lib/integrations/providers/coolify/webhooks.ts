import { createHmac, timingSafeEqual } from 'node:crypto'

/**
 * Stable enum used as `metadata.source` on insights. The immediate-triage
 * trigger from T3 will match against these literals — adding or renaming
 * a value is a contract change across the bet.
 */
export type CoolifySource =
	| 'coolify_deployment'
	| 'coolify_crash'
	| 'coolify_health'
	/** Watchdog-only — emitted by the heartbeat service, never by a real webhook. */
	| 'coolify_silence'

export interface CoolifyDeploymentFailedPayload {
	event: 'deployment.failed'
	deployment_id: string
	application_id: string
	application_name?: string
	commit_sha?: string
	previous_commit_sha?: string
	/** Commits Coolify already attributes to the failing deploy, newest first. */
	commits?: Array<{ sha: string; message?: string; author?: string }>
	error_message?: string
	error_excerpt?: string
	failed_at?: string
}

export interface CoolifyApplicationCrashedPayload {
	event: 'application.crashed'
	application_id: string
	application_name?: string
	restart_count?: number
	last_commit_sha?: string
	error_message?: string
	error_fingerprint?: string
	crashed_at?: string
}

export interface CoolifyHealthCheckFailedPayload {
	event: 'application.health_check_failed'
	application_id: string
	application_name?: string
	check_id: string
	last_success_at?: string
	failed_at?: string
	error_message?: string
}

export type CoolifyWebhookPayload =
	| CoolifyDeploymentFailedPayload
	| CoolifyApplicationCrashedPayload
	| CoolifyHealthCheckFailedPayload

/**
 * Verify HMAC-SHA256 of the raw body against the configured shared secret.
 * Coolify supports `x-coolify-signature: sha256=<hex>` on outbound webhooks.
 * Constant-time comparison via `timingSafeEqual`.
 */
export function verifyCoolifySignature(body: string, signature: string, secret: string): boolean {
	if (!signature) return false
	const stripped = signature.startsWith('sha256=') ? signature.slice('sha256='.length) : signature
	const computed = createHmac('sha256', secret).update(body).digest('hex')
	const expected = Buffer.from(computed)
	const actual = Buffer.from(stripped)
	if (expected.length !== actual.length) return false
	return timingSafeEqual(expected, actual)
}

/**
 * Map raw payload event string → stable insight source enum. Returns null when
 * the payload doesn't carry a recognised event; the route turns that into an
 * acknowledged-but-skipped response so unknown event types don't 4xx Coolify.
 */
export function sourceForEvent(event: unknown): CoolifySource | null {
	switch (event) {
		case 'deployment.failed':
			return 'coolify_deployment'
		case 'application.crashed':
			return 'coolify_crash'
		case 'application.health_check_failed':
			return 'coolify_health'
		default:
			return null
	}
}

/**
 * Fingerprint identifies the "same incident" across retries and repeat events
 * so AC-T5 dedup updates the existing insight instead of spamming a duplicate.
 * The shape is `<source>:<entity>:<discriminator>` so reads stay greppable.
 */
export function fingerprintFor(payload: CoolifyWebhookPayload): string {
	switch (payload.event) {
		case 'deployment.failed':
			return `coolify_deployment:${payload.application_id}:${payload.deployment_id}`
		case 'application.crashed':
			return `coolify_crash:${payload.application_id}:${
				payload.error_fingerprint ?? payload.last_commit_sha ?? 'unknown'
			}`
		case 'application.health_check_failed':
			return `coolify_health:${payload.application_id}:${payload.check_id}`
	}
}

export interface BuiltInsight {
	source: CoolifySource
	fingerprint: string
	title: string
	content: string
	context: Record<string, unknown>
}

const truncate = (s: string, max: number): string =>
	s.length <= max ? s : `${s.slice(0, max - 1)}…`

const formatCommitsBlock = (
	commits: Array<{ sha: string; message?: string; author?: string }> | undefined,
): string => {
	if (!commits || commits.length === 0) return '_No commit data carried in webhook payload._'
	return commits
		.slice(0, 10)
		.map((c) => {
			const shortSha = c.sha.slice(0, 7)
			const title = c.message?.split('\n')[0] ?? '(no message)'
			const author = c.author ? ` — ${c.author}` : ''
			return `- \`${shortSha}\` ${truncate(title, 100)}${author}`
		})
		.join('\n')
}

export function buildInsightForPayload(payload: CoolifyWebhookPayload): BuiltInsight {
	const fingerprint = fingerprintFor(payload)

	if (payload.event === 'deployment.failed') {
		const appLabel = payload.application_name
			? `${payload.application_name} (${payload.application_id})`
			: payload.application_id
		const errExcerpt = payload.error_excerpt ?? payload.error_message ?? '(no error excerpt)'
		const context: Record<string, unknown> = {
			deployment_id: payload.deployment_id,
			application_id: payload.application_id,
			application_name: payload.application_name,
			commit_sha: payload.commit_sha,
			previous_commit_sha: payload.previous_commit_sha,
			commits_in_deploy: payload.commits ?? [],
			error_excerpt: truncate(errExcerpt, 4000),
			failed_at: payload.failed_at,
		}
		const content = [
			`**Deployment failed** — ${appLabel}`,
			'',
			`- deployment: \`${payload.deployment_id}\``,
			`- commit: \`${payload.commit_sha ?? 'unknown'}\``,
			payload.previous_commit_sha ? `- previous: \`${payload.previous_commit_sha}\`` : null,
			payload.failed_at ? `- failed at: ${payload.failed_at}` : null,
			'',
			'**Error excerpt**',
			'```',
			truncate(errExcerpt, 1500),
			'```',
			'',
			'**Commits in failing deploy**',
			formatCommitsBlock(payload.commits),
		]
			.filter((line): line is string => line !== null)
			.join('\n')
		return {
			source: 'coolify_deployment',
			fingerprint,
			title: `Coolify deployment failed — ${appLabel}`,
			content,
			context,
		}
	}

	if (payload.event === 'application.crashed') {
		const appLabel = payload.application_name
			? `${payload.application_name} (${payload.application_id})`
			: payload.application_id
		const errExcerpt = payload.error_message ?? '(no error message)'
		const context: Record<string, unknown> = {
			application_id: payload.application_id,
			application_name: payload.application_name,
			restart_count: payload.restart_count,
			last_commit_sha: payload.last_commit_sha,
			error_fingerprint: payload.error_fingerprint,
			error_excerpt: truncate(errExcerpt, 4000),
			crashed_at: payload.crashed_at,
		}
		const content = [
			`**Application crashed** — ${appLabel}`,
			'',
			`- restarts: ${payload.restart_count ?? 'unknown'}`,
			`- last commit: \`${payload.last_commit_sha ?? 'unknown'}\``,
			payload.crashed_at ? `- crashed at: ${payload.crashed_at}` : null,
			'',
			'**Error**',
			'```',
			truncate(errExcerpt, 1500),
			'```',
		]
			.filter((line): line is string => line !== null)
			.join('\n')
		return {
			source: 'coolify_crash',
			fingerprint,
			title: `Coolify application crashed — ${appLabel}`,
			content,
			context,
		}
	}

	const appLabel = payload.application_name
		? `${payload.application_name} (${payload.application_id})`
		: payload.application_id
	const context: Record<string, unknown> = {
		application_id: payload.application_id,
		application_name: payload.application_name,
		check_id: payload.check_id,
		last_success_at: payload.last_success_at,
		failed_at: payload.failed_at,
		error_excerpt: payload.error_message ? truncate(payload.error_message, 4000) : undefined,
	}
	const content = [
		`**Health check failed** — ${appLabel}`,
		'',
		`- check: \`${payload.check_id}\``,
		payload.last_success_at ? `- last success: ${payload.last_success_at}` : null,
		payload.failed_at ? `- failed at: ${payload.failed_at}` : null,
		payload.error_message ? '' : null,
		payload.error_message ? '**Error**' : null,
		payload.error_message ? '```' : null,
		payload.error_message ? truncate(payload.error_message, 1500) : null,
		payload.error_message ? '```' : null,
	]
		.filter((line): line is string => line !== null)
		.join('\n')
	return {
		source: 'coolify_health',
		fingerprint,
		title: `Coolify health check failed — ${appLabel}`,
		content,
		context,
	}
}
