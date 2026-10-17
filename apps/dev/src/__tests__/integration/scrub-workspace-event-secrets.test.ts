import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { describe, expect, it } from 'vitest'
import { getTestActorId, sql } from './global-setup'

// Migration 0092 removes llm_keys, custom_llm and claude_oauth from the workspace
// snapshot that old "workspace updated" events carry. Every value below is an
// obviously fake placeholder, never a real credential.

const FAKE = 'FAKE-PLACEHOLDER-NOT-A-REAL-VALUE'
const MIGRATION = '0092_scrub_workspace_event_secrets.sql'

async function runMigration(): Promise<void> {
	const here = dirname(fileURLToPath(import.meta.url))
	const migrationsDir = join(here, '..', '..', '..', '..', '..', 'packages', 'db', 'drizzle')
	const content = readFileSync(join(migrationsDir, MIGRATION), 'utf-8')
	for (const statement of splitStatements(content)) {
		await sql.unsafe(statement)
	}
}

async function insertWorkspace(): Promise<string> {
	const [workspace] = await sql`
		INSERT INTO workspaces (name, settings, created_by)
		VALUES ('scrub-test-ws', '{}', ${getTestActorId()})
		RETURNING id
	`
	return workspace.id
}

async function insertEvent(
	workspaceId: string,
	entityType: string,
	action: string,
	data: unknown,
): Promise<number> {
	const [row] = await sql`
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		VALUES (
			${workspaceId},
			${getTestActorId()},
			${action},
			${entityType},
			gen_random_uuid(),
			${sql.json(data as Parameters<typeof sql.json>[0])}
		)
		RETURNING id
	`
	return Number(row.id)
}

async function getData(id: number): Promise<unknown> {
	const [row] = await sql`SELECT data FROM events WHERE id = ${id}`
	return row.data
}

async function countKeyCarriers(): Promise<number> {
	const [row] = await sql`
		SELECT count(*)::int AS n FROM events
		WHERE entity_type = 'workspace' AND action = 'updated'
			AND data->'updated'->'settings' ?| array['llm_keys', 'custom_llm', 'claude_oauth']
	`
	return row.n
}

async function countWorkspaceUpdated(): Promise<number> {
	const [row] = await sql`
		SELECT count(*)::int AS n FROM events
		WHERE entity_type = 'workspace' AND action = 'updated'
	`
	return row.n
}

describe('Migration 0092 — scrub credentials out of workspace updated events', () => {
	it('removes the three keys, keeps everything else, and a rerun is a no-op', async () => {
		const ws = await insertWorkspace()

		const oldShape = await insertEvent(ws, 'workspace', 'updated', {
			updated: {
				id: ws,
				name: 'scrub-test-ws',
				settings: {
					llm_keys: { anthropic: FAKE },
					custom_llm: { base_url: 'https://fake.invalid', api_key: FAKE },
					claude_oauth: { slots: [{ access_token: FAKE }] },
					billing: { plan: 'free' },
					theme: 'dark',
				},
			},
		})
		const newShape = await insertEvent(ws, 'workspace', 'updated', {
			changes: [{ field: 'name' }],
			changed_settings_keys: ['custom_llm'],
		})
		const noKeys = await insertEvent(ws, 'workspace', 'updated', {
			updated: { id: ws, name: 'scrub-test-ws', settings: { billing: { plan: 'free' } } },
		})
		const otherEntity = await insertEvent(ws, 'actor', 'updated', {
			updated: { settings: { llm_keys: { anthropic: FAKE } } },
		})
		const otherAction = await insertEvent(ws, 'workspace', 'deleted', {
			updated: { settings: { llm_keys: { anthropic: FAKE } } },
		})

		const untouched = {
			newShape: await getData(newShape),
			noKeys: await getData(noKeys),
			otherEntity: await getData(otherEntity),
			otherAction: await getData(otherAction),
		}
		const countBefore = await countWorkspaceUpdated()
		expect(await countKeyCarriers()).toBe(1)

		await runMigration()

		expect(await getData(oldShape)).toEqual({
			updated: {
				id: ws,
				name: 'scrub-test-ws',
				settings: { billing: { plan: 'free' }, theme: 'dark' },
			},
		})
		expect(await countKeyCarriers()).toBe(0)
		expect(await countWorkspaceUpdated()).toBe(countBefore)
		expect(await getData(newShape)).toEqual(untouched.newShape)
		expect(await getData(noKeys)).toEqual(untouched.noKeys)
		// Non-workspace-updated events keep their keys: the scrub is scoped to one event kind.
		expect(await getData(otherEntity)).toEqual(untouched.otherEntity)
		expect(await getData(otherAction)).toEqual(untouched.otherAction)

		const afterFirstRun = await getData(oldShape)
		await runMigration()
		expect(await getData(oldShape)).toEqual(afterFirstRun)
		expect(await countWorkspaceUpdated()).toBe(countBefore)
	})

	it('passes quietly when there is nothing to scrub', async () => {
		await expect(runMigration()).resolves.toBeUndefined()

		const ws = await insertWorkspace()
		await insertEvent(ws, 'workspace', 'updated', {
			updated: { settings: { billing: { plan: 'free' } } },
		})
		await expect(runMigration()).resolves.toBeUndefined()
	})

	it('leaves rows alone when settings is not an object', async () => {
		const ws = await insertWorkspace()
		const nullSettings = await insertEvent(ws, 'workspace', 'updated', {
			updated: { settings: null },
		})
		const noUpdated = await insertEvent(ws, 'workspace', 'updated', {})

		await runMigration()

		expect(await getData(nullSettings)).toEqual({ updated: { settings: null } })
		expect(await getData(noUpdated)).toEqual({})
	})
})
