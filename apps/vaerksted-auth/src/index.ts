import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { cors } from 'hono/cors'
import { createDb } from './db/connection'
import { type VaerkstedAuthEnv, parseEnv } from './lib/env'
import { challengeRoute } from './routes/challenge'
import { devicesRoute } from './routes/devices'
import { identitiesRoute } from './routes/identities'
import { sessionsRoute } from './routes/sessions'
import type { AppEnv } from './types'

// POST /identities and POST /sessions are called directly from browser JS
// (apps/web/src/hooks/use-vaerksted-auth.ts — M5's "Continue with vaerksted"),
// so this needs real CORS handling, including the preflight OPTIONS request
// browsers send ahead of a JSON POST. Without it, the browser's preflight
// has no route to land on (404) and blocks the real request client-side —
// same CORS_ORIGIN pattern as apps/dev/src/app-factory.ts, for consistency.
// Skjald's calls to this service happen from Rust (reqwest), which isn't
// subject to CORS, so this is purely for browser-based callers.
const allowedOrigins = process.env.CORS_ORIGIN
	? process.env.CORS_ORIGIN.split(',').map((o) => o.trim())
	: ['http://localhost:5173', 'http://localhost:5174']

export function buildApp(env: VaerkstedAuthEnv, db: ReturnType<typeof createDb>): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

	app.use('*', cors({ origin: allowedOrigins }))

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('env', env)
		await next()
	})

	app.get('/health', (c) => c.json({ ok: true }))

	app.route('/', challengeRoute)
	app.route('/', identitiesRoute)
	app.route('/', sessionsRoute)
	app.route('/', devicesRoute)

	return app
}

async function main(): Promise<void> {
	const env = parseEnv()
	const db = createDb(env.VAERKSTED_AUTH_DATABASE_URL)
	const app = buildApp(env, db)

	serve({ fetch: app.fetch, port: env.PORT, hostname: '0.0.0.0' }, ({ port }) => {
		console.log(`vaerksted-auth listening on port ${port}`)
	})
}

// Bundled entrypoint runs main; tests import buildApp directly without booting.
const isEntry =
	import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('/dist/index.js')
if (isEntry) {
	main().catch((err) => {
		console.error('vaerksted-auth startup failed', err)
		process.exit(1)
	})
}
