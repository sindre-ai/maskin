import { readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { type Database, createDb } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import { OpenAPIHono } from '@hono/zod-openapi'
import postgres from 'postgres'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
	}
}

// ── Shared state ────────────────────────────────────────────────────────────

export let db: Database
export let sql: ReturnType<typeof postgres>

let testActorId: string

/**
 * Creates an integration test app with a real DB, auth bypassed.
 * Call after beforeAll has run so `db` and `testActorId` are set.
 */
export function createIntegrationApp(
	...routeModules: Array<{ path: string; module: OpenAPIHono<Env> }>
) {
	const app = new OpenAPIHono<Env>()

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', testActorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		await next()
	})

	for (const { path, module } of routeModules) {
		app.route(path, module)
	}

	return app
}

export function getTestActorId() {
	return testActorId
}

// ── Lifecycle ───────────────────────────────────────────────────────────────

beforeAll(async () => {
	const url = process.env.DATABASE_URL
	if (!url) {
		throw new Error(
			'DATABASE_URL is required for integration tests. ' + 'Run: docker-compose up postgres -d',
		)
	}

	sql = postgres(url)
	db = createDb(url)

	// Run migrations
	const __dirname = dirname(fileURLToPath(import.meta.url))
	const migrationsDir = join(
		__dirname,
		'..',
		'..',
		'..',
		'..',
		'..',
		'..',
		'packages',
		'db',
		'drizzle',
	)
	const files = readdirSync(migrationsDir)
		.filter((f) => f.endsWith('.sql'))
		.sort()

	for (const file of files) {
		const content = readFileSync(join(migrationsDir, file), 'utf-8')
		await sql.unsafe(content)
	}

	// Create a test actor to use across all integration tests
	const [actor] = await sql`
		INSERT INTO actors (type, name, email, api_key)
		VALUES ('human', 'Integration Test Actor', 'integration@test.com', 'ank_testintegration')
		RETURNING id
	`
	testActorId = actor.id
})

beforeEach(async () => {
	// Clean all data except the test actor
	await sql`TRUNCATE session_logs, sessions, events, notifications, triggers, integrations, relationships, objects, workspace_members, workspaces CASCADE`
})

afterAll(async () => {
	// Clean up the test actor and close connection
	if (sql) {
		await sql`TRUNCATE actors CASCADE`
		await sql.end()
	}
})
