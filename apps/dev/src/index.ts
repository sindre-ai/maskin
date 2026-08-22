import './lib/sentry'
import './extensions'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createDb, syncAgentServersFromEnv } from '@maskin/db'
import { actors, sessions } from '@maskin/db/schema'
import { PgNotifyBridge } from '@maskin/realtime'
import { S3StorageProvider } from '@maskin/storage'
import { eq } from 'drizzle-orm'
import { createApp } from './app-factory'
import { emitInstallCompleted } from './lib/analytics/install-telemetry'
import {
	type DevBootstrapResult,
	maybeBootstrapDev,
	seedMarketplaceIfEmpty,
} from './lib/dev-bootstrap'
import { logger } from './lib/logger'
import { AgentStorageManager } from './services/agent-storage'
import { GmailWatchRenewer } from './services/gmail-watch-renewer'
import { LoopVersionPusher } from './services/loop-version-pusher'
import { OrphanThreadDetector } from './services/orphan-thread-detector'
import { RuntimeTelemetry } from './services/runtime-telemetry'
import { SessionDispatchQueue } from './services/session-dispatch-queue'
import { SessionDispatcher } from './services/session-dispatcher'
import { SessionManager } from './services/session-manager'
import { TriggerRunner } from './services/trigger-runner'
import { WebhookDeliveriesCleaner } from './services/webhook-deliveries-cleaner'
import { WebhookDeliveriesReconciler } from './services/webhook-deliveries-reconciler'

// Database connection — POSTGRES_URL takes priority over DATABASE_URL
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required')
}
const db = createDb(databaseUrl)

// Sync agent-server pool from env on every startup.
// Set AGENT_SERVERS=url1|secret1,url2|secret2 to register boxes.
try {
	const synced = await syncAgentServersFromEnv(db, process.env)
	if (synced.length > 0) {
		logger.info('Agent servers synced from env', {
			count: synced.length,
			urls: synced.map((s) => s.url),
		})
	} else if (process.env.NODE_ENV === 'production') {
		logger.warn('No agent servers configured — set AGENT_SERVERS=url1|secret1,url2|secret2')
	}
} catch (err) {
	logger.error('Failed to sync agent servers from env', {
		error: err instanceof Error ? err.message : String(err),
	})
}

// Real-time: PG NOTIFY → SSE bridge
// LISTEN/NOTIFY requires a direct (session-mode) connection when using a connection
// pooler in transaction mode. Set DATABASE_URL_DIRECT to a non-pooled connection string.
const notifyBridge = new PgNotifyBridge(process.env.DATABASE_URL_DIRECT || databaseUrl)
notifyBridge.start().then(() => {
	logger.info('PG NOTIFY bridge started')
})

// S3-compatible storage (SeaweedFS for dev, any S3 service in production)
const storageProvider = new S3StorageProvider({
	endpoint: process.env.S3_ENDPOINT ?? 'http://localhost:8333',
	bucket: process.env.S3_BUCKET ?? 'agent-files',
	accessKeyId: process.env.S3_ACCESS_KEY ?? 'admin',
	secretAccessKey: process.env.S3_SECRET_KEY ?? 'admin',
	region: process.env.S3_REGION ?? 'us-east-1',
})

try {
	await storageProvider.ensureBucket()
} catch (err) {
	logger.error(
		'Failed to initialize S3 bucket — agent file operations will fail until S3 is available',
		{
			error: err instanceof Error ? err.message : String(err),
		},
	)
}

const agentStorage = new AgentStorageManager(storageProvider, db)

const runtimeTelemetry = new RuntimeTelemetry({
	apiKey: process.env.POSTHOG_API_KEY,
	host: process.env.POSTHOG_HOST,
})

const sessionManager = new SessionManager(db, storageProvider, runtimeTelemetry)
sessionManager.setAgentBaseBuildContext(
	path.resolve(import.meta.dirname ?? __dirname, '../../../docker/agent-base'),
)
sessionManager.setBrowserSidecarBuildContext(
	path.resolve(import.meta.dirname ?? __dirname, '../../../docker/browser-sidecar'),
)
runtimeTelemetry.startGaugeLoop(() => sessionManager.getConcurrencyByAgentServer())

