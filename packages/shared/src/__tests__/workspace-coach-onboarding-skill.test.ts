import { describe, expect, it } from 'vitest'
import { DEVELOPMENT_AGENTS } from '../templates/development-agents'

// This suite pins the ordering + skip-logic contract for the
// workspace-observer-onboarding skill. The skill body is a natural-language
// prompt for an LLM agent, so these assertions cover the surface a human
// reviewer would otherwise have to re-read after every edit: the fixed
// dependency chain, the skip-logic instructions, and the owner-targeted
// classification the write-path relies on.

const coach = DEVELOPMENT_AGENTS.find((a) => a.name === 'Workspace Coach')
const skill = coach?.skills?.find((s) => s.name === 'workspace-observer-onboarding')

describe('workspace-observer-onboarding seed skill', () => {
	it('is attached to the Workspace Coach seed agent', () => {
		expect(coach).toBeDefined()
		expect(skill).toBeDefined()
		expect(skill?.content.length).toBeGreaterThan(0)
	})

	it('declares the fixed dependency chain in the prompt body', () => {
		expect(skill?.content).toContain(
			'product_vision → first_bet_hypothesis → icp → north_star_metric → customer_evidence',
		)
	})

	it('orders the five prompts vision → hypothesis → ICP → NSM → evidence', () => {
		const body = skill?.content ?? ''
		const positions = {
			vision: body.indexOf('Prompt 1 — Product vision'),
			hypothesis: body.indexOf('Prompt 2 — First-bet hypothesis'),
			icp: body.indexOf('Prompt 3 — ICP'),
			nsm: body.indexOf('Prompt 4 — North Star metric'),
			evidence: body.indexOf('Prompt 5 — Customer evidence'),
		}
		for (const [layer, pos] of Object.entries(positions)) {
			expect(pos, `${layer} prompt heading missing`).toBeGreaterThanOrEqual(0)
		}
		expect(positions.vision).toBeLessThan(positions.hypothesis)
		expect(positions.hypothesis).toBeLessThan(positions.icp)
		expect(positions.icp).toBeLessThan(positions.nsm)
		expect(positions.nsm).toBeLessThan(positions.evidence)
	})

	it('includes first_bet_hypothesis as an owner-targeted layer', () => {
		// T7's about-edge migration keys off this classification. If future edits
		// demote hypothesis out of the owner-targeted list, the write-path will
		// silently regress to workspace-scoped owner facts.
		expect(skill?.content).toMatch(
			/`product_vision`, `first_bet_hypothesis`, `icp`, and `customer_evidence` are \*\*owner-targeted\*\*/,
		)
		expect(skill?.content).toMatch(/`north_star_metric` is \*\*workspace-targeted\*\*/)
	})

	it('specifies the ≥0.8 confidence threshold for skip-logic conversion', () => {
		const body = skill?.content ?? ''
		expect(body).toContain('confidence ≥ 0.8')
		expect(body).toContain('convert to a confirmation card')
	})

	it('forbids re-asking a layer already confirmed by the owner', () => {
		expect(skill?.content).toContain('Never re-ask an already-confirmed layer')
		expect(skill?.content).toContain('owner_confirmed')
	})

	it('instructs the agent to validate the DAG before advancing past an orphan', () => {
		expect(skill?.content).toContain('Validate the DAG before advancing')
		expect(skill?.content).toContain('never advance past an orphan')
	})
})
