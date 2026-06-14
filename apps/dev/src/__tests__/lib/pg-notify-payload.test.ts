import { readFile, readdir } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

// O6 regression — the events PG NOTIFY payload must NOT carry the full event `data`
// (which contains the previous + updated object, including `content`). Postgres NOTIFY
// has an 8KB cap and silently rolls back the originating INSERT if the payload exceeds
// it — so re-introducing `NEW.data` here would lose meeting status_changed events for
// any meeting with a transcript >8KB. The summarization agent reads `content` via
// `get_objects`, not from the NOTIFY payload, exactly because of this constraint.
//
// History: migration 0006_notify_drop_data.sql redefined notify_event() without `data`
// after PR #224 reintroduced the same bug in session_logs. This test asserts no later
// migration silently brings `NEW.data` back into the events notify payload.

const MIGRATIONS_DIR = resolve(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../../packages/db/drizzle',
)

async function loadEventsNotifyFunction(): Promise<string> {
	const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith('.sql')).sort()

	let latest: string | null = null
	for (const file of files) {
		const sql = await readFile(join(MIGRATIONS_DIR, file), 'utf8')
		// Match the most recent CREATE OR REPLACE FUNCTION notify_event() body.
		const re = /CREATE OR REPLACE FUNCTION notify_event\(\)[\s\S]*?LANGUAGE plpgsql;/gi
		const matches = sql.match(re)
		if (matches && matches.length > 0) {
			latest = matches[matches.length - 1]
		}
	}
	if (!latest) throw new Error('No notify_event() definition found in migrations')
	return latest
}

describe('events PG NOTIFY payload (O6)', () => {
	it('emits via pg_notify on the events channel', async () => {
		const fn = await loadEventsNotifyFunction()
		expect(fn).toMatch(/pg_notify\(\s*'events'/)
	})

	it('does not include NEW.data — content travels via events.data, not the NOTIFY payload (8KB cap)', async () => {
		const fn = await loadEventsNotifyFunction()
		expect(fn).not.toMatch(/'data'\s*,\s*NEW\.data/)
		expect(fn).not.toMatch(/NEW\.content/)
	})

	it('keeps the minimal lookup keys consumers need to fetch the row', async () => {
		const fn = await loadEventsNotifyFunction()
		for (const key of [
			'event_id',
			'workspace_id',
			'actor_id',
			'action',
			'entity_type',
			'entity_id',
		]) {
			expect(fn).toContain(`'${key}'`)
		}
	})
})