const port = Number(process.env.PORT) || 3000

const app = createApp({ db, notifyBridge, sessionManager, agentStorage, storageProvider }, { port })

sessionManager.start().then(() => {
	logger.info('Session manager started')
})

const triggerRunner = new TriggerRunner(db, notifyBridge, sessionManager)
triggerRunner.start().then(() => {
	logger.info('Trigger runner started')
})

const gmailWatchRenewer = new GmailWatchRenewer(db)
gmailWatchRenewer.start()
logger.info('Gmail watch renewer started')

const webhookDeliveriesCleaner = new WebhookDeliveriesCleaner(db)
webhookDeliveriesCleaner.start()
logger.info('Webhook deliveries cleaner started')

const webhookDeliveriesReconciler = new WebhookDeliveriesReconciler(db)
webhookDeliveriesReconciler.start()
logger.info('Webhook deliveries reconciler started')

const loopVersionPusher = new LoopVersionPusher(db, agentStorage)
loopVersionPusher.start()
logger.info('Loop version pusher started')

const orphanThreadDetector = new OrphanThreadDetector(db)
orphanThreadDetector.start()
logger.info('Orphan thread detector started')

// Session dispatch queue absorbs backpressure when no agent-server has
// capacity and retries failed dispatches. In production the SessionDispatcher
// is wired as the queue's DispatchFn and SessionManager routes session-start
// through the queue instead of spawning a local Docker container; outside
// production the queue stays inert (every tick parks at no-capacity backoff)
// so local-dev keeps its Docker-based session-manager path unchanged.
const sessionDispatchQueue = new SessionDispatchQueue(db, async () => ({ kind: 'no_capacity' }), {
	// Dispatch exhaustion is otherwise invisible to the user watching the
	// session: the log stream just stops. This puts the reason, and the
	// "start a new session" recovery, into the transcript itself.
	appendSystemLog: (sessionId, content) => sessionManager.insertSystemLog(sessionId, content),
})
if (process.env.NODE_ENV === 'production') {
	const dispatcher = new SessionDispatcher({
		db,
		buildStartRequest: async (sessionId) => {
			const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
			if (!session) return null
			if (session.status !== 'starting' && session.status !== 'pending') return null
			// The session's actor can be hard-deleted between enqueue and dispatch
			// (deleting an actor, uninstalling a loop, or a loop version push all
			// remove agents and their sessions). buildLaunchSpec would throw for
			// that, and the dispatcher classifies ANY throw as a transient failure
			// — so a permanently undispatchable session burned all 5 attempts with
			// backoff before erroring out (Sentry MASKIN-DEV-4, "buildStartRequest
			// threw: Agent not found or not an agent type"). Returning null instead
			// routes it straight to permanent_failure on the first attempt.
			const [agent] = await db
				.select({ type: actors.type })
				.from(actors)
				.where(eq(actors.id, session.actorId))
				.limit(1)
			if (!agent || agent.type !== 'agent') return null
			const spec = await sessionManager.buildLaunchSpec(session)
			return {
				sessionId: session.id,
				image: spec.image,
				env: spec.env,
				memoryMib: spec.memoryMib,
				cpus: spec.cpus,
				...(spec.browserRequired && { browserRequired: true }),
				...(spec.previewGuestPorts.length > 0 && { previewGuestPorts: spec.previewGuestPorts }),
				sourceSessionId: session.sourceSessionId ?? undefined,
			}
		},
		// Interactive sessions get no ACTION_PROMPT env var — agent-run.sh's
		// interactive branch reads its first turn from stdin, fed by whatever
		// POSTs /sessions/:id/input. Mirrors session-manager.ts's launchContainer()
		// seed-turn step for the local-Docker path; without this, remotely
		// dispatched interactive sessions boot but their `claude` process blocks
		// forever on stdin, never receiving the user's opening message.
		seedInteractiveTurn: async (sessionId) => {
			const [session] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1)
			if (!session || !session.interactive || session.actionPrompt.trim().length === 0) return
			const seedTurnMessageId = (
				session.config as { conversation?: { message_id?: number } } | null
			)?.conversation?.message_id
			await sessionManager.writeInput(
				sessionId,
				{ type: 'user', message: { role: 'user', content: session.actionPrompt } },
				undefined,
				seedTurnMessageId,
			)
		},
	})
	sessionDispatchQueue.setDispatchFn(dispatcher.dispatch)
	sessionManager.setDispatchQueue(sessionDispatchQueue)
	logger.info('Session dispatcher wired for production — sessions route to agent-servers')
}
sessionDispatchQueue.start()
logger.info('Session dispatch queue started')

