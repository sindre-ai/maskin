import './extensions'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { createDb } from '@maskin/db'
import { PgNotifyBridge } from '@maskin/realtime'
import { S3StorageProvider } from '@maskin/storage'
import { createApp } from './app-factory'
import { type DevBootstrapResult, maybeBootstrapDev } from './lib/dev-bootstrap'
import { logger } from './lib/logger'
import { AgentStorageManager } from './services/agent-storage'
import { ContainerManager } from './services/container-manager'
import { SessionManager } from './services/session-manager'
import { TriggerRunner } from './services/trigger-runner'

// Database connection — POSTGRES_URL takes priority over DATABASE_URL
const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL
if (!databaseUrl) {
	throw new Error('POSTGRES_URL or DATABASE_URL environment variable is required')
}
const db = createDb(databaseUrl)

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

await storageProvider.ensureBucket()

const containers = new ContainerManager()
try {
	await containers.ensureImage(
		'agent-base:latest',
		path.resolve(import.meta.dirname ?? __dirname, '../../../docker/agent-base'),
	)
} catch (err) {
	logger.error('Failed to build agent-base image — sessions will fail until image is available', {
		error: err instanceof Error ? err.message : String(err),
	})
}

const agentStorage = new AgentStorageManager(storageProvider, db)

const sessionManager = new SessionManager(db, storageProvider)
sessionManager.setAgentBaseBuildContext(
	path.resolve(import.meta.dirname ?? __dirname, '../../../docker/agent-base'),
)

const port = Number(process.env.PORT) || 3000

const app = createApp({ db, notifyBridge, sessionManager, agentStorage, storageProvider }, { port })

sessionManager.start().then(() => {
	logger.info('Session manager started')
})

const triggerRunner = new TriggerRunner(db, notifyBridge, sessionManager)
triggerRunner.start().then(() => {
	logger.info('Trigger runner started')
})

logger.info(`Starting server on port ${port}`)

let bootstrap: DevBootstrapResult | null = null
try {
	bootstrap = await maybeBootstrapDev(db)
	if (bootstrap) {
		logger.info('Dev bootstrap created default actor + workspace', {
			actorEmail: bootstrap.actorEmail,
			workspaceName: bootstrap.workspaceName,
		})
	}
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
})

export default app
export type AppType = typeof app
