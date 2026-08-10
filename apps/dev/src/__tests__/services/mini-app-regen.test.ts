import { createTriggerSchema } from '@maskin/shared'
import { describe, expect, it } from 'vitest'
import {
	DAILY_REGEN_CRON,
	MASKIN_APP_DATA_WINDOW_KEY,
	MASKIN_STATE_SLOT_ID,
	buildDailyRegenActionPrompt,
	buildDailyRegenTrigger,
	buildMaskinStateSlot,
	dailyRegenTriggerName,
	jsonEncodeForScript,
} from '../../services/mini-app-regen'

const file = { id: '11111111-1111-1111-1111-111111111111', name: 'curriculum.html' }
const targetActorId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'

describe('mini-app regen routine', () => {
	it('DoD-1 — builds a valid daily cron trigger that reuses the existing trigger infra', () => {
		const body = buildDailyRegenTrigger({
			file,
			appName: 'Curriculum',
			targetActorId,
		})

		// It must persist through the standard triggers path unchanged.
		expect(createTriggerSchema.safeParse(body).success).toBe(true)
		expect(body.type).toBe('cron')
		expect(body.enabled).toBe(true)
		expect(body.target_actor_id).toBe(targetActorId)
		// Deterministic name so re-provisioning upserts instead of duplicating.
		expect(body.name).toBe('Regen Curriculum daily')
		expect(body.name).toBe(dailyRegenTriggerName('Curriculum'))

		// Daily: day-of-month/month/day-of-week are all '*'.
		const parts = body.config.expression.split(' ')
		expect(body.config.expression).toBe(DAILY_REGEN_CRON)
		expect(parts[2]).toBe('*')
		expect(parts[3]).toBe('*')
		expect(parts[4]).toBe('*')
		// The config records which file this trigger regens, so the provision
		// route can upsert per-file even when distinct apps share a filename.
		expect(body.config.file_id).toBe(file.id)
	})

	it('DoD-2 — bakes live objects into the maskin-state slot the app reads', () => {
		const objects = [
			{ id: 'obj-1', type: 'knowledge', title: 'Intro' },
			{ id: 'obj-2', type: 'task', title: 'DoD' },
		]
		const slot = buildMaskinStateSlot(objects)

		expect(slot).toContain(`<script id="${MASKIN_STATE_SLOT_ID}" type="application/json">`)
		expect(slot).toContain(jsonEncodeForScript(objects))
		// The baked JSON round-trips back to the original objects.
		expect(JSON.parse(jsonEncodeForScript(objects))).toEqual(objects)
		// Contract: the app exposes this window key from that node.
		expect(MASKIN_APP_DATA_WINDOW_KEY).toBe('__MASKIN_APP_DATA__')
	})

	it('DoD-2 — a malicious object cannot inject a closing script tag into the slot', () => {
		const malicious = { html: '</script><script>alert(1)</script>' }
		const json = jsonEncodeForScript([malicious])

		expect(json).not.toMatch(/<\/script/i)
		expect(JSON.parse(json)).toEqual([malicious])

		const slot = buildMaskinStateSlot([malicious])
		// Exactly one legitimate closing tag — the node's own — never one from the payload.
		expect(slot.match(/<\/script>/g)?.length).toBe(1)
		expect(slot).toContain(json)
	})

	it('DoD-2 — action prompt mandates in-place rewrite of the SAME file id (no copy)', () => {
		const prompt = buildDailyRegenActionPrompt(file)

		expect(prompt).toContain(file.id)
		expect(prompt).toMatch(/IN PLACE/)
		expect(prompt).toMatch(/update_file/)
		expect(prompt).toMatch(/never create a new object or copy/i)
		expect(prompt).toMatch(/no broken intermediate state/i)
	})

	it('DoD-3 — action prompt directs a post-regen smoke-test before publishing', () => {
		const prompt = buildDailyRegenActionPrompt(file)

		expect(prompt).toMatch(/smoke-test/i)
		expect(prompt).toMatch(/before/i)
		expect(prompt).toMatch(/publish/i)
	})
})
