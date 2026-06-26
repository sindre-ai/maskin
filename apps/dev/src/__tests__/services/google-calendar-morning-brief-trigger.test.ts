import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
	DEV_ACTOR_WORKSPACE_COACH,
	DEV_TRIGGER_WORKSPACE_COACH_DAILY_GOOGLE_CALENDAR_MORNING_BRIEF,
} from '@maskin/shared'
import { Cron } from 'croner'
import { describe, expect, it } from 'vitest'
import { buildTriggerInsert } from '../../services/package-provisioning'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Read the seed file once; assertions below pin the catalog snapshot's
// load-bearing fields without forcing the snapshot to be extracted to a const.
const SEED_PATH = path.join(__dirname, '../../../../../packages/db/src/seed.ts')
const seedSource = readFileSync(SEED_PATH, 'utf8')

describe('Google Calendar morning brief trigger (T5 dogfood)', () => {
	it('exposes a UUID constant for the trigger', () => {
		expect(DEV_TRIGGER_WORKSPACE_COACH_DAILY_GOOGLE_CALENDAR_MORNING_BRIEF).toMatch(UUID_RE)
	})

	it('is wired into the Workspace Coach catalog package in seed.ts', () => {
		expect(seedSource).toContain('DEV_TRIGGER_WORKSPACE_COACH_DAILY_GOOGLE_CALENDAR_MORNING_BRIEF')
		expect(seedSource).toContain('Google Calendar morning brief → founders')
		expect(seedSource).toContain("config: { expression: '0 6 * * *' }")
	})

	it('action prompt drives the bet’s read-tool surface and a Slack DM', () => {
		// The bet's First test pins the dogfood surface to these read tools and a
		// Slack DM; if any of the names drift the prompt stops driving T3's tools.
		expect(seedSource).toContain('list_calendar_events')
		expect(seedSource).toContain('get_free_busy')
		expect(seedSource).toContain('slack_send_message')
		expect(seedSource).toContain('slack_search_users')
		// Bail clause + integration provider key must match T1's kebab-case landing
		// (the prompt is itself a template literal, so backticks are backslash-escaped).
		expect(seedSource).toContain('\\`google-calendar\\`')
	})

	it('builds a valid cron trigger insert for the Workspace Coach', () => {
		const snapshot = {
			name: 'Google Calendar morning brief → founders',
			type: 'cron',
			config: { expression: '0 6 * * *' },
			actionPrompt: 'noop',
			targetActorId: DEV_ACTOR_WORKSPACE_COACH,
			enabled: true,
		}
		const insert = buildTriggerInsert(
			'00000000-0000-0000-0000-000000000000',
			snapshot,
			{},
			'00000000-0000-0000-0000-000000000001',
		)
		expect(insert.type).toBe('cron')
		expect(insert.enabled).toBe(true)
		expect(insert.targetActorId).toBe(DEV_ACTOR_WORKSPACE_COACH)
		expect((insert.config as { expression: string }).expression).toBe('0 6 * * *')
	})

	it('cron expression parses and fires at 06:00 UTC (= 08:00 Copenhagen CEST)', () => {
		// `Cron` throws on invalid expressions, so reaching the .nextRun call is
		// the parse assertion. The 06:00 UTC slot is what the existing daily
		// digest convention assumes for Copenhagen wall-clock during CEST.
		const job = new Cron('0 6 * * *', { timezone: 'UTC' })
		const next = job.nextRun(new Date('2026-06-01T00:00:00Z'))
		job.stop()
		expect(next).not.toBeNull()
		expect(next?.getUTCHours()).toBe(6)
		expect(next?.getUTCMinutes()).toBe(0)
	})
})
