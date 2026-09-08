import { describe, expect, it } from 'vitest'
import {
	CHIEF_OF_STAFF_DEFAULT,
	CHIEF_OF_STAFF_SYSTEM_PROMPT,
	CONTINUOUS_ONBOARDING_SKILL,
} from '../templates/default-workspace-agents'

describe('Chief of Staff default template', () => {
	it('ships a non-empty system prompt and description', () => {
		expect(CHIEF_OF_STAFF_SYSTEM_PROMPT.length).toBeGreaterThan(0)
		expect(CHIEF_OF_STAFF_DEFAULT.description.length).toBeGreaterThan(0)
	})

	it('is marked as a system agent', () => {
		expect(CHIEF_OF_STAFF_DEFAULT.isSystem).toBe(true)
		expect(CHIEF_OF_STAFF_DEFAULT.type).toBe('agent')
		expect(CHIEF_OF_STAFF_DEFAULT.name).toBe('Chief of Staff')
	})

	it('exposes the maskin MCP server so it can spawn specialist sessions', () => {
		expect(CHIEF_OF_STAFF_DEFAULT.tools.mcpServers.maskin).toBeDefined()
	})

	// Beat 6 persona regression — the onboarding-bet acceptance criteria requires
	// the persona prose to carry Magnus's 2026-09-06 must-not-drop guardrail on
	// Signal Analyst ordering. Regressing any of these strings silently would
	// re-open the "concurrent clustering of an empty knowledge set" failure mode
	// the guardrail exists to prevent.
	describe('Beat 6 — Signal Analyst hand-off ordering rule', () => {
		it('names the chained Beat 6 trigger', () => {
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain(
				'Deep-research brief validated → Signal Analyst clustering',
			)
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('Beat 6')
		})

		it('names the extended Beat 2 trigger this hand-off is chained off', () => {
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('First-pass brief validated → deep research')
		})

		it('states the validation-gated ordering rule verbatim', () => {
			// These two literal phrases are the load-bearing assertions from the
			// Beat 6 acceptance criteria — the persona must state that Signal
			// Analyst fires AFTER deep-research validates, and NEVER concurrently.
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('after deep-research validates')
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('not concurrently')
		})

		it('names Signal Analyst’s three deep-research inputs', () => {
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('organization deep dive')
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('competitive landscape')
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('market & category')
		})

		it('names the expected Signal Analyst output shape', () => {
			// One candidate bet in status = signal, wired to the deep-research
			// knowledge objects via `informs` edges.
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('status = signal')
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('informs')
		})

		it('cites the Magnus 2026-09-06 guardrail so the reason for the ordering rule survives edits', () => {
			expect(CHIEF_OF_STAFF_SYSTEM_PROMPT).toContain('Magnus 2026-09-06')
		})
	})
})

describe('CONTINUOUS_ONBOARDING_SKILL', () => {
	const content = CONTINUOUS_ONBOARDING_SKILL.content

	it('opens with a named Classify step positioned above Steps 1–5', () => {
		const classifyIdx = content.indexOf('## Classify')
		const stepsIdx = content.indexOf('## Steps 1–5')
		expect(classifyIdx).toBeGreaterThan(-1)
		expect(stepsIdx).toBeGreaterThan(-1)
		expect(classifyIdx).toBeLessThan(stepsIdx)
	})

	it('contains the classifier rule verbatim (default Fetchable, escalate only on no public source or framing/priority)', () => {
		expect(content).toContain('Default posture is **Fetchable**')
		expect(content).toContain(
			'Escalate to **Human-only** ONLY on (a) genuinely no public source, OR (b) a framing or priority call the human owns',
		)
	})

	it('includes worked examples for Team, Competitors, ICP-as-hypothesis (Fetchable) and ICP-framing (Human-only)', () => {
		expect(content).toMatch(/\*\*Team\*\*\s*→\s*\*\*Fetchable\*\*/)
		expect(content).toMatch(/\*\*Competitors\*\*\s*→\s*\*\*Fetchable\*\*/)
		expect(content).toMatch(/\*\*ICP as hypothesis\*\*[\s\S]*?→\s*\*\*Fetchable\*\*/)
		expect(content).toMatch(/\*\*ICP as framing\*\*[\s\S]*?→\s*\*\*Human-only\*\*/)
	})

	it('reclassifies Legal entity as Fetchable with CVR named as the public source', () => {
		expect(content).toMatch(/\*\*Legal entity\*\*\s*→\s*\*\*Fetchable\*\*/)
		expect(content).toContain('CVR')
	})

	it('enumerates all seven checklist domains with at least one example line each', () => {
		const domains = [
			'Humans',
			'Org',
			'Product',
			'Customers',
			'Competitors',
			'Market',
			'Goals & bets',
		]
		for (const domain of domains) {
			// Bulleted domain line: `- **<Domain>** — ...` with some example text after the dash.
			const re = new RegExp(`-\\s+\\*\\*${domain.replace(/&/g, '\\&')}\\*\\*\\s+—\\s+\\S+`)
			expect(content).toMatch(re)
		}
	})

	it('codifies the batch-container pattern: one container per batch, children relates_to, one create_comment on the container', () => {
		expect(content).toContain('batch container')
		expect(content).toMatch(/type:\s*knowledge/)
		expect(content).toMatch(/status:\s*draft/)
		expect(content).toMatch(/type:\s*relates_to/)
		expect(content).toMatch(/exactly ONE\s+`create_comment` on the container/)
		expect(content).toMatch(/`entity_id`:\s*\*\*the container's id\*\*/)
	})

	it('uses the exact "Confirm batch?" decision title with the three load-bearing chip labels', () => {
		expect(content).toContain('"Confirm batch?"')
		expect(content).toContain('**Confirm all**')
		expect(content).toContain('**Confirm each**')
		// "Skip" appears elsewhere as ordinary English; assert the chip form with surrounding order and recommended marker.
		expect(content).toMatch(
			/\*\*Confirm all\*\*\s*\(recommended\)\s*\/\s*\*\*Confirm each\*\*\s*\/\s*\*\*Skip\*\*/,
		)
	})
})