const shutdown = (signal: string) => {
	logger.info(`Received ${signal}, shutting down`)
	sessionDispatchQueue.stop()
	notifyBridge.stop?.()
	process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))

logger.info(`Starting server on port ${port}`)

let bootstrap: DevBootstrapResult | null = null
try {
	bootstrap = await maybeBootstrapDev(db, agentStorage, sessionManager)
	if (bootstrap) {
		logger.info('Dev bootstrap created default actor + workspace', {
			actorEmail: bootstrap.actorEmail,
			workspaceName: bootstrap.workspaceName,
		})
	}
	await seedMarketplaceIfEmpty(db)
} catch (err) {
	logger.error('Dev bootstrap failed', { error: err instanceof Error ? err.message : String(err) })
}

serve({ fetch: app.fetch, port }, () => {
	const webUrl = 'http://localhost:5173'
	const apiUrl = `http://localhost:${port}`

	const mcpSetup = bootstrap
		? `    claude mcp add maskin -e API_BASE_URL=${apiUrl} -e API_KEY=${bootstrap.apiKey} -e WORKSPACE_ID=${bootstrap.workspaceId} -- pnpm --filter @maskin/mcp start`
		: `    claude mcp add maskin -e API_BASE_URL=${apiUrl} -e API_KEY=<your_api_key> -e WORKSPACE_ID=<your_workspace_id> -- pnpm --filter @maskin/mcp start
    (find your key + workspace id in the UI under Settings)`

	const accountLine = bootstrap
		? ` 👤 ${bootstrap.created ? 'Default account' : 'Account'}: ${bootstrap.actorName} · ${bootstrap.actorEmail}  ·  workspace: "${bootstrap.workspaceName}"
    Rename it any time from the UI (Settings → Profile / Workspace) or via MCP (update_actor / update_workspace).
`
		: ''

	const banner = `
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

 🚀 Maskin is running

${accountLine}
 Two ways to get started:

 ① From the browser
    1. Open ${webUrl}/signup and create an account
    2. The UI walks you through the rest

 ② From Claude Code (or any MCP client)
    1. Connect MCP:
${mcpSetup}

    2. In Claude Code, paste one of:
       Configure my Maskin workspace with the "development" template.
       Configure my Maskin workspace with the "growth" template.
       Configure my Maskin workspace with a custom template.

 Docs: README.md  ·  API: ${apiUrl}/api/health  ·  OpenAPI: ${apiUrl}/api/openapi.json

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`
	process.stdout.write(banner)
	// TTV instrumentation: server is reachable on localhost, so this is the
	// canonical "install_completed" moment for the open-source launch bet.
	// Fire-and-forget — never blocks or throws.
	emitInstallCompleted().catch(() => {})
	sessionManager.warmAgentBaseImage().catch((err) => {
		logger.error('Failed to build agent-base image — sessions will fail until image is available', {
			error: err instanceof Error ? err.message : String(err),
		})
	})
	sessionManager.warmBrowserSidecarImage().catch((err) => {
		logger.error('Failed to prepare browser-sidecar image; browser sessions will retry on demand', {
			error: err instanceof Error ? err.message : String(err),
		})
	})
})

export default app
export type AppType = typeof app
