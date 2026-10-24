import { randomBytes } from 'node:crypto'
import { OpenAPIHono } from '@hono/zod-openapi'
import { type Database, createDb } from '@maskin/db'
import type { PgNotifyBridge } from '@maskin/realtime'
import postgres from 'postgres'
import { ApiErrorCode, createApiError, formatZodError, mapStatusToCode } from '../../lib/errors'
import { PlanCapExceededError } from '../../lib/llm-routing'
import { OwnershipCapExceededError, SeatCapExceededError } from '../../lib/workspace-capacity'
import type { AgentStorageManager } from '../../services/agent-storage'
import type { SessionManager } from '../../services/session-manager'
import { TEMPLATE_DB, withDatabase } from './global-db-template'

type Env = {
	Variables: {
		db: Database
		actorId: string
		actorType: string
		notifyBridge: PgNotifyBridge
		sessionManager: SessionManager
		agentStorage: AgentStorageManager
	}
}

// ── Shared state ────────────────────────────────────────────────────────────

export let db: Database
export let sql: ReturnType<typeof postgres>

let testActorId: string
let baseUrl: string | undefined
let dbName: string | undefined

// Set by tests whose routes read c.get('agentStorage'). Kept as a setter so this
// shared harness does not import the storage service for every test file.
let testAgentStorage: AgentStorageManager | undefined

export function setTestAgentStorage(agentStorage: AgentStorageManager | undefined) {
	testAgentStorage = agentStorage
}

/**
 * Creates an integration test app with a real DB, auth bypassed.
 * Call after beforeAll has run so `db` and `testActorId` are set.
 */
export function createIntegrationApp(
	...routeModules: Array<{ path: string; module: OpenAPIHono<Env> }>
) {
	const app = new OpenAPIHono<Env>({
		defaultHook: (result, c) => {
			if (!result.success) {
				return c.json(
					createApiError(
						'VALIDATION_ERROR',
						'Request validation failed',
						formatZodError(result.error),
					),
					400,
				)
			}
			return undefined
		},
	})

	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', testActorId)
		c.set('actorType', 'human')
		c.set('notifyBridge', {} as PgNotifyBridge)
		// Routes fire-and-forget a welcome/onboarding session via
		// c.get('sessionManager').createSession(...) (see routes/workspaces.ts),
		// and routes that delete an actor/loop stop that actor's live sessions
		// first (see stopSessionsForActors). Both are read unguarded, so every
		// route mounted through this shared harness needs a resolving stub here
		// even if the test never asserts on session lifecycle itself.
		c.set('sessionManager', {
			stopSession: async () => {},
			createSession: async () => ({}),
		} as unknown as SessionManager)
		if (testAgentStorage) c.set('agentStorage', testAgentStorage)
		await next()
	})

	// Mirrors the cap-exceeded branches of app-factory.ts's onError (minus
	// Sentry/verbose logging, which aren't relevant to this harness) so
	// integration tests exercise the same thrown-error → typed-response mapping
	// real requests get in production, instead of a raw framework 500.
	app.onError((err, c) => {
		if (err instanceof PlanCapExceededError) {
			return c.json(
				{
					error: {
						code: ApiErrorCode.PLAN_CAP_EXCEEDED,
						message: err.message,
						plan: err.plan,
						used: err.used,
						cap: err.cap,
						period_end: err.periodEnd,
					},
				},
				402,
			)
		}
		if (err instanceof SeatCapExceededError) {
			return c.json(
				{
					error: {
						code: ApiErrorCode.SEAT_CAP_EXCEEDED,
						message: err.message,
						workspace_id: err.workspaceId,
						plan: err.plan,
						used: err.used,
						cap: err.cap,
					},
				},
				403,
			)
		}
		if (err instanceof OwnershipCapExceededError) {
			return c.json(
				{
					error: {
						code: ApiErrorCode.OWNERSHIP_CAP_EXCEEDED,
						message: err.message,
						actor_id: err.actorId,
						effective_tier: err.effectiveTier,
						used: err.used,
						cap: err.cap,
					},
				},
				403,
			)
		}
		if ('status' in err && typeof err.status === 'number') {
			return c.json(createApiError(mapStatusToCode(err.status), err.message), err.status as 400)
		}
		return c.json(createApiError(ApiErrorCode.INTERNAL_ERROR, 'An unexpected error occurred'), 500)
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

	// Every test file gets its own database cloned from the migrated template
	// (global-db-template.ts), so files are isolated from each other and can run
	// in parallel workers. Tests that open their own connection (e.g. a
	// PgNotifyBridge) read DATABASE_URL, so point it at this file's database.
	baseUrl = url
	dbName = `maskin_it_${process.pid}_${randomBytes(4).toString('hex')}`
	const admin = postgres(url, { max: 1, onnotice: () => {} })
	try {
		await admin.unsafe(`CREATE DATABASE "${dbName}" TEMPLATE "${TEMPLATE_DB}"`)
	} finally {
		await admin.end()
	}
	const fileUrl = withDatabase(url, dbName)
	process.env.DATABASE_URL = fileUrl

	sql = postgres(fileUrl, { onnotice: () => {} })
	db = createDb(fileUrl)

	// Create a test actor to use across all integration tests
	const [actor] = await sql`
		INSERT INTO actors (type, name, email, api_key)
		VALUES ('human', 'Integration Test Actor', 'integration@test.com', 'ank_testintegration')
		RETURNING id
	`
	testActorId = actor.id
})

beforeEach(async () => {
	// Clean all data except the test actor. A previous test can leave fire-and-forget work running
	// (e.g. the new agent's intro chat), which takes row locks that TRUNCATE's table locks can
	// deadlock against. Postgres aborts one side; retrying the cleanup is safe.
	for (let attempt = 1; ; attempt++) {
		try {
			await sql`TRUNCATE session_logs, sessions, events, notifications, triggers, integrations, linkedin_tool_calls, linkedin_actions, relationships, read_state, subscriptions, objects, workspace_members, workspaces CASCADE`
			break
		} catch (err) {
			if ((err as { code?: string }).code !== '40P01' || attempt >= 5) throw err
			await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
		}
	}

	// actors.default_workspace_id references workspaces, so Postgres cascades the
	// TRUNCATE above into actors (CASCADE follows FK definitions, not row data) and
	// removes the test actor. Put it back under the same id so every test still
	// finds it, as the comment above promises.
	await sql`
		INSERT INTO actors (id, type, name, email, api_key)
		VALUES (${testActorId}, 'human', 'Integration Test Actor', 'integration@test.com', 'ank_testintegration')
		ON CONFLICT (id) DO NOTHING
	`
})

afterAll(async () => {
	// Close every connection (`createDb()` opens its own independent postgres.js
	// client, separate pool from `sql` — see known-pitfalls.md), then drop this
	// file's database so clones don't accumulate across the run.
	if (sql) await sql.end()
	if (db) await db.$client.end()
	if (baseUrl && dbName) {
		process.env.DATABASE_URL = baseUrl
		const admin = postgres(baseUrl, { max: 1, onnotice: () => {} })
		try {
			await admin.unsafe(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`)
		} finally {
			await admin.end()
		}
	}
})
