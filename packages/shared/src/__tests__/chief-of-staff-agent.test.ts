import { describe, expect, it } from 'vitest'
import {
	CHIEF_OF_STAFF_DEFAULT,
	CHIEF_OF_STAFF_SYSTEM_PROMPT,
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
