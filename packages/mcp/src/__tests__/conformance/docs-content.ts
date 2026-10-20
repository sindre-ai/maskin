// The hand-written parts of the generated docs page. The matrix table itself
// comes from rows.ts (docs.ts), so a behaviour cannot be documented without
// also being tested, and cannot be tested without showing up in the docs.

export const PAGE_FRONTMATTER = {
	title: 'MCP protocol eras and conformance',
	slug: 'mcp-conformance',
	description:
		'How the Maskin MCP endpoint serves legacy (2025-era) and modern (2026-07-28) clients, the MASKIN_MCP_MODERN flag, the deprecation timeline, and the conformance matrix that guards all of it.',
}

export const INTRO = `The Maskin MCP server at \`POST /mcp\` speaks two protocol eras from one URL:

- **Legacy (2025-era)**: the \`initialize\` handshake. Every client in use today speaks it, including the Claude Code version baked into the agent image.
- **Modern (2026-07-28)**: \`server/discover\`, a per-request \`_meta\` envelope, and the \`MCP-Protocol-Version\`, \`Mcp-Method\` and \`Mcp-Name\` headers. Served only when the \`MASKIN_MCP_MODERN\` flag is on.

A conformance matrix runs one table of cases against one running app with five kinds of client, in CI, so a gap between the two eras shows up before users see it.`

export const MODES = {
	heading: 'Client modes',
	intro:
		'The SDK v2 client picks its era from its negotiation mode. The table says what each mode does against this server.',
	rows: [
		{
			mode: 'Default (legacy)',
			how: 'No option set. The client sends `initialize` exactly like a 2025 client.',
			result: 'Legacy era, always. Works with the flag on or off.',
		},
		{
			mode: '`auto`',
			how: 'The client probes with `server/discover` first and falls back to `initialize` unless the answer is definitely modern.',
			result:
				'Modern era when the flag is on, legacy era when it is off. Safe to ship before the flag flips.',
		},
		{
			mode: 'Pinned to `2026-07-28`',
			how: 'The client requires the modern era and does not fall back.',
			result:
				'Modern era when the flag is on. With the flag off, connecting fails with a clear error.',
		},
		{
			mode: 'No SDK (raw JSON-RPC)',
			how: 'A client that writes its own requests. Legacy clients send `initialize`; modern ones must send the required headers and the `_meta` envelope.',
			result:
				'Same rules as above. The matrix replays recorded v1 requests to prove legacy answers did not change.',
		},
	],
}

export const FLAG = `## The MASKIN_MCP_MODERN flag

- Values: \`off\` or \`on\`. Read once at boot, so changing it needs a restart of \`apps/dev\`. There is no hot toggle.
- **Off (the first release default)**: the server serves legacy clients only. A modern request never gets a modern answer.
- **On**: modern requests are served by the SDK's modern handler. Legacy requests are unaffected.
- Plan: turn it on per environment after the soak, make \`on\` the default after one clean 14-day window, and keep the flag until the legacy deprecation decision below is made.
- Rolling back modern support is a flag flip plus a restart. It does not roll back the SDK upgrade itself; that is a redeploy of the previous image.

The flag has to be listed in the app environment block of \`docker-compose.prod.yml\` to reach the container.`

export const TIMELINE = {
	heading: 'Deprecation timeline',
	intro:
		'Legacy support is documented, not enforced. Nothing in the server stops serving legacy clients at any of these points, and there is no sunset date.',
	rows: [
		{
			when: 'Month 0',
			what: 'The modern leg is on in production (`MASKIN_MCP_MODERN` on). The date is added to the changelog below when this happens.',
		},
		{
			when: 'Months 0 to 12',
			what: 'Legacy is fully supported. This is the minimum, the 12 months the spec gives legacy clients.',
		},
		{
			when: 'Month 9',
			what: 'Review point. Look at how much traffic is still legacy (the `mcp_era` label on analytics events) and decide whether to plan a sunset. The review can conclude "keep supporting legacy".',
		},
		{
			when: 'After month 12',
			what: 'Legacy may be deprecated, but only through a new decision with a date announced here first. Until then legacy keeps working.',
		},
	],
}

export const CHANGELOG = {
	heading: 'Changelog',
	entries: [
		{
			title: 'Unreleased: dual-era MCP endpoint',
			bullets: [
				'The MCP server moves to TypeScript SDK v2. Legacy clients see no change: same tools in the same order, same status codes, JSON responses stay `application/json`, still stateless (no MCP session id).',
				'Added the modern (2026-07-28) leg behind `MASKIN_MCP_MODERN`, default off.',
				'Modern `tools/list` and `server/discover` carry a 5 minute private cache hint (`ttlMs` 300000, `cacheScope` private). `tools/list` is deterministic and byte-identical across calls and restarts.',
				'Added an Origin check in report-only mode: it never rejects during the report-only phase.',
				'Added the conformance matrix (this page) and a CI job that runs it against the built server.',
				'Known wording change for legacy clients: with the new SDK, argument-validation errors can lose their `MCP error -32602:` prefix (the modern leg already does). The text still says `Invalid arguments for tool <name>`.',
			],
		},
	],
}

export const HOW_TO_RUN = `## Running the matrix

- **In-process** (what the \`integration-tests\` job runs): \`apps/dev/src/__tests__/integration/mcp-conformance.test.ts\` serves the real app on a local port with a real database and runs every row.
- **Against a built server** (what the \`mcp-conformance\` job runs): start the built server, then
  \`pnpm --filter @maskin/mcp conformance --base-url http://localhost:3000 --api-key <key> --workspace-id <id> --flag on\`
- **Regenerate this page** after editing a row: \`pnpm --filter @maskin/mcp conformance:docs\`. CI fails if the committed page is out of date.

A row reports **pending** when the server does not have a feature it needs yet (for example the modern leg) and **n/a** when the run is for a different flag state. In CI, pending counts as a failure, so a feature that never lands cannot hide.

Recorded legacy fixtures live in \`packages/mcp/src/__tests__/conformance/fixtures/\`. Re-record them only from a checkout of v1 main (\`record-legacy.ts\`), never from the upgraded server, or the upgrade stops being held to what v1 did.`
