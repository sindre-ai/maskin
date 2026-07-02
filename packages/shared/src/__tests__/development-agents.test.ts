import { describe, expect, it } from 'vitest'
import {
	SIGNUP_CAPTURE_SOURCE,
	SIGNUP_FIRST_BET_DRAFT_SOURCE,
	SIGNUP_RESEARCH_SOURCE,
} from '../schemas/signup-capture'
import { eventConfigSchema } from '../schemas/triggers'
import { DEVELOPMENT_TRIGGERS } from '../templates/development-agents'

const SIGNUP_CAPTURE_TRIGGER = 'Strategist research on signup'
const SIGNUP_RESEARCH_COUNCIL_TRIGGER = 'Council intake on signup research'

function findTrigger(name: string) {
	const trigger = DEVELOPMENT_TRIGGERS.find((t) => t.name === name)
	if (!trigger) throw new Error(`Missing seed trigger: ${name}`)
	return trigger
}

describe('DEVELOPMENT_TRIGGERS — Strategist research on signup (existing)', () => {
	it('fires on knowledge.created filtered to metadata.source = signup_capture', () => {
		const trigger = findTrigger(SIGNUP_CAPTURE_TRIGGER)
		expect(trigger.type).toBe('event')
		const cfg = trigger.config as Record<string, unknown>
		expect(cfg.entity_type).toBe('knowledge')
		expect(cfg.action).toBe('created')
		expect(cfg.conditions).toEqual([
			{ field: 'source', operator: 'equals', value: SIGNUP_CAPTURE_SOURCE },
		])
	})
})

describe('DEVELOPMENT_TRIGGERS — Council intake on signup research (T2)', () => {
	it('exists and targets the Strategist', () => {
		const trigger = findTrigger(SIGNUP_RESEARCH_COUNCIL_TRIGGER)
		expect(trigger.type).toBe('event')
		expect(trigger.targetActor$id).toBe('strategist')
		expect(trigger.enabled).toBe(true)
	})

	it('fires on knowledge.created filtered to metadata.source = signup_research', () => {
		const trigger = findTrigger(SIGNUP_RESEARCH_COUNCIL_TRIGGER)
		const cfg = trigger.config as Record<string, unknown>
		expect(cfg.entity_type).toBe('knowledge')
		expect(cfg.action).toBe('created')
		expect(cfg.conditions).toEqual([
			{ field: 'source', operator: 'equals', value: SIGNUP_RESEARCH_SOURCE },
		])
	})

	it('config parses against the runtime eventConfigSchema', () => {
		const trigger = findTrigger(SIGNUP_RESEARCH_COUNCIL_TRIGGER)
		expect(() => eventConfigSchema.parse(trigger.config)).not.toThrow()
	})

	it('names the signup-context branch, the skill, the source values, and the promotion-mode contract in the action prompt', () => {
		const trigger = findTrigger(SIGNUP_RESEARCH_COUNCIL_TRIGGER)
		const prompt = trigger.actionPrompt
		expect(prompt).toContain('strategic-intake-review')
		expect(prompt).toContain('context: signup')
		expect(prompt).toContain(SIGNUP_RESEARCH_SOURCE)
		expect(prompt).toContain(SIGNUP_FIRST_BET_DRAFT_SOURCE)
		expect(prompt).toContain('human_approved')
		expect(prompt).toContain('primary-domain dedup')
	})

	it('does not accept a signup_capture event — the cluster-review branch fires only on signup_research', () => {
		const trigger = findTrigger(SIGNUP_RESEARCH_COUNCIL_TRIGGER)
		const cfg = trigger.config as Record<string, unknown>
		const conditions = cfg.conditions as Array<{
			field: string
			operator: string
			value: unknown
		}>
		const match = conditions.every(
			(c) => c.field === 'source' && c.operator === 'equals' && c.value === SIGNUP_RESEARCH_SOURCE,
		)
		expect(match).toBe(true)
		expect(conditions.some((c) => c.value === SIGNUP_CAPTURE_SOURCE)).toBe(false)
	})
})

describe('DEVELOPMENT_TRIGGERS — no duplicate trigger names', () => {
	it('every seed trigger has a unique name (workspace-bootstrap idempotence key)', () => {
		const names = DEVELOPMENT_TRIGGERS.map((t) => t.name)
		const unique = new Set(names)
		expect(unique.size).toBe(names.length)
	})
})
