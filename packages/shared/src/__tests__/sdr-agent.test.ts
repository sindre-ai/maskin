import { describe, expect, it } from 'vitest'
import { actorToolsSchema } from '../schemas/actors'
import { SDR_AGENT_DEFAULT, SDR_AGENT_SYSTEM_PROMPT } from '../templates/sdr-agent'

describe('SDR agent default template', () => {
	it('is a non-system agent named "SDR agent"', () => {
		expect(SDR_AGENT_DEFAULT.type).toBe('agent')
		expect(SDR_AGENT_DEFAULT.name).toBe('SDR agent')
		// Not marked isSystem — the SDR agent is customer-owned and edit-able,
		// unlike Chief of Staff and Workspace Coach which the frontend locks.
		expect(SDR_AGENT_DEFAULT.isSystem).toBe(false)
	})

	it('declares the linkedin capability so the LinkedIn UI opens on its detail page', () => {
		// This is the load-bearing invariant of the whole task — removing 'linkedin'
		// from `capabilities` hides the LinkedIn hero pill, Channels row, and sending
		// block on the SDR agent detail (frontend gate in
		// apps/web/src/components/agents/linkedin-connect-section.tsx).
		expect(SDR_AGENT_DEFAULT.tools.capabilities).toContain('linkedin')
	})

	it('exposes the maskin MCP server so it can read/write workspace state', () => {
		expect(SDR_AGENT_DEFAULT.tools.mcpServers.maskin).toBeDefined()
	})

	it('validates against actorToolsSchema so the create-actor route accepts the template shape', () => {
		const parsed = actorToolsSchema.safeParse(SDR_AGENT_DEFAULT.tools)
		expect(parsed.success).toBe(true)
	})

	it('states the approval-gated + customer-account invariants verbatim in the system prompt', () => {
		// The parent bet's acceptance criteria hinge on these two rules — an
		// agent that drifts and mass-sends unapproved, or that routes through a
		// non-customer account, breaks the bet's exit criteria (any restriction
		// kills the bet independent of activation). Keep them keyword-anchored so
		// a future prompt rewrite can't silently drop them.
		expect(SDR_AGENT_SYSTEM_PROMPT).toMatch(/Approval-gated/i)
		expect(SDR_AGENT_SYSTEM_PROMPT).toMatch(
			/customer.?owned|customer's own connected|Customer account only/i,
		)
	})
})
