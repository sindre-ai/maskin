import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * Regression pin for the workspace-scope of the fan-out credential lookup.
 *
 * Sessions run under the AGENT actor's Maskin API key
 * (services/session-manager.ts sets envVars.MASKIN_API_KEY = agent.apiKey),
 * and agents never connect their own LinkedIn — humans do. An earlier
 * version of this route filtered `integrations` rows by
 * `eq(integrations.actorId, actorId)` where `actorId` was the CALLING
 * actor's id, which meant every agent call returned zero credential rows
 * and therefore zero fan-out tools even after LinkedIn was connected in
 * the workspace and autoInject wired up the MCP server url.
 *
 * Identity disambiguation happens at the TOOL level, not the credential
 * level: every registered identity is served as its own MCP instance
 * (`linkedin-{unipileAccSlug}-{identitySlug}`) with a scoped tool name
 * and an "AS <displayName>" description. Workspace membership
 * (`isWorkspaceMember` at the top of the route) is the auth boundary,
 * same as slack's MCP.
 *
 * This test reads the route source directly and asserts the where-clause
 * has NOT re-acquired the actor filter. It intentionally does not go
 * through the streamable-http transport — the fault mode we are guarding
 * against is a one-line predicate regression, and a source-level pin
 * catches it deterministically without the transport plumbing.
 */
describe('linkedin-unipile MCP route — credential lookup shape', () => {
	const ROUTE_SRC = readFileSync(
		resolve(__dirname, '../integrations-linkedin-unipile-mcp.ts'),
		'utf8',
	)

	it('queries integrations rows by workspace + provider, without an actorId filter', () => {
		const whereMatch = ROUTE_SRC.match(/\.where\([\s\S]+?\)\s*\n/)
		expect(whereMatch, 'route must have a .where(...) clause').not.toBeNull()

		const whereClause = whereMatch?.[0] ?? ''

		// Positive assertions — the two predicates that must be present.
		expect(whereClause).toContain('workspaceId')
		expect(whereClause).toContain('provider')

		// Negative assertion — the predicate that must NOT come back. Matching
		// on `integrations.actorId` specifically so a substring like "actorId"
		// used elsewhere on the module (context binding, log fields) does not
		// false-trip this. Any qualified reference to the row's actor id would
		// re-introduce the agent-empty-tools bug.
		expect(whereClause).not.toContain('integrations.actorId')
	})
})
