import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { userDisplaySettings } from '@maskin/db/schema'
import { eq, sql } from 'drizzle-orm'
import { describe, expect, it } from 'vitest'
import { insertWorkspace } from '../factories'
import { db, getTestActorId } from './global-setup'

// Migration 0118 flips saved Objects-page views from grouped-by-State to flat. It is
// run here on rows the old default left behind, inside a transaction that is rolled
// back so it cannot touch other tests' rows.
const migration = readFileSync(
	join(
		__dirname,
		'../../../../../packages/db/drizzle/0118_objects_display_settings_flat_default.sql',
	),
	'utf-8',
)

describe('the 0118 flat-default backfill', () => {
	it('clears a saved State grouping on Objects-page rows and leaves everything else alone', async () => {
		const actorId = getTestActorId()
		const { id: workspaceId } = await insertWorkspace(db, actorId)
		const seed = [
			{ objectType: 'bet', settings: { groupBy: 'status', sort: 'title' } },
			{ objectType: '__all__', settings: { groupBy: 'status' } },
			{ objectType: 'task', settings: { groupBy: 'driver' } },
			{ objectType: 'insight', settings: { groupBy: 'none' } },
			{ objectType: 'knowledge', settings: { sort: 'title' } },
			{ objectType: 'agents', settings: { groupBy: 'status' } },
			{ objectType: 'files', settings: { groupBy: 'status' } },
			{ objectType: 'loop', settings: { groupBy: 'status' } },
			{ objectType: '__chrome__', settings: { groupBy: 'status' } },
		]
		await db
			.insert(userDisplaySettings)
			.values(seed.map((s) => ({ workspaceId, actorId, name: 'default', ...s })))

		const after = new Map<string, unknown>()
		const rollback = new Error('rollback')
		await db
			.transaction(async (tx) => {
				await tx.execute(sql.raw(migration))
				const rows = await tx
					.select({ type: userDisplaySettings.objectType, settings: userDisplaySettings.settings })
					.from(userDisplaySettings)
					.where(eq(userDisplaySettings.workspaceId, workspaceId))
				for (const r of rows) after.set(r.type, r.settings)
				throw rollback
			})
			.catch((err) => {
				if (err !== rollback) throw err
			})

		// State grouping cleared; the rest of the row (sort) is kept.
		expect(after.get('bet')).toEqual({ groupBy: 'none', sort: 'title' })
		expect(after.get('__all__')).toEqual({ groupBy: 'none' })
		// Other groupings, an explicit flat choice and rows with no grouping are untouched.
		expect(after.get('task')).toEqual({ groupBy: 'driver' })
		expect(after.get('insight')).toEqual({ groupBy: 'none' })
		expect(after.get('knowledge')).toEqual({ sort: 'title' })
		// Rows other screens keep in this table are not the Objects page's to change.
		for (const key of ['agents', 'files', 'loop', '__chrome__']) {
			expect(after.get(key)).toEqual({ groupBy: 'status' })
		}
	})
})
