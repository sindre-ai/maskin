import { serve } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { createDb } from './db/connection'
import { type VaerkstedSyncEnv, parseEnv } from './lib/env'
import { challengeRoute } from './routes/challenge'
import { pullRoute } from './routes/pull'
import { pushRoute } from './routes/push'
import { createWsRoute } from './routes/ws'
import type { AppEnv } from './types'

export type BuiltApp = {
	app: Hono<AppEnv>
	injectWebSocket: ReturnType<typeof createNodeWebSocket>['injectWebSocket']
}

export function buildApp(env: VaerkstedSyncEnv, db: ReturnType<typeof createDb>): BuiltApp {
	const app = new Hono<AppEnv>()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('env', env)
		await next()
	})

	app.get('/health', (c) => c.json({ ok: true }))

	app.route('/', challengeRoute)
	app.route('/', pushRoute)
	app.route('/', pullRoute)

	// @hono/node-ws — first WS usage in this monorepo (implementation plan's
	// cross-cutting decisions table). `createNodeWebSocket` must be called
	// with the already-constructed `app` instance; the WS route is then
	// registered on that same instance via createWsRoute (see routes/ws.ts
	// for the auth-before-upgrade composition).
	const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app })
	app.route('/', createWsRoute(upgradeWebSocket))

	return { app, injectWebSocket }
}

async function main(): Promise<void> {
	const env = parseEnv()
	const db = createDb(env.VAERKSTED_SYNC_DATABASE_URL)
	const { app, injectWebSocket } = buildApp(env, db)

	const server = serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, ({ port }) => {
		console.log(`vaerksted-sync listening on port ${port}`)
	})
	// Wires the raw Node http.Server's "upgrade" event to the WS route
	// registered above — see routes/ws.ts's comment for why this is also
	// where auth-before-upgrade happens.
	injectWebSocket(server)
}

// Bundled entrypoint runs main; tests import buildApp directly without booting.
const isEntry =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/dist/index.js')
if (isEntry) {
	main().catch((err) => {
		console.error('vaerksted-sync startup failed', err)
		process.exit(1)
	})
}
