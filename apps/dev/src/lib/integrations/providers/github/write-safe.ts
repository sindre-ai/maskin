import type { Database } from '@maskin/db'
import { events, notifications, objects } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { logger } from '../../../logger'
import { TokenManager } from '../../oauth/token-manager'
import { getProvider } from '../../registry'

export interface GithubWriteRequest {
	url: string
	method: 'POST' | 'PATCH' | 'PUT' | 'DELETE'
	body?: unknown
	headers?: Record<string, string>
}

/**
 * Escalation target: where the loud failure surfaces when a re-mint retry
 * still returns 401. `entityId` should be a task/bet id in the workspace —
 * we post a comment there, flag it, and fan out needs_input notifications.
 * `mentions` MUST include at least one human actor id, otherwise the
 * failure would be reported into a channel no one is subscribed to.
 */
export interface GithubWriteEscalation {
	workspaceId: string
	entityId: string
	actorId: string
	mentions: string[]
}

export class PersistentGithub401Error extends Error {
	readonly status = 401
	readonly url: string
	readonly responseBody: string

	constructor(url: string, responseBody: string) {
		super(`GitHub write persistently returned 401 after re-mint retry: ${url}`)
		this.name = 'PersistentGithub401Error'
		this.url = url
		this.responseBody = responseBody
	}
}

/**
 * Wrap a GitHub REST write so that a 401 triggers exactly one token re-mint
 * and retry. If the retry also 401s, escalate loudly on the caller-supplied
 * entity (comment + @mention + task flag) and throw
 * {@link PersistentGithub401Error}. Non-401 responses (200/201/4xx/5xx other
 * than 401) are returned as-is for the caller to handle.
 *
 * The re-mint step reuses {@link TokenManager.getValidToken} — the github
 * provider's customAuth flow always exchanges a fresh JWT for a fresh
 * installation token, so a second call after a 401 is a real re-mint rather
 * than a re-read of a cached value.
 */
export async function performGithubWrite(
	db: Database,
	integrationId: string,
	request: GithubWriteRequest,
	escalation?: GithubWriteEscalation,
): Promise<Response> {
	const attempt = async (): Promise<Response> => {
		const token = await mintFreshToken(db, integrationId)
		const hasBody = request.body !== undefined
		return fetch(request.url, {
			method: request.method,
			headers: {
				Authorization: `Bearer ${token}`,
				Accept: 'application/vnd.github+json',
				'X-GitHub-Api-Version': '2022-11-28',
				...(hasBody ? { 'Content-Type': 'application/json' } : {}),
				...request.headers,
			},
			body: hasBody ? JSON.stringify(request.body) : undefined,
		})
	}

	let response = await attempt()
	if (response.status !== 401) {
		return response
	}

	logger.warn('GitHub write returned 401 — re-minting installation token and retrying once', {
		integrationId,
		url: request.url,
		method: request.method,
	})

	response = await attempt()
	if (response.status !== 401) {
		return response
	}

	const failureBody = await response.text().catch(() => '')
	logger.error('GitHub write persistently returned 401 after re-mint retry', {
		integrationId,
		url: request.url,
		method: request.method,
		responseSnippet: failureBody.slice(0, 500),
	})

	if (escalation) {
		await escalateGithub401Failure(db, escalation, request, failureBody)
	}

	throw new PersistentGithub401Error(request.url, failureBody)
}

async function mintFreshToken(db: Database, integrationId: string): Promise<string> {
	const provider = getProvider('github')
	const manager = new TokenManager()
	return manager.getValidToken(db, integrationId, provider)
}

async function escalateGithub401Failure(
	db: Database,
	escalation: GithubWriteEscalation,
	request: GithubWriteRequest,
	failureBody: string,
): Promise<void> {
	const bodySnippet = failureBody.slice(0, 300)
	const commentContent = [
		'GitHub write persistently returned 401 after a re-mint retry.',
		'',
		`Endpoint: \`${request.method} ${request.url}\``,
		'',
		'A fresh installation token was minted and still rejected — this usually means the GitHub App has been uninstalled or the installation token has been revoked upstream. A human needs to verify the sindre-ai installation is healthy before this task can continue.',
		bodySnippet ? `\nResponse snippet:\n\n\`\`\`\n${bodySnippet}\n\`\`\`` : '',
	]
		.filter((line) => line !== '')
		.join('\n')

	await db.transaction(async (tx) => {
		// Flag the target object so the failure is visible from the object list
		// (not only via a comment scroll). Merge with any existing metadata so
		// prior flags aren't clobbered.
		const [existing] = await tx
			.select({ metadata: objects.metadata })
			.from(objects)
			.where(eq(objects.id, escalation.entityId))
			.limit(1)

		if (existing) {
			const nextMetadata = {
				...((existing.metadata as Record<string, unknown> | null) ?? {}),
				github_write_failed: true,
				github_write_failed_at: new Date().toISOString(),
			}
			await tx
				.update(objects)
				.set({ metadata: nextMetadata, updatedAt: new Date() })
				.where(eq(objects.id, escalation.entityId))
		}

		// Post the escalation as a comment event — this is what the UI renders
		// in the object's activity feed and what mention-fan-out reads from.
		const [inserted] = await tx
			.insert(events)
			.values({
				workspaceId: escalation.workspaceId,
				actorId: escalation.actorId,
				action: 'commented',
				entityType: 'object',
				entityId: escalation.entityId,
				data: {
					content: commentContent,
					mentions: escalation.mentions,
				},
			})
			.returning({ id: events.id })

		// Fan out needs_input notifications for each @mentioned human so the
		// failure shows up in their inbox rather than only on the task.
		if (escalation.mentions.length > 0 && inserted) {
			await tx.insert(notifications).values(
				escalation.mentions.map((targetActorId) => ({
					workspaceId: escalation.workspaceId,
					type: 'needs_input' as const,
					title: 'GitHub write failed after re-mint',
					content: commentContent,
					sourceActorId: escalation.actorId,
					targetActorId,
					objectId: escalation.entityId,
					status: 'pending' as const,
					metadata: {
						reason: 'github_write_persistent_401',
						commentEventId: inserted.id,
					},
				})),
			)
		}
	})

	logger.info('Escalated persistent GitHub 401 failure', {
		entityId: escalation.entityId,
		workspaceId: escalation.workspaceId,
		mentionCount: escalation.mentions.length,
	})
}
