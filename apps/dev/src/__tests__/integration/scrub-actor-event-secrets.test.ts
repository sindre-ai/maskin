import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { splitStatements } from '@maskin/db/migrate-utils'
import { describe, expect, it } from 'vitest'
import { getTestActorId, sql } from './global-setup'

// Migration 0093 reduces old "agent deleted" and "actor reset" events to the
// identity-only shape: id, type, name, is_system. Every value below is an obviously
// fake placeholder, never a real credential.

const FAKE = 'FAKE-PLACEHOLDER-NOT-A-REAL-VALUE'
const MIGRATION = '0093_scrub_actor_event_secrets.sql'

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
	entityId: string,
	data: unknown,
): Promise<number> {
	const [row] = await sql`
		INSERT INTO events (workspace_id, actor_id, action, entity_type, entity_id, data)
		VALUES (
			${workspaceId},
			${getTestActorId()},
			${action},
			${entityType},
			${entityId},
			${JSON.stringify(data)}::jsonb
		)
		RETURNING id
	`
	return Number(row.id)
}

async function newEntityId(): Promise<string> {
	const [row] = await sql`SELECT gen_random_uuid()::text AS id`
	return row.id
}

async function getData(id: number): Promise<unknown> {
	const [row] = await sql`SELECT data FROM events WHERE id = ${id}`
	return row.data
}

async function countExtraKeyRows(): Promise<number> {
	const [row] = await sql`
		SELECT count(*)::int AS n FROM events
		WHERE ((action = 'deleted' AND entity_type = 'agent')
				OR (action = 'reset' AND entity_type = 'actor'))
			AND CASE
				WHEN jsonb_typeof(data) = 'object'
					THEN (data - ARRAY['id', 'type', 'name', 'is_system']) <> '{}'::jsonb
				ELSE false
			END
	`
	return row.n
}

async function countKindRows(): Promise<number> {
	const [row] = await sql`
		SELECT count(*)::int AS n FROM events
		WHERE (action = 'deleted' AND entity_type = 'agent')
			OR (action = 'reset' AND entity_type = 'actor')
	`
	return row.n
}

function oldShape(id: string) {
	return {
		id,
		type: 'agent',
		name: 'scrub-test-agent',
		isSystem: true,
		description: FAKE,
		system_prompt: FAKE,
		tools: { fake: { type: 'http', env: { FAKE_KEY: FAKE }, headers: { Authorization: FAKE } } },
		llm_config: { api_key: FAKE },
		memory: { note: FAKE },
		api_key_hash: FAKE,
		password_hash: FAKE,
	}
}

describe('Migration 0093 — scrub old agent deleted and actor reset events', () => {
	it('reduces old rows to identity only, leaves other rows alone, and a rerun is a no-op', async () => {
		const ws = await insertWorkspace()
		const deletedId = await newEntityId()
		const resetId = await newEntityId()
		const scrubbedId = await newEntityId()
		const otherAgentId = await newEntityId()

		const oldDeleted = await insertEvent(ws, 'agent', 'deleted', deletedId, oldShape(deletedId))
		const oldReset = await insertEvent(ws, 'actor', 'reset', resetId, {
			...oldShape(resetId),
			isSystem: false,
		})
		const alreadyScrubbed = await insertEvent(ws, 'agent', 'deleted', scrubbedId, {
			id: scrubbedId,
			type: 'agent',
			name: 'scrub-test-agent',
			is_system: false,
		})
		// Same fake extras, different kind: the filter must not touch these.
		const otherAgentEvent = await insertEvent(
			ws,
			'agent',
			'updated',
			otherAgentId,
			oldShape(otherAgentId),
		)
		const otherEntityDeleted = await insertEvent(
			ws,
			'actor',
			'deleted',
			otherAgentId,
			oldShape(otherAgentId),
		)

		const untouched = {
			alreadyScrubbed: await getData(alreadyScrubbed),
			otherAgentEvent: await getData(otherAgentEvent),
			otherEntityDeleted: await getData(otherEntityDeleted),
		}
		const countBefore = await countKindRows()
		expect(await countExtraKeyRows()).toBe(2)

		await runMigration()

		expect(await getData(oldDeleted)).toEqual({
			id: deletedId,
			type: 'agent',
			name: 'scrub-test-agent',
			is_system: true,
		})
		expect(await getData(oldReset)).toEqual({
			id: resetId,
			type: 'agent',
			name: 'scrub-test-agent',
			is_system: false,
		})
		expect(await countExtraKeyRows()).toBe(0)
		expect(await countKindRows()).toBe(countBefore)
		expect(await getData(alreadyScrubbed)).toEqual(untouched.alreadyScrubbed)
		expect(await getData(otherAgentEvent)).toEqual(untouched.otherAgentEvent)
		expect(await getData(otherEntityDeleted)).toEqual(untouched.otherEntityDeleted)

		const afterFirstRun = {
			oldDeleted: await getData(oldDeleted),
			oldReset: await getData(oldReset),
		}
		await runMigration()
		expect(await getData(oldDeleted)).toEqual(afterFirstRun.oldDeleted)
		expect(await getData(oldReset)).toEqual(afterFirstRun.oldReset)
		expect(await countKindRows()).toBe(countBefore)
	})

	it('defaults is_system to false when the old row has no flag', async () => {
		const ws = await insertWorkspace()
		const id = await newEntityId()
		const row = await insertEvent(ws, 'agent', 'deleted', id, {
			id,
			type: 'agent',
			name: 'scrub-test-agent',
			tools: { fake: FAKE },
		})

		await runMigration()

		expect(await getData(row)).toEqual({
			id,
			type: 'agent',
			name: 'scrub-test-agent',
			is_system: false,
		})
	})

	it('passes quietly when there is nothing to scrub', async () => {
		await expect(runMigration()).resolves.toBeUndefined()

		const ws = await insertWorkspace()
		const id = await newEntityId()
		await insertEvent(ws, 'agent', 'deleted', id, {
			id,
			type: 'agent',
			name: 'scrub-test-agent',
			is_system: false,
		})
		await expect(runMigration()).resolves.toBeUndefined()
	})
})
