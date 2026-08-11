import { describe, expect, it } from 'vitest'
import { SIGNUP_CAPTURE_SOURCE, SIGNUP_RESEARCH_SOURCE } from '../schemas/signup-capture'
import { DEVELOPMENT_TRIGGERS } from '../templates/development-agents'

const trigger = DEVELOPMENT_TRIGGERS.find((t) => t.name === 'Strategist research on signup')

describe('Strategist research on signup trigger', () => {
	it('is seeded in the development triggers list', () => {
		expect(trigger).toBeDefined()
	})

	it('fires on signup-capture knowledge create', () => {
		expect(trigger?.type).toBe('event')
		expect(trigger?.config).toMatchObject({
			entity_type: 'knowledge',
			action: 'created',
			conditions: [{ field: 'source', operator: 'equals', value: SIGNUP_CAPTURE_SOURCE }],
		})
		expect(trigger?.targetActor$id).toBe('strategist')
		expect(trigger?.enabled).toBe(true)
	})

	describe('action prompt contract', () => {
		const prompt = trigger?.actionPrompt ?? ''

		it('reads name / org / role from the triggering event metadata', () => {
			expect(prompt).toContain('data.metadata.name')
			expect(prompt).toContain('data.metadata.organization')
			expect(prompt).toContain('data.metadata.role')
		})

		it('orchestrates three parallel subagents — org, competitor, user', () => {
			expect(prompt).toMatch(/Task tool/i)
			expect(prompt).toMatch(/parallel/i)
			expect(prompt).toMatch(/Subagent A — Organisation/)
			expect(prompt).toMatch(/Subagent B — Competitors/)
			expect(prompt).toMatch(/Subagent C — User/)
		})

		it('mandates a citation / verification pass before writing', () => {
			expect(prompt).toMatch(/citation \/ verification pass/i)
			expect(prompt).toMatch(/before.*writing/i)
			// Unverifiable claims are kept low-confidence, not silently dropped.
			expect(prompt).toMatch(/do \*\*not\*\* get silently dropped/i)
			expect(prompt).toMatch(/Prefer primary/i)
		})

		it('isolates subagent failures so the run does not restart', () => {
			expect(prompt).toMatch(/Isolate failures/i)
			expect(prompt).toMatch(/Do not retry the whole run/i)
		})

		it('keeps the user subagent light per the situational-not-identity ruling', () => {
			expect(prompt).toMatch(/Do \*\*not\*\* build an identity dossier/i)
			expect(prompt).toContain('05e18858')
		})

		it('emits the signup_research ship-metric source on every knowledge object', () => {
			expect(prompt).toContain(SIGNUP_RESEARCH_SOURCE)
			expect(prompt).toMatch(/ship-metric tag, never skip/i)
		})

		it('writes structured knowledge with confidence, sources, subject_kind, and category', () => {
			expect(prompt).toContain("type: 'knowledge'")
			expect(prompt).toMatch(/metadata\.confidence/)
			expect(prompt).toMatch(/metadata\.sources/)
			expect(prompt).toMatch(/metadata\.subject_kind/)
			expect(prompt).toMatch(/metadata\.category/)
		})

		it('attaches every object via `about → actor` (data.created_by), not to the signup-capture object', () => {
			expect(prompt).toMatch(/about → actor/i)
			expect(prompt).toContain('data.created_by')
			expect(prompt).toMatch(/Do \*\*not\*\* link back to the signup-capture object/i)
			// Cross-workspace addressing per the ratified decision.
			expect(prompt).toContain('c060e6ab')
		})

		it('links competitors back to the org via competes_with so the landscape is graph-traversable', () => {
			expect(prompt).toMatch(/competes_with/i)
		})

		it('suggests one signal-status bet grounded in the verified findings', () => {
			expect(prompt).toMatch(/type: 'bet'/)
			expect(prompt).toMatch(/status: 'signal'/)
			expect(prompt).toMatch(/Phase 4/)
			expect(prompt).toMatch(/informs/i)
		})

		it('finishes in one session — async, non-blocking, 24h ship-metric clock', () => {
			expect(prompt).toMatch(/24h ship-metric clock/i)
			expect(prompt).toMatch(/finish in one session/i)
			expect(prompt).toMatch(/Async \/ non-blocking/i)
		})
	})
})
