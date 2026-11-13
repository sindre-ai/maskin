import { describe, expect, it } from 'vitest'
import {
	getActorData,
	getSkillData,
	getTriggerData,
} from '../../../lib/marketplace-loops/loop-data'
import {
	MEETING_MANAGER_ACTOR_IDS,
	MEETING_MANAGER_LOOP,
	MEETING_MANAGER_SKILL_IDS,
	MEETING_MANAGER_TRIGGER_IDS,
} from '../../../lib/marketplace-loops/meeting-manager-loop'

describe('Meeting Manager loop definition', () => {
	it('uses the correct slug and metadata', () => {
		expect(MEETING_MANAGER_LOOP.slug).toBe('meeting-manager-loop')
		expect(MEETING_MANAGER_LOOP.name).toBe('Meeting Manager')
		expect(MEETING_MANAGER_LOOP.useCase).toBe('Operations')
		expect(MEETING_MANAGER_LOOP.version).toBe('1.0.0')
		expect(MEETING_MANAGER_LOOP.description.length).toBeGreaterThan(0)
	})

	it('ships one actor, six triggers and eight skills, no duplicates', () => {
		expect(MEETING_MANAGER_ACTOR_IDS.length).toBe(1)
		expect(MEETING_MANAGER_TRIGGER_IDS.length).toBe(6)
		expect(MEETING_MANAGER_SKILL_IDS.length).toBe(8)
		expect(new Set(MEETING_MANAGER_TRIGGER_IDS).size).toBe(MEETING_MANAGER_TRIGGER_IDS.length)
		expect(new Set(MEETING_MANAGER_SKILL_IDS).size).toBe(MEETING_MANAGER_SKILL_IDS.length)
	})

	it('drives every trigger with the Meeting Manager', () => {
		const [actorId] = MEETING_MANAGER_ACTOR_IDS
		expect(getActorData(actorId).name).toBe('Meeting Manager')
		const byName = Object.fromEntries(
			MEETING_MANAGER_TRIGGER_IDS.map((id) => {
				const t = getTriggerData(id)
				return [t.name, t.targetActorId]
			}),
		)
		expect(Object.keys(byName).sort()).toEqual([
			'Catch-up ingest: meetings stuck at happened',
			'Daily check: meeting pipeline health',
			'Draft agenda for scheduled internal meeting',
			'Meeting ended: ingest Google Meet transcript on arrival',
			'Meeting follow-up check (weekdays 14:00 UTC, weekly review Mondays)',
			'Notetaker sweep: ingest new meetings (every 2h, weekdays)',
		])
		for (const target of Object.values(byName)) expect(target).toBe(actorId)
	})

	it('attaches the four meeting skills and four shared skills to the agent', () => {
		const names = MEETING_MANAGER_SKILL_IDS.map((id) => getSkillData(id).name).sort()
		expect(names).toEqual([
			'ask-an-agent-first',
			'for-you-format',
			'maskin-way-of-working',
			'meeting-internal-jobs',
			'meeting-ownership',
			'meeting-people-and-extraction',
			'meeting-types-and-summaries',
			'plain-english-voice',
		])
	})

	it('wires every trigger to a published actor and every skill to published actors only', () => {
		const actorIds = new Set<string>(MEETING_MANAGER_ACTOR_IDS)
		for (const id of MEETING_MANAGER_TRIGGER_IDS) {
			expect(actorIds.has(getTriggerData(id).targetActorId)).toBe(true)
		}
		for (const id of MEETING_MANAGER_SKILL_IDS) {
			const attached = getSkillData(id).attachedActorIds
			expect(attached.length).toBeGreaterThan(0)
			for (const actorId of attached) expect(actorIds.has(actorId)).toBe(true)
		}
	})

	// This bundle is a template for any workspace: nothing in it may name the
	// company, people or ids it was derived from, carry a date, or carry a
	// source id. The Meeting Manager is the one agent that ships, so its name is
	// the one exception.
	it('carries no workspace-specific text and no credentials', () => {
		const text = JSON.stringify([
			MEETING_MANAGER_LOOP,
			...MEETING_MANAGER_ACTOR_IDS.map(getActorData),
			...MEETING_MANAGER_TRIGGER_IDS.map(getTriggerData),
			...MEETING_MANAGER_SKILL_IDS.map(getSkillData),
		])
		const forbidden = [
			/sebastian|sebk|magnus/i,
			/vaerksted|skjald|meshfirm|fireflies/i,
			// The product's own name is only allowed inside a skill's name
			/maskin(?!-way-of-working)/i,
			/\bCTO\b|\bCCO\b|chief of staff/i,
			/assum/i,
			/\b20\d\d\b/,
			/\b\d{1,2} (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\b/,
			/\b(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]* \d{1,2}\b/,
			/—/,
		]
		for (const pattern of forbidden) expect(text).not.toMatch(pattern)

		const ownIds = new Set<string>([
			...MEETING_MANAGER_ACTOR_IDS,
			...MEETING_MANAGER_TRIGGER_IDS,
			...MEETING_MANAGER_SKILL_IDS,
		])
		const foreignIds = (
			text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []
		)
			.filter((id) => id !== '00000000-0000-0000-0000-000000000000')
			.filter((id) => !ownIds.has(id))
		expect(foreignIds).toEqual([])

		for (const id of MEETING_MANAGER_ACTOR_IDS) {
			expect(JSON.stringify(getActorData(id).tools)).not.toContain('mcpServers')
		}
	})
})
