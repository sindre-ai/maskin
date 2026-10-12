import type { NodeWebSocket } from '@hono/node-ws'
import type { Database } from '@maskin/db'
import { actors, liveSessions, workspaces } from '@maskin/db/schema'
import {
	buildLiveFunctionTools,
	createInvokeTool,
	liveToolLabel,
	parseLiveToolArgs,
	toolRisk,
} from '@maskin/mcp'
import type { InvokeTool } from '@maskin/mcp'
import { resolveWebAppBaseUrl } from '@maskin/shared'
import type { StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { z } from 'zod'
import { isEnterprise } from '../lib/enterprise'
import { createApiError } from '../lib/errors'
import { FLAGS, isFlagEnabled } from '../lib/feature-flags'
import { resolveLiveCredentials } from '../lib/live-credentials'
import { checkPlanCap } from '../lib/llm-routing'
import { logger } from '../lib/logger'
import { captureLiveException } from '../lib/sentry-live'
import type { WorkspaceSettings } from '../lib/types'
import { isWorkspaceMember } from '../lib/workspace-auth'
import { defaultNotesCompletion, writeClosingNotes } from '../services/live-closing-notes'
import { type LiveChannel, createLiveChannel } from '../services/live-session-channel'
import { cancelLiveWsGrace, startLiveWsGrace } from '../services/live-session-lifecycle'
import type { LiveSessionRow } from '../services/live-session-lifecycle'

type Env = {
	Variables: {
		db: Database
		actorId: string
		live: {
			session: LiveSessionRow
			agent: { id: string; name: string; systemPrompt: string | null; apiKey: string }
			human: { id: string; name: string }
			creds: NonNullable<ReturnType<typeof resolveLiveCredentials>>
			opening?: 'briefing'
		}
	}
}

/** Backpressure: the socket may hold this much unsent data before we wait. */
const MAX_BUFFERED_BYTES = 1024 * 1024
/** A client that will not drain within this long is dropped. */
const DRAIN_STALL_MS = 10_000
/** No inbound frame (client pings every 15 s) for this long means the client is gone. */
const SILENCE_MS = 45_000

export type LiveInvokeToolFactory = (a: { apiKey: string; workspaceId: string }) => InvokeTool

const defaultInvokeToolFactory: LiveInvokeToolFactory = ({ apiKey, workspaceId }) =>
	createInvokeTool({
		apiBaseUrl: `http://localhost:${Number(process.env.PORT) || 3000}`,
		// The agent's own key, so every write is attributed to the agent and not to the person
		// speaking. Read server-side only; never sent to the client.
		apiKey,
		defaultWorkspaceId: workspaceId,
		transport: 'http',
		webAppBaseUrl: resolveWebAppBaseUrl(process.env),
	})

export interface LiveStreamDeps {
	storage: StorageProvider
	invokeToolFactory?: LiveInvokeToolFactory
}

/**
 * GET /api/live-sessions/:id/stream, the control and audio channel for a live
 * call. Auth is the app-wide authMiddleware (Bearer key, which a native client
 * can set on the upgrade). On top of that the caller must be the person who
 * started the session, still a member of its workspace, with the session live.
 * Every refusal is a plain HTTP response BEFORE the upgrade, and a session that
 * is not the caller's is a 404 so ids cannot be probed.
 */
export function createLiveSessionStreamRoutes(
	upgradeWebSocket: NodeWebSocket['upgradeWebSocket'],
	deps: LiveStreamDeps,
) {
	const app = new Hono<Env>()
	const invokeToolFactory = deps.invokeToolFactory ?? defaultInvokeToolFactory
	// Built once: the catalogue does not change per call.
	const liveTools = buildLiveFunctionTools()

	app.get(
		'/:id/stream',
		async (c, next) => {
			const actorId = c.get('actorId')
			const db = c.get('db')
			const id = c.req.param('id')
			if (!isFlagEnabled(actorId, FLAGS.LIVE_MODE) || !z.string().uuid().safeParse(id).success) {
				return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
			}
			const [session] = await db.select().from(liveSessions).where(eq(liveSessions.id, id)).limit(1)
			if (
				!session ||
				session.humanActorId !== actorId ||
				!(await isWorkspaceMember(db, actorId, session.workspaceId))
			) {
				return c.json(createApiError('NOT_FOUND', 'Not found'), 404)
			}
			if (session.status !== 'pending' && session.status !== 'active') {
				return c.json(createApiError('CONFLICT', 'Live session is not live'), 409)
			}

			const [agent] = await db
				.select({
					id: actors.id,
					name: actors.name,
					systemPrompt: actors.systemPrompt,
					apiKey: actors.apiKey,
					metadata: actors.metadata,
					llmConfig: actors.llmConfig,
				})
				.from(actors)
				.where(eq(actors.id, session.agentActorId))
				.limit(1)
			if (!agent?.apiKey) {
				logger.error('Live session agent has no API key', {
					live_session_id: session.id,
					agent_actor_id: session.agentActorId,
				})
				captureLiveException(session.id, new Error('Live session agent has no API key'))
				return c.json(createApiError('INTERNAL_ERROR', 'This call cannot use tools'), 500)
			}
			const [human] = await db
				.select({ name: actors.name })
				.from(actors)
				.where(eq(actors.id, actorId))
				.limit(1)
			const [ws] = await db
				.select({
					settings: workspaces.settings,
					enterpriseGranted: workspaces.enterpriseGranted,
					billingOwnerId: workspaces.billingOwnerId,
				})
				.from(workspaces)
				.where(eq(workspaces.id, session.workspaceId))
				.limit(1)
			if (!ws) return c.json(createApiError('NOT_FOUND', 'Not found'), 404)

			// Re-resolved at connect: a key removed since the session was created ends the call here.
			const creds = resolveLiveCredentials({
				wsSettings: (ws.settings ?? {}) as WorkspaceSettings,
				workspace: ws,
				agent: {
					llmConfig: agent.llmConfig as { model?: string | null } | null,
					metadata: agent.metadata as Record<string, unknown> | null,
				},
			})
			if (!creds)
				return c.json(
					createApiError('CONFLICT', 'No live-capable credentials for this workspace'),
					409,
				)

			c.set('live', {
				session,
				agent: {
					id: agent.id,
					name: agent.name,
					systemPrompt: agent.systemPrompt,
					apiKey: agent.apiKey,
				},
				human: { id: actorId, name: human?.name ?? 'You' },
				creds,
				opening: c.req.query('opening') === 'briefing' ? 'briefing' : undefined,
			})
			return next()
		},
		upgradeWebSocket((c) => {
			const { session, agent, human, creds, opening } = c.get('live')
			const db = c.get('db')
			let channel: LiveChannel | null = null
			let silenceTimer: NodeJS.Timeout | null = null

			return {
				onOpen(_event, ws) {
					// A reconnect inside the grace window resumes the same call.
					cancelLiveWsGrace(session.id)

					const raw = ws.raw as { bufferedAmount?: number } | undefined
					const armSilence = () => {
						if (silenceTimer) clearTimeout(silenceTimer)
						silenceTimer = setTimeout(() => {
							logger.info('Live socket silent, closing', { live_session_id: session.id })
							ws.close(1001, 'silent')
						}, SILENCE_MS)
						silenceTimer.unref()
					}
					armSilence()
					;(ws as unknown as { _arm?: () => void })._arm = armSilence

					const invokeTool = invokeToolFactory({
						apiKey: agent.apiKey,
						workspaceId: session.workspaceId,
					})
					channel = createLiveChannel({
						db,
						storage: deps.storage,
						session,
						agent,
						human,
						creds,
						opening,
						tools: liveTools,
						io: {
							sendJson: (frame) => ws.send(JSON.stringify(frame)),
							// ws.send wants a plain ArrayBuffer-backed view; ours always is (built by encodeLiveAudioFrame).
							sendBinary: (data) => ws.send(data as Uint8Array<ArrayBuffer>),
							waitForDrain: async () => {
								const started = Date.now()
								while ((raw?.bufferedAmount ?? 0) >= MAX_BUFFERED_BYTES) {
									if (Date.now() - started > DRAIN_STALL_MS) throw new Error('client_stalled')
									await new Promise((r) => setTimeout(r, 10))
								}
							},
							close: () => ws.close(1000, 'ended'),
						},
						invokeTool: (name, args) =>
							invokeTool(name, args, { actorId: agent.id, workspaceId: session.workspaceId }),
						parseArgs: (name, rawArgs) => parseLiveToolArgs(name, rawArgs, session.workspaceId),
						closingNotes: (ended) =>
							writeClosingNotes({ db, session: ended, complete: defaultNotesCompletion(creds) }),
						riskOf: toolRisk,
						label: liveToolLabel,
						checkPlanCap: async () => {
							if (creds.route !== 'maskin_plan') return
							const [ws2] = await db
								.select({
									settings: workspaces.settings,
									enterpriseGranted: workspaces.enterpriseGranted,
									billingOwnerId: workspaces.billingOwnerId,
								})
								.from(workspaces)
								.where(eq(workspaces.id, session.workspaceId))
								.limit(1)
							if (!ws2) return
							await checkPlanCap({
								db,
								workspaceId: session.workspaceId,
								wsSettings: (ws2.settings ?? {}) as WorkspaceSettings,
								enterprise: isEnterprise(ws2),
							})
						},
					})
					channel.onOpen().catch((err) => {
						captureLiveException(session.id, err)
						logger.error('Live channel open failed', {
							live_session_id: session.id,
							error: String(err),
						})
					})
				},
				onMessage(event, ws) {
					;(ws as unknown as { _arm?: () => void })._arm?.()
					const handle = async () => {
						const data = event.data
						let payload: string | ArrayBuffer | Uint8Array
						if (typeof data === 'string') payload = data
						else if (data instanceof Blob) payload = new Uint8Array(await data.arrayBuffer())
						else payload = new Uint8Array(data) // copy out of any shared buffer
						await channel?.onMessage(payload)
					}
					// A rejection here must not take the socket or the process down.
					handle().catch((err) => {
						captureLiveException(session.id, err)
						logger.error('Live channel message failed', {
							live_session_id: session.id,
							error: String(err),
						})
					})
				},
				onClose() {
					if (silenceTimer) clearTimeout(silenceTimer)
					const ch = channel
					channel = null
					// The in-flight turn is cut short and persisted as interrupted. The call itself gets
					// the grace window to come back before it is ended as network_error.
					ch?.onClose().catch((err) => captureLiveException(session.id, err))
					if (!ch?.ended) startLiveWsGrace(db, session.id)
				},
			}
		}),
	)

	return app
}
