import type { NodeWebSocket } from '@hono/node-ws'
import type { Database } from '@maskin/db'
import { actors, voiceSessions, workspaceMembers } from '@maskin/db/schema'
import { createInvokeTool } from '@maskin/mcp'
import type { InvokeTool } from '@maskin/mcp'
import { resolveWebAppBaseUrl } from '@maskin/shared'
import { and, eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { createApiError } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { logger } from '../lib/logger'
import { captureVoiceException } from '../lib/sentry-voice'
import { createVoiceChannel } from '../services/voice-session-channel'
import { cancelVoiceWsGrace, startVoiceWsGrace } from '../services/voice-session-lifecycle'
import type { VoiceSessionRow } from '../services/voice-transcript'

type Env = {
	Variables: {
		db: Database
		actorId: string
		voiceSession: VoiceSessionRow
		voiceAgent: { name: string; apiKey: string }
	}
}

/** Builds the tool dispatcher a session's calls run through. Overridable in tests. */
export type VoiceInvokeToolFactory = (args: { apiKey: string; workspaceId: string }) => InvokeTool

const defaultInvokeToolFactory: VoiceInvokeToolFactory = ({ apiKey, workspaceId }) =>
	createInvokeTool({
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		// The agent's own key, so every write is attributed to the agent's actor
		// (voice_sessions.agent_actor_id) rather than the human speaking. It is
		// read server-side here and never sent to the browser.
		apiKey,
		defaultWorkspaceId: workspaceId,
		transport: 'http',
		webAppBaseUrl: resolveWebAppBaseUrl(process.env),
	})

/**
 * GET /api/voice-sessions/:id/events — the per-session control channel for a
 * voice call (tool-call proxying, transcript writes, turn telemetry). See
 * services/voice-session-channel.ts for the wire protocol.
 *
 * Auth is the app-wide authMiddleware (Bearer API key), which runs before this
 * router. On top of that this route requires the caller to be the human who
 * minted the session, still a member of its workspace, with the session still
 * live. Every refusal is a plain HTTP response BEFORE the upgrade, and a
 * session that is not the caller's is a 404 so ids are not probeable.
 *
 * Browsers cannot set an Authorization header on a WebSocket upgrade, so until
 * the single-use upgrade ticket lands (awaiting the tech owner's sign-off on
 * the auth boundary) only a client that can set headers reaches this route.
 * That fails closed: nothing is reachable without a valid key.
 */
export function createVoiceSessionEventsRoutes(
	upgradeWebSocket: NodeWebSocket['upgradeWebSocket'],
	invokeToolFactory: VoiceInvokeToolFactory = defaultInvokeToolFactory,
) {
	const app = new Hono<Env>()

	app.get(
		'/:id/events',
		async (c, next) => {
			const actorId = c.get('actorId')
			const db = c.get('db')
			const id = c.req.param('id')

			// Same 404 shape as the mint route: a non-tester never learns it exists.
			if (
				!isFlagEnabled(actorId, FLAGS.VOICE_MODE_V1) ||
				!z.string().uuid().safeParse(id).success
			) {
				return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
			}

			const [session] = await db
				.select()
				.from(voiceSessions)
				.where(eq(voiceSessions.id, id))
				.limit(1)
			if (!session || session.humanActorId !== actorId) {
				return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
			}

			const [member] = await db
				.select({ actorId: workspaceMembers.actorId })
				.from(workspaceMembers)
				.where(
					and(
						eq(workspaceMembers.actorId, actorId),
						eq(workspaceMembers.workspaceId, session.workspaceId),
					),
				)
				.limit(1)
			if (!member) return c.json(createApiError('NOT_FOUND', 'Not found'), 404)

			if (session.status !== 'pending' && session.status !== 'active') {
				return c.json(createApiError('CONFLICT', 'Voice session is not live'), 409)
			}

			const [agent] = await db
				.select({ name: actors.name, apiKey: actors.apiKey })
				.from(actors)
				.where(eq(actors.id, session.agentActorId))
				.limit(1)
			if (!agent?.apiKey) {
				logger.error('Voice session agent has no API key', {
					voice_session_id: session.id,
					agent_actor_id: session.agentActorId,
				})
				captureVoiceException(session.id, new Error('Voice session agent has no API key'))
				return c.json(createApiError('INTERNAL_ERROR', 'Voice session cannot proxy tools'), 500)
			}

			c.set('voiceSession', session)
			c.set('voiceAgent', { name: agent.name, apiKey: agent.apiKey })
			return next()
		},
		upgradeWebSocket((c) => {
			const session = c.get('voiceSession')
			const agent = c.get('voiceAgent')
			const db = c.get('db')
			const channel = {
				current: null as ReturnType<typeof createVoiceChannel> | null,
			}
			return {
				onOpen(_event, ws) {
					// A reconnect inside the 20s grace resumes the same call.
					cancelVoiceWsGrace(session.id)
					channel.current = createVoiceChannel({
						db,
						session,
						agentName: agent.name,
						invokeTool: invokeToolFactory({
							apiKey: agent.apiKey,
							workspaceId: session.workspaceId,
						}),
						send: (message) => ws.send(JSON.stringify(message)),
					})
					channel.current.onOpen().catch((err) =>
						logger.error('Voice channel open failed', {
							voice_session_id: session.id,
							error: String(err),
						}),
					)
				},
				onClose() {
					// The channel going away does not end the call by itself (the audio
					// path is browser <-> OpenAI). Give the browser the grace window to
					// come back; otherwise the call is ended as network_error.
					startVoiceWsGrace(db, session.id)
				},
				onMessage(event) {
					// A rejection here must not take the socket (or the process) down.
					channel.current?.onMessage(event.data).catch((err) =>
						logger.error('Voice channel message failed', {
							voice_session_id: session.id,
							error: String(err),
						}),
					)
				},
			}
		}),
	)

	return app
}
