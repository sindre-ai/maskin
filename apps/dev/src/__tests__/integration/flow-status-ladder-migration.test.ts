import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { objects, workspaces } from '@maskin/db/schema'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'
import { insertActor, insertObject, insertTrigger, insertWorkspace } from '../factories'
import { db, getTestActorId, sql } from './global-setup'

// Migration 0166 renames the flow statuses and keeps running flows running. The harness has
// already replayed it on an empty database, so the rows below are seeded in the old shape and the
// file is run again. It is written to be idempotent, which the last test relies on.
const here = dirname(fileURLToPath(import.meta.url))
const migrationPath = join(
	here,
	'..',
	'..',
	'..',
	'..',
	'..',
	'packages',
	'db',
	'drizzle',
	'0166_flow_status_ladder.sql',
)

async function runMigration() {
	for (const statement of splitStatements(readFileSync(migrationPath, 'utf-8'))) {
		await sql.unsafe(statement)
	}
}

describe('migration 0166: flow status ladder', () => {
	let workspaceId: string
	let actorId: string
	let agentId: string

	beforeEach(async () => {
		actorId = getTestActorId()
		const ws = await insertWorkspace(db, actorId)
		workspaceId = ws.id
		agentId = (await insertActor(db, { type: 'agent' })).id
	})

	async function flow(status: string, triggerEnabled: boolean | null) {
		const metadata: Record<string, unknown> = {}
		if (triggerEnabled !== null) {
			const trigger = await insertTrigger(db, workspaceId, actorId, agentId, {
				enabled: triggerEnabled,
			})
			metadata.trigger_ids = [trigger.id]
		}
		return insertObject(db, workspaceId, actorId, { type: 'loop', status, metadata })
	}

	async function statusOf(id: string) {
		const [row] = await db
			.select({ status: objects.status })
			.from(objects)
			.where(eq(objects.id, id))
		return row?.status
	}

	it('moves a draft flow with an enabled trigger to supervised and leaves other drafts alone', async () => {
		const running = await flow('draft', true)
		const switchedOff = await flow('draft', false)
		const empty = await flow('draft', null)

		await runMigration()

		expect(await statusOf(running.id)).toBe('supervised')
		expect(await statusOf(switchedOff.id)).toBe('draft')
		expect(await statusOf(empty.id)).toBe('draft')
	})

	it('renames learning to pilot and fully_autonomous to live, and keeps the rest', async () => {
		const learning = await flow('learning', true)
		const autonomous = await flow('fully_autonomous', true)
		const supervised = await flow('supervised', true)
		const paused = await flow('paused', false)
		const pilot = await flow('pilot', true)

		await runMigration()

		expect(await statusOf(learning.id)).toBe('pilot')
		expect(await statusOf(autonomous.id)).toBe('live')
		expect(await statusOf(supervised.id)).toBe('supervised')
		expect(await statusOf(paused.id)).toBe('paused')
		expect(await statusOf(pilot.id)).toBe('pilot')
	})

	it('rewrites a workspace status list that still holds the old names', async () => {
		await db
			.update(workspaces)
			.set({
				settings: {
					statuses: { loop: ['draft', 'paused', 'learning', 'supervised', 'fully_autonomous'] },
				},
			})
			.where(eq(workspaces.id, workspaceId))

		await runMigration()

		const [row] = await db.select().from(workspaces).where(eq(workspaces.id, workspaceId))
		expect((row.settings as { statuses: { loop: string[] } }).statuses.loop).toEqual([
			'draft',
			'pilot',
			'supervised',
			'live',
			'paused',
			'archived',
		])
	})

	it('changes nothing on a second run', async () => {
		const running = await flow('draft', true)
		await runMigration()
		await runMigration()
		expect(await statusOf(running.id)).toBe('supervised')
	})
})
