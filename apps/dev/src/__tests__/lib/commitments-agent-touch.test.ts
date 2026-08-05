import {
	DEVELOPMENT_AGENTS,
	DEVELOPMENT_TRIGGERS,
	WORKSPACE_COACH_SYSTEM_PROMPT,
} from '@maskin/shared'
import { describe, expect, it } from 'vitest'

describe('Commitments — Workspace Coach (Chief of Staff) awareness', () => {
	it('names Commitments as an object type and cites all three statuses', () => {
		expect(WORKSPACE_COACH_SYSTEM_PROMPT).toMatch(/Commitment/)
		for (const status of ['holding', 'at-risk', 'breached']) {
			expect(WORKSPACE_COACH_SYSTEM_PROMPT).toContain(status)
		}
	})

	it('teaches that at-risk and breached Commitments are briefing-worthy alongside stalled bets', () => {
		expect(WORKSPACE_COACH_SYSTEM_PROMPT).toMatch(/briefing-worthy/i)
		expect(WORKSPACE_COACH_SYSTEM_PROMPT).toMatch(/alongside stalled bets/i)
	})

	it('names the four Commitment metadata fields', () => {
		for (const field of ['floor', 'cadence', 'source_bet_id', 'last_breach_at']) {
			expect(WORKSPACE_COACH_SYSTEM_PROMPT).toContain(field)
		}
	})

	it('cites the derived_from edge for source-bet provenance', () => {
		expect(WORKSPACE_COACH_SYSTEM_PROMPT).toContain('derived_from')
	})

	it("reads Commitments via type='commitment' and forbids metadata_eq for Commitment fetches", () => {
		expect(WORKSPACE_COACH_SYSTEM_PROMPT).toContain("type='commitment'")
		const commitmentSection = WORKSPACE_COACH_SYSTEM_PROMPT.split('## Commitments')[1] ?? ''
		expect(commitmentSection).toMatch(/(never|do not|don't)[^.]*metadata_eq/i)
	})
})

describe('Commitments — Strategist graduation skill', () => {
	const strategist = DEVELOPMENT_AGENTS.find((a) => a.$id === 'strategist')
	const skill = strategist?.skills?.find((s) => s.name === 'graduate-succeeded-bet-to-commitment')

	it('is attached to the Strategist as a workspace skill', () => {
		expect(strategist).toBeDefined()
		expect(skill).toBeDefined()
	})

	it('teaches that succeeded bets codifying a standing capability graduate into a Commitment (not live)', () => {
		expect(skill?.content).toBeDefined()
		expect(skill?.content).toMatch(/succeeded/)
		expect(skill?.content).toMatch(/standing capability|standing commitment/i)
		expect(skill?.content).toMatch(/Commitment/)
	})

	it('starts new Commitments at holding and names all three statuses', () => {
		for (const status of ['holding', 'at-risk', 'breached']) {
			expect(skill?.content).toContain(status)
		}
		expect(skill?.content).toMatch(/status\s*[:=]\s*['"]?holding/i)
	})

	it('names the four metadata fields and the derived_from provenance edge', () => {
		for (const field of ['floor', 'cadence', 'source_bet_id', 'last_breach_at']) {
			expect(skill?.content).toContain(field)
		}
		expect(skill?.content).toContain('derived_from')
	})

	it('is a proposal only — no auto-graduation; a human approves', () => {
		expect(skill?.content).toMatch(/proposal/i)
		expect(skill?.content).toMatch(/human approves|human approval|approved by a human/i)
		expect(skill?.content).toMatch(/never|do not|don't/i)
	})

	it("uses type='commitment' for reads and forbids metadata_eq", () => {
		expect(skill?.content).toContain("type='commitment'")
		expect(skill?.content).not.toMatch(/metadata_eq\(/)
	})
})

describe('Commitments — Daily Commitment Health Scan trigger', () => {
	const trigger = DEVELOPMENT_TRIGGERS.find((t) => t.name === 'Daily Commitment Health Scan')

	it('exists as a cron trigger targeting the Workspace Coach', () => {
		expect(trigger).toBeDefined()
		expect(trigger?.type).toBe('cron')
		expect(trigger?.targetActor$id).toBe('workspace_coach')
		expect(trigger?.enabled).toBe(true)
	})

	it('does not collide with existing Workspace Coach crons (≥15 min apart)', () => {
		const coachCrons = DEVELOPMENT_TRIGGERS.filter(
			(t) => t.type === 'cron' && t.targetActor$id === 'workspace_coach',
		)
		const minutes = coachCrons
			.map((t) => (t.config as { expression: string }).expression)
			.map((expr) => {
				const [minute, hour] = expr.split(' ')
				return Number(hour) * 60 + Number(minute)
			})
			.sort((a, b) => a - b)
		for (let i = 1; i < minutes.length; i += 1) {
			expect(minutes[i] - minutes[i - 1]).toBeGreaterThanOrEqual(15)
		}
	})

	it("reads Commitments via type='commitment' and never via metadata_eq", () => {
		const prompt = trigger?.actionPrompt ?? ''
		expect(prompt).toContain("type='commitment'")
		expect(prompt).not.toMatch(/metadata_eq\(/)
	})

	it('stamps metadata.last_breach_at when a floor is missed inside its cadence window', () => {
		const prompt = trigger?.actionPrompt ?? ''
		expect(prompt).toContain('metadata.last_breach_at')
		expect(prompt).toMatch(/floor/)
		expect(prompt).toMatch(/cadence/)
	})

	it('names the health-state transitions at-risk and breached', () => {
		const prompt = trigger?.actionPrompt ?? ''
		expect(prompt).toContain('at-risk')
		expect(prompt).toContain('breached')
	})

	it('walks the derived_from edge to reach the source bet', () => {
		const prompt = trigger?.actionPrompt ?? ''
		expect(prompt).toContain('derived_from')
	})
})
