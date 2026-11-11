import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { OpenAPIHono } from '@hono/zod-openapi'
import type { Database } from '@maskin/db'
import { splitStatements } from '@maskin/db/migrate-utils'
import { notificationPreferences } from '@maskin/db/schema'
import type { NotificationPreferencesResponse } from '@maskin/shared'
import { eq } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { validationFailureHook } from '../../lib/errors'
import { insertActor } from '../factories'
import { jsonGet, jsonRequest } from '../helpers'
import { createIntegrationApp, db, sql } from './global-setup'

const { default: actorsRoutes } = await import('../../routes/actors')
const { default: preferencesRoutes } = await import('../../routes/notification-preferences')

const URL = '/api/notification-preferences'
const here = dirname(fileURLToPath(import.meta.url))
const drizzleDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')

async function runSqlFile(relativePath: string) {
	const content = readFileSync(join(drizzleDir, relativePath), 'utf-8')
	await sql.begin(async (tx) => {
		for (const statement of splitStatements(content)) await tx.unsafe(statement)
	})
}

const hasBrowserColumn = async () =>
	(
		await sql<{ n: number }[]>`
			SELECT count(*)::int AS n FROM information_schema.columns
			WHERE table_name = 'notification_preferences' AND column_name = 'browser_categories'`
	)[0]?.n === 1

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

const get = async (app: ReturnType<typeof prefsApp>) =>
	(await app.request(jsonGet(URL))).json() as Promise<NotificationPreferencesResponse>
const put = async (app: ReturnType<typeof prefsApp>, body: unknown) =>
	(
		await app.request(jsonRequest('PUT', URL, body))
	).json() as Promise<NotificationPreferencesResponse>

describe('migration 0139_notification_preferences_browser (Integration)', () => {
	it('adds an empty column, so a row that exists today shows every kind as not asked', async () => {
		const actor = (await insertActor(db))?.id as string
		try {
			await runSqlFile('down/0139_notification_preferences_browser_down.sql')
			expect(await hasBrowserColumn()).toBe(false)
			await sql`INSERT INTO notification_preferences (actor_id) VALUES (${actor})`
			await runSqlFile('0139_notification_preferences_browser.sql')
			await runSqlFile('0139_notification_preferences_browser.sql') // safe to re-run
			expect(await hasBrowserColumn()).toBe(true)
			const [row] = await db
				.select()
				.from(notificationPreferences)
				.where(eq(notificationPreferences.actorId, actor))
			expect(row?.browserCategories).toBeNull()
			const body = await get(prefsApp(actor))
			expect(body.browser_not_asked).toEqual([
				'needs_you',
				'conversation',
				'digest',
				'tips',
				'flow_activity',
			])
			expect(body.browser_categories).toEqual(body.categories)
		} finally {
			if (!(await hasBrowserColumn())) await runSqlFile('0139_notification_preferences_browser.sql')
		}
	})
})

describe('browser switch per kind (Integration)', () => {
	it('saves and reads each kind and channel on its own', async () => {
		const actor = (await insertActor(db))?.id as string
		const app = prefsApp(actor)

		const first = await put(app, { browser_categories: { conversation: false } })
		expect(first.browser_categories).toEqual({
			needs_you: true,
			conversation: false,
			digest: true,
			tips: true,
			flow_activity: false,
		})
		expect(first.categories.conversation).toBe(true)
		expect(first.browser_not_asked).toEqual(['needs_you', 'digest', 'tips', 'flow_activity'])

		// Any kind can be turned on for the browser, and push stays as it was.
		const second = await put(app, { browser_categories: { tips: true, conversation: true } })
		expect(second.browser_categories.conversation).toBe(true)
		expect(second.browser_not_asked).toEqual(['needs_you', 'digest', 'flow_activity'])
		expect(second.categories).toEqual({
			needs_you: true,
			conversation: true,
			digest: true,
			tips: true,
			flow_activity: false,
		})
		expect(await get(app)).toMatchObject({ browser_categories: second.browser_categories })
	})

	it('turning push off for a kind does not move a browser switch that was never asked', async () => {
		const actor = (await insertActor(db))?.id as string
		const app = prefsApp(actor)

		const body = await put(app, { categories: { conversation: false } })
		expect(body.categories.conversation).toBe(false)
		// Before the change the browser followed push (on); it stays on.
		expect(body.browser_categories.conversation).toBe(true)
		expect(body.browser_not_asked).not.toContain('conversation')
		expect(body.browser_not_asked).toContain('digest')
	})

	it('gives a new sign-up Tips off for push and the browser, and the rest on', async () => {
		const signup = createIntegrationApp({ path: '/api/actors', module: actorsRoutes })
		const res = await signup.request(
			jsonRequest('POST', '/api/actors', {
				type: 'human',
				name: 'Channel Signup',
				email: `channel-signup-${Date.now()}@test.com`,
				password: 'a-very-long-password-123',
				auto_create_workspace: false,
			}),
		)
		expect(res.status).toBe(201)
		const { id } = await res.json()
		const body = await get(prefsApp(id))
		const calm = {
			needs_you: true,
			conversation: true,
			digest: true,
			tips: false,
			flow_activity: false,
		}
		expect(body.categories).toEqual(calm)
		expect(body.browser_categories).toEqual(calm)
		expect(body.browser_not_asked).toEqual([
			'needs_you',
			'conversation',
			'digest',
			'tips',
			'flow_activity',
		])
		expect(body.email_digest_enabled).toBe(true)
		expect(body.email_categories).toEqual({ flow_activity: false })
	})

	it('has the Marketplace picks switch off for everyone, saves it on its own, and keeps dismissals', async () => {
		const signedUp = (await insertActor(db))?.id as string
		await db.insert(notificationPreferences).values({ actorId: signedUp })
		const noRow = (await insertActor(db))?.id as string
		expect((await get(prefsApp(signedUp))).marketplace_picks_enabled).toBe(false)
		expect((await get(prefsApp(noRow))).marketplace_picks_enabled).toBe(false)

		const app = prefsApp(signedUp)
		const loop = '7a7a7a7a-1111-4222-8333-444455556666'
		await db
			.update(notificationPreferences)
			.set({ marketplaceDismissedLoopIds: [loop] })
			.where(eq(notificationPreferences.actorId, signedUp))
		expect((await put(app, { marketplace_picks_enabled: true })).marketplace_picks_enabled).toBe(
			true,
		)
		// An unrelated save keeps the switch and the dismissal list.
		expect((await put(app, { briefing_enabled: false })).marketplace_picks_enabled).toBe(true)
		const [row] = await db
			.select()
			.from(notificationPreferences)
			.where(eq(notificationPreferences.actorId, signedUp))
		expect(row?.marketplaceDismissedLoopIds).toEqual([loop])
		expect((await put(app, { marketplace_picks_enabled: false })).marketplace_picks_enabled).toBe(
			false,
		)
	})

	it('keeps everything on for a person with no saved row', async () => {
		const actor = (await insertActor(db))?.id as string
		const body = await get(prefsApp(actor))
		// Flow activity is opt-in: off for everyone, with or without a saved row.
		const allOn = {
			needs_you: true,
			conversation: true,
			digest: true,
			tips: true,
			flow_activity: false,
		}
		expect(body.categories).toEqual(allOn)
		expect(body.browser_categories).toEqual(allOn)
	})
})
