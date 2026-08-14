import type { Database } from '@maskin/db'
import { actors, sessions } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import type { SessionManager } from '../../services/session-manager'
import { logger } from '../logger'

// Resumes or spawns the agent that created a notification so it can act on
// the human response (or auto-applied default_action on expiry). Extracted
// here so both `routes/notifications.ts` (immediate dispatch) and
// `services/notifications-lifecycle.ts` (deferred reaper) can call it.
export async function wakeSourceAgent(ctx: {
	sessionManager: SessionManager
	db: Database
	workspaceId: string
	sourceActorId: string
	linkedSessionId: string | null
	notificationId: string
	title: string
	content: string | null
	response: unknown
	createdBy: string
}): Promise<void> {
	const [sourceActor] = await ctx.db
		.select({ type: actors.type })
		.from(actors)
		.where(eq(actors.id, ctx.sourceActorId))
		.limit(1)

	if (!sourceActor || sourceActor.type !== 'agent') return

	let continuationOfSessionId: string | null = null
	if (ctx.linkedSessionId) {
		const [linked] = await ctx.db
			.select({ status: sessions.status })
			.from(sessions)
			.where(eq(sessions.id, ctx.linkedSessionId))
			.limit(1)

		const status = linked?.status

		if (status === 'paused') {
			await ctx.sessionManager.resumeSession(ctx.linkedSessionId)
			return
		}

		// Active sessions can't be signalled — there is no stdin/mid-run prompt
		// channel into a running container. Skip rather than race: the response
		// is persisted on the notification and the agent can read it via MCP
		// when it next polls, finishes, or is auto-paused + resumed.
		if (status === 'pending' || status === 'starting' || status === 'running') {
			logger.info('Skipping wake: linked session is still active', {
				notificationId: ctx.notificationId,
				sessionId: ctx.linkedSessionId,
				status,
			})
			return
		}

		// Terminal states (completed, failed, timeout, stopped, snapshotting, etc.)
		// → spawn a new session and reference the prior one for context continuity.
		continuationOfSessionId = ctx.linkedSessionId
	}

	await ctx.sessionManager.createSession(ctx.workspaceId, {
		actorId: ctx.sourceActorId,
		actionPrompt: buildResponsePrompt({
			notificationId: ctx.notificationId,
			title: ctx.title,
			content: ctx.content,
			response: ctx.response,
			continuationOfSessionId,
		}),
		config: {
			notification_response: {
				notification_id: ctx.notificationId,
				response: ctx.response,
				...(continuationOfSessionId ? { continuation_of_session_id: continuationOfSessionId } : {}),
			},
		},
		createdBy: ctx.createdBy,
	})
}

export function buildResponsePrompt(ctx: {
	notificationId: string
	title: string
	content: string | null
	response: unknown
	continuationOfSessionId: string | null
}): string {
	const responseText =
		typeof ctx.response === 'string' ? ctx.response : JSON.stringify(ctx.response)
	return [
		'A human responded to a notification you created. Read the response and act on it.',
		'',
		...(ctx.continuationOfSessionId
			? [
					`This is a continuation of session ${ctx.continuationOfSessionId}, which has ended. Review its logs for prior context if needed.`,
					'',
				]
			: []),
		`Notification ID: ${ctx.notificationId}`,
		`Notification title: ${ctx.title}`,
		...(ctx.content ? ['Notification content:', '"""', ctx.content, '"""', ''] : ['']),
		'Human response:',
		'"""',
		responseText,
		'"""',
	].join('\n')
}
