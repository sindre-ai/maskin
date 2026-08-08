import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { createDb } from './db/connection'
import { type VaerkstedAuthEnv, parseEnv } from './lib/env'
import { challengeRoute } from './routes/challenge'
import { devicesRoute } from './routes/devices'
import { identitiesRoute } from './routes/identities'
import { sessionsRoute } from './routes/sessions'
import type { AppEnv } from './types'

export function buildApp(env: VaerkstedAuthEnv, db: ReturnType<typeof createDb>): Hono<AppEnv> {
	const app = new Hono<AppEnv>()

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
