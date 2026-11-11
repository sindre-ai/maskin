import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { splitStatements } from '@maskin/db/migrate-utils'
import { events, notificationPreferences } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { validationFailureHook } from '../../lib/errors'
import { insertActor, insertWorkspace } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, sql } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: emailStopRoutes } = await import('../../routes/email-stop')
const { default: preferencesRoutes } = await import('../../routes/notification-preferences')
const { signEmailStopToken } = await import('../../lib/email-stop-token')

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(drizzleDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) await tx.unsafe(statement)
	})
}

const UP = '0138_notification_preferences_email.sql'
const DOWN = 'down/0138_notification_preferences_email_down.sql'

const hasEmailColumn = async () =>
	(
		await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM information_schema.columns
			WHERE table_name = 'notification_preferences' AND column_name = 'email_digest_enabled'`
	)[0]?.n === 1

async function savedRow(actorId: string) {
	const [row] = await db
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.actorId, actorId))
	return row
}

const SECRET = 'integration-test-email-stop-secret-0123456789'

function stopApp() {
	const app = new Hono<{ Variables: { db: Database } }>()
	app.use('*', async (c, next) => {
		c.set('db', db)
		await next()
	})
	app.route('/api/email/stop', emailStopRoutes)
	return app
}

function prefsApp(actorId: string) {
	const app = new OpenAPIHono<{ Variables: { db: Database; actorId: string; actorType: string } }>({
		defaultHook: validationFailureHook,
	})
	app.use('*', async (c, next) => {
		c.set('db', db)
		c.set('actorId', actorId)
		c.set('actorType', 'human')
		await next()
	})
	app.route('/api/notification-preferences', preferencesRoutes)
	return app
}

describe('migration 0138_notification_preferences_email (Integration)', () => {
	it('leaves existing rows with an empty email choice, step 0 and no send date', async () => {
		const actor = (await insertActor(db))?.id as string
		try {
			await runSqlFile(DOWN)
			expect(await hasEmailColumn()).toBe(false)
			// A row that existed before the migration.
			await sql`INSERT INTO notification_preferences (actor_id) VALUES (${actor})`

			await runSqlFile(UP)
			await runSqlFile(UP)

			expect(await hasEmailColumn()).toBe(true)
			const row = await savedRow(actor)
			expect(row?.emailDigestEnabled).toBeNull()
			expect(row?.emailOnboardingStep).toBe(0)
			expect(row?.emailLastSentOn).toBeNull()
		} finally {
			if (!(await hasEmailColumn())) await runSqlFile(UP)
		}
	})

	it('refuses an onboarding step outside 0 to 3', async () => {
		const actor = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: actor })
		await expect(
			sql`UPDATE notification_preferences SET email_onboarding_step = 4 WHERE actor_id = ${actor}`,
		).rejects.toThrow()
	})
})

describe('email switch (Integration)', () => {
	beforeEach(() => {
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', SECRET)
	})
	afterEach(() => {
		vi.unstubAllEnvs()
	})

	it('sign-up saves a settings row with email on', async () => {
		const app = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const res = await app.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Email Signup',
				email: `email-signup-${Date.now()}@test.com`,
				password: 'a-very-long-password-123',
				auto_create_workspace: false,
			}),
		)
		expect(res.status).toBe(201)
		const { id } = await res.json()
		const row = await savedRow(id)
		expect(row?.emailDigestEnabled).toBe(true)
	})

	it('Settings shows the saved choice and a saved choice beats activity', async () => {
		const actor = (await insertActor(db))?.id as string
		const app = prefsApp(actor)
		const ws = (await insertWorkspace(db, actor))?.id as string

		// No row, no activity: the sending rule gives off.
		let body = await (await app.request(jsonGet('/api/notification-preferences'))).json()
		expect(body.email_digest_enabled).toBe(false)

		// No row, real activity in the last 30 days: the sending rule gives on, and nothing is saved.
		await db.insert(events).values({
			workspaceId: ws,
			actorId: actor,
			action: 'updated',
			entityType: 'object',
			entityId: actor,
		})
		body = await (await app.request(jsonGet('/api/notification-preferences'))).json()
		expect(body.email_digest_enabled).toBe(true)
		expect(await savedRow(actor)).toBeUndefined()

		// A push-only save keeps the email choice empty.
		await app.request(jsonRequest('PUT', '/api/notification-preferences', { briefing_time: 600 }))
		expect((await savedRow(actor))?.emailDigestEnabled).toBeNull()

		// Switching email off in Settings saves it and wins over the activity.
		const off = await app.request(
			jsonRequest('PUT', '/api/notification-preferences', { email_digest_enabled: false }),
		)
		expect((await off.json()).email_digest_enabled).toBe(false)
		expect((await savedRow(actor))?.emailDigestEnabled).toBe(false)
		body = await (await app.request(jsonGet('/api/notification-preferences'))).json()
		expect(body.email_digest_enabled).toBe(false)
	})

	it('does not count the two automatic kinds of activity rows', async () => {
		const actor = (await insertActor(db))?.id as string
		const ws = (await insertWorkspace(db, actor))?.id as string
		await db.insert(events).values([
			{
				workspaceId: ws,
				actorId: actor,
				action: 'created',
				entityType: 'integration',
				entityId: ws,
			},
			{
				workspaceId: ws,
				actorId: actor,
				action: 'created',
				entityType: 'notification_preferences',
				entityId: actor,
			},
		])
		const body = await (
			await prefsApp(actor).request(jsonGet('/api/notification-preferences'))
		).json()
		expect(body.email_digest_enabled).toBe(false)
	})

	it('the stop link turns email off for a person with a row', async () => {
		const actor = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: actor, emailDigestEnabled: true })
		const token = signEmailStopToken(actor)
		const app = stopApp()

		// Opening the link only asks; it changes nothing.
		const page = await app.request(`/api/email/stop?token=${token}`)
		expect(page.status).toBe(200)
		expect(await page.text()).toContain('Stop emails')
		expect((await savedRow(actor))?.emailDigestEnabled).toBe(true)

		const done = await app.request(`/api/email/stop?token=${token}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: `token=${encodeURIComponent(token)}`,
		})
		expect(done.status).toBe(200)
		expect((await savedRow(actor))?.emailDigestEnabled).toBe(false)
	})

	it('the stop link turns email off for a person with no row, creating one', async () => {
		const actor = (await insertActor(db))?.id as string
		expect(await savedRow(actor)).toBeUndefined()
		const token = signEmailStopToken(actor)

		// The one-click form mail apps send: token in the URL, fixed body.
		const res = await stopApp().request(`/api/email/stop?token=${token}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: 'List-Unsubscribe=One-Click',
		})
		expect(res.status).toBe(200)
		expect((await savedRow(actor))?.emailDigestEnabled).toBe(false)
	})

	it('a changed link changes nothing', async () => {
		const actor = (await insertActor(db))?.id as string
		const other = (await insertActor(db))?.id as string
		const token = signEmailStopToken(actor)
		const [id, expiry, sig] = token.split('.') as [string, string, string]
		const app = stopApp()

		for (const bad of [`${other}.${expiry}.${sig}`, `${id}.${Number(expiry) + 1}.${sig}`, 'nope']) {
			const res = await app.request(`/api/email/stop?token=${bad}`, { method: 'POST' })
			expect(res.status).toBe(400)
		}
		expect(await savedRow(actor)).toBeUndefined()
		expect(await savedRow(other)).toBeUndefined()
	})

	it('refuses every link when the secret is missing', async () => {
		const actor = (await insertActor(db))?.id as string
		const token = signEmailStopToken(actor)
		vi.stubEnv('EMAIL_STOP_LINK_SECRET', '')
		const res = await stopApp().request(`/api/email/stop?token=${token}`, { method: 'POST' })
		expect(res.status).toBe(503)
		expect(await savedRow(actor)).toBeUndefined()
	})
})
