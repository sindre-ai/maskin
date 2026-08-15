import { describe, expect, it } from 'vitest'
import {
	SIGNUP_CAPTURE_SOURCE,
	SIGNUP_FIRST_BET_DRAFT_SOURCE,
	SIGNUP_RESEARCH_SOURCE,
} from '../schemas/signup-capture'
import { cronConfigSchema, eventConfigSchema } from '../schemas/triggers'
import { DEVELOPMENT_TRIGGERS } from '../templates/development-agents'

const SIGNUP_CAPTURE_TRIGGER = 'Strategist research on signup'
const SIGNUP_RESEARCH_COUNCIL_TRIGGER = 'Council intake on signup research'
const SIGNUP_DIGEST_TRIGGER = 'Signup-driven promotions — daily digest'

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

describe('DEVELOPMENT_TRIGGERS — Signup-driven promotions daily digest (T4)', () => {
	it('exists as a cron trigger on the Strategist that runs once per UTC day', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		expect(trigger.type).toBe('cron')
		expect(trigger.targetActor$id).toBe('strategist')
		expect(trigger.enabled).toBe(true)
		const cfg = trigger.config as Record<string, unknown>
		expect(cfg.expression).toBe('15 0 * * *')
	})

	it('config parses against the runtime cronConfigSchema', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		expect(() => cronConfigSchema.parse(trigger.config)).not.toThrow()
	})

	it('scopes strictly to signup_first_bet_draft promotions and calls out that other sources are out of scope', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		const prompt = trigger.actionPrompt
		expect(prompt).toContain(SIGNUP_FIRST_BET_DRAFT_SOURCE)
		expect(prompt).not.toContain(SIGNUP_RESEARCH_SOURCE)
		expect(prompt).not.toContain(SIGNUP_CAPTURE_SOURCE)
		expect(prompt).toMatch(/other promotion sources.*existing notify behavior/i)
	})

	it('is silent on days with zero signup-driven promotions', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		expect(trigger.actionPrompt).toMatch(/exit silently/i)
	})

	it('names the workspace, the bet, and links to both in the digest content contract', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		const prompt = trigger.actionPrompt
		expect(prompt).toMatch(/workspace name/i)
		expect(prompt).toContain('bet title')
		expect(prompt).toContain('open bet')
		expect(prompt).toContain('open workspace')
		expect(prompt).toMatch(/workspace-standard link format/i)
	})

	it('routes the batched notification to the workspace owner via create_notification', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		const prompt = trigger.actionPrompt
		expect(prompt).toContain('create_notification')
		expect(prompt).toContain('target_actor_id')
		expect(prompt).toMatch(/workspace owner/i)
	})

	it('enforces UTC-day boundaries and a 24-hour window', () => {
		const trigger = findTrigger(SIGNUP_DIGEST_TRIGGER)
		const prompt = trigger.actionPrompt
		expect(prompt).toContain('UTC')
		expect(prompt).toMatch(/24 hours/i)
		expect(prompt).toMatch(/never.*local time/i)
	})
})

describe('DEVELOPMENT_TRIGGERS — signup-driven promotions have no realtime notify path', () => {
	it('the T2 council intake trigger deliberately does not @mention on fire (batched digest owns the notify)', () => {
		const trigger = findTrigger(SIGNUP_RESEARCH_COUNCIL_TRIGGER)
		const prompt = trigger.actionPrompt
		// No @mention step and no notification-creation step in the T2 prompt — the
		// only comment it may post is a FAIL paper-trail on the source signup_capture
		// knowledge row, never an owner @mention on the promoted bet.
		expect(prompt).not.toContain('create_notification')
		expect(prompt).not.toMatch(/@mention/i)
	})
})

describe('DEVELOPMENT_TRIGGERS — no duplicate trigger names', () => {
	it('every seed trigger has a unique name (workspace-bootstrap idempotence key)', () => {
		const names = DEVELOPMENT_TRIGGERS.map((t) => t.name)
		const unique = new Set(names)
		expect(unique.size).toBe(names.length)
	})
})
