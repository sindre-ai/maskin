/**
 * The summary email rhythm against real Postgres: the migration leaves every existing row empty
 * (daily), the Settings API saves and returns Daily or Weekly, and a move between them fires
 * email_rhythm_changed but never email_switched_off. Off is still the email switch.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { splitStatements } from '@maskin/db/migrate-utils'
import { notificationPreferences } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const capture = vi.fn()
vi.mock('../../lib/analytics/posthog', async (importOriginal) => ({
	...(await importOriginal<typeof import('../../lib/analytics/posthog')>()),
	capturePosthogEvent: (...args: unknown[]) => capture(...args),
}))

import { validationFailureHook } from '../../lib/errors'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { db, sql } from './global-setup'

const { default: preferencesRoutes } = await import('../../routes/notification-preferences')

const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(drizzleDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) await tx.unsafe(statement)
	})
}

const UP = '0145_notification_preferences_email_rhythm.sql'
const DOWN = 'down/0145_notification_preferences_email_rhythm_down.sql'

const hasRhythmColumn = async () =>
	(
		await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM information_schema.columns
			WHERE table_name = 'notification_preferences' AND column_name = 'email_rhythm'`
	)[0]?.n === 1

async function savedRow(actorId: string) {
	const [row] = await db
		.select()
		.from(notificationPreferences)
		.where(eq(notificationPreferences.actorId, actorId))
	return row
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

const events = () => capture.mock.calls.map(([name]) => name)

beforeEach(() => capture.mockReset())

describe('migration 0145_notification_preferences_email_rhythm (Integration)', () => {
	it('leaves existing rows empty, is safe twice, and refuses anything but daily or weekly', async () => {
		const actor = (await insertActor(db))?.id as string
		try {
			await runSqlFile(DOWN)
			expect(await hasRhythmColumn()).toBe(false)
			await sql`INSERT INTO notification_preferences (actor_id) VALUES (${actor})`

			await runSqlFile(UP)
			await runSqlFile(UP)

			expect(await hasRhythmColumn()).toBe(true)
			expect((await savedRow(actor))?.emailRhythm).toBeNull()
			await expect(
				sql`UPDATE notification_preferences SET email_rhythm = 'hourly' WHERE actor_id = ${actor}`,
			).rejects.toThrow()
			await sql`UPDATE notification_preferences SET email_rhythm = 'weekly' WHERE actor_id = ${actor}`
		} finally {
			if (!(await hasRhythmColumn())) await runSqlFile(UP)
		}
	})
})

describe('email rhythm in Settings (Integration)', () => {
	it('a person with no choice sees Daily, and a push-only save leaves the choice empty', async () => {
		const actor = (await insertActor(db))?.id as string
		const app = prefsApp(actor)

		const before = await (await app.request(jsonGet('/api/notification-preferences'))).json()
		expect(before.email_rhythm).toBe('daily')

		await app.request(jsonRequest('PUT', '/api/notification-preferences', { briefing_time: 600 }))
		expect((await savedRow(actor))?.emailRhythm).toBeNull()
		const after = await (await app.request(jsonGet('/api/notification-preferences'))).json()
		expect(after.email_rhythm).toBe('daily')
	})

	it('Weekly is saved and returned, and Daily to Weekly is not a switch-off', async () => {
		const actor = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: actor, emailDigestEnabled: true })
		const app = prefsApp(actor)

		const res = await app.request(
			jsonRequest('PUT', '/api/notification-preferences', { email_rhythm: 'weekly' }),
		)
		expect(res.status).toBe(200)
		const body = await res.json()
		expect(body.email_rhythm).toBe('weekly')
		expect(body.email_digest_enabled).toBe(true)
		expect(await savedRow(actor)).toMatchObject({ emailRhythm: 'weekly', emailDigestEnabled: true })
		expect(capture).toHaveBeenCalledTimes(1)
		expect(capture).toHaveBeenCalledWith('email_rhythm_changed', actor, {
			from: 'daily',
			to: 'weekly',
		})
		expect(events()).not.toContain('email_switched_off')

		// Saving the same rhythm again changes nothing and fires nothing.
		await app.request(
			jsonRequest('PUT', '/api/notification-preferences', { email_rhythm: 'weekly' }),
		)
		expect(capture).toHaveBeenCalledTimes(1)

		// Back to Daily.
		await app.request(
			jsonRequest('PUT', '/api/notification-preferences', { email_rhythm: 'daily' }),
		)
		expect(capture).toHaveBeenLastCalledWith('email_rhythm_changed', actor, {
			from: 'weekly',
			to: 'daily',
		})
	})

	it('Off is the email switch: it fires email_switched_off and keeps the rhythm', async () => {
		const actor = (await insertActor(db))?.id as string
		await db
			.insert(notificationPreferences)
			.values({ actorId: actor, emailDigestEnabled: true, emailRhythm: 'weekly' })
		const app = prefsApp(actor)

		const res = await app.request(
			jsonRequest('PUT', '/api/notification-preferences', { email_digest_enabled: false }),
		)
		const body = await res.json()
		expect(body.email_digest_enabled).toBe(false)
		expect(body.email_rhythm).toBe('weekly')
		expect(events()).toEqual(['email_switched_off'])
	})

	it('refuses a rhythm that is not daily or weekly', async () => {
		const actor = (await insertActor(db))?.id as string
		const res = await prefsApp(actor).request(
			jsonRequest('PUT', '/api/notification-preferences', { email_rhythm: 'hourly' }),
		)
		expect(res.status).toBe(400)
		expect(await savedRow(actor)).toBeUndefined()
	})
})
