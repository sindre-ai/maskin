import { describe, expect, it } from 'vitest'
import { config } from '../../../../../lib/integrations/providers/linkedin-unipile/config'

/**
 * The MCP registration is the discovery contract every non-browser client
 * reads to know that a provider exposes tools. Absent, `list_integration_providers`
 * emits the provider with no `mcp` field and an agent correctly infers "no
 * MCP server for this provider" — the R11 fan-out MCP was invisible to
 * every workspace agent for exactly that reason before this block was
 * added, even with LinkedIn connected. Pin the exact shape so the same
 * omission cannot regress.
 *
 * P3-K (Magnus 2026-09-14) flipped `mcp.autoInject` from true to false —
 * workspace-wide auto-inject was reversed in favour of per-identity Quick
 * Add. The follow-up de-trap then dropped the `mcp.server` field entirely:
 * linkedin-unipile is multi-identity (personal profile + N admined pages),
 * so there is no single paste-ready `.../mcp` URL to hand out; the aggregate
 * URL is a deprecated, empty-tool endpoint (see
 * `routes/integrations-linkedin-unipile-mcp.ts`). Discovery surfaces
 * `mcp: { envKey, autoInject: false }` without a `server`, and the frontend
 * Quick Add UI builds per-instance URLs from
 * `/api/integrations/linkedin-unipile/identities`. Same "no single spec"
 * shape github's multi-installation surface has always used. See core
 * principle 4 in `.claude/rules/integrations-mcp.md`.
 */
describe('linkedin-unipile provider config', () => {
	it('has correct name and display name', () => {
		expect(config.name).toBe('linkedin-unipile')
		expect(config.displayName).toBe('LinkedIn')
	})

	it('declares the LinkedIn MCP envKey without a canonical server spec and does not auto-inject', () => {
		expect(config.mcp).toBeDefined()
		expect(config.mcp?.envKey).toBe('LINKEDIN_UNIPILE_TOKEN')
		expect(config.mcp?.autoInject).toBe(false)
		// Multi-identity provider — Quick Add writes per-slug URLs from
		// /api/integrations/linkedin-unipile/identities; no single paste-ready
		// server spec exists. The deprecated aggregate URL that used to sit
		// here silently trapped any client that pasted it verbatim.
		expect(config.mcp?.server).toBeUndefined()
	})
})
