import { describe, expect, it } from 'vitest'
import { entryMatcherFor } from '../../../lib/integrations/mcp-entries'
import { IDENTITY_ENUMERATORS } from '../../../lib/integrations/mcp-presets'
import { listProviders } from '../../../lib/integrations/registry'
import type { McpEntryOwner, McpServerSpec, ProviderConfig } from '../../../lib/integrations/types'

/**
 * Contract: every provider that declares an MCP surface must declare it in a
 * shape the disconnect logic can recognise on an agent.
 *
 * Disconnect removes the entries a connection put on agents
 * (`mcp-detach.ts`). It can only remove what `mcp-entries.ts` can recognise
 * from the provider's own config.ts. A provider that declares `mcp` without
 * `server` or `entry`, or whose declared entry the matcher misses, passes every
 * other test and then leaves a dead entry on each agent for ever: the agent
 * boots with the tools listed and every call fails.
 */

const ACME: McpEntryOwner = { config: { owner_login: 'acme-co' }, unipileAccSlug: 'acme' }
const OTHER: McpEntryOwner = { config: { owner_login: 'other-co' }, unipileAccSlug: 'other' }

type Entry = Record<string, unknown>

/**
 * The entry an agent holds for `owner`, built the way the attach flow builds it
 * (mcp-presets.ts): only from what the config declares.
 */
function entryFor(config: ProviderConfig, owner: McpEntryOwner): Entry {
	const mcp = config.mcp
	if (!mcp) throw new Error(`${config.name} declares no mcp`)
	const decl = mcp.entry ?? { kind: 'shared' as const }
	let server: McpServerSpec | null | undefined
	if (decl.kind === 'per-identity') {
		const prefix = decl.slugPrefix(owner)
		if (!prefix) throw new Error(`${config.name}: ${JSON.stringify(owner)} owns no slug`)
		server = decl.server(`${prefix}personal`)
	} else if (decl.kind === 'per-installation') {
		server = decl.server(owner)
	} else {
		server = mcp.server
	}
	if (!server) throw new Error(`${config.name}: no entry can be built for ${JSON.stringify(owner)}`)
	return JSON.parse(JSON.stringify(server)) as Entry
}

const withMcp = listProviders()
	.map((p) => p.config)
	.filter((c) => c.mcp)

describe('provider MCP entries are recognisable by disconnect', () => {
	it('covers at least the providers known to declare an MCP surface', () => {
		const names = withMcp.map((c) => c.name)
		expect(names).toEqual(expect.arrayContaining(['linkedin-unipile', 'slack', 'github', 'linear']))
	})

	for (const config of withMcp) {
		describe(config.name, () => {
			it('declares a server or a non-shared entry', () => {
				const mcp = config.mcp
				expect(mcp?.server != null || (mcp?.entry != null && mcp.entry.kind !== 'shared')).toBe(
					true,
				)
			})

			it('recognises the entry its own config declares', () => {
				const matches = entryMatcherFor(config, ACME, [])
				expect(matches, `${config.name}: no matcher for a lone connection`).not.toBeNull()
				expect(matches?.(entryFor(config, ACME))).toBe(true)
			})

			it('does not recognise a hand-written entry that points elsewhere', () => {
				const matches = entryMatcherFor(config, ACME, [])
				expect(matches?.({ type: 'http', url: 'https://example.com/my-own/mcp' })).toBe(false)
				expect(matches?.({ type: 'stdio', command: 'my-server', args: [] })).toBe(false)
				expect(matches?.(null)).toBe(false)
			})

			it('keeps what another active connection of the provider still needs', () => {
				const decl = config.mcp?.entry?.kind ?? 'shared'
				const matches = entryMatcherFor(config, ACME, [OTHER])
				if (decl === 'shared') {
					// One entry serves every connection: nothing goes until the last one.
					expect(matches).toBeNull()
					return
				}
				expect(matches?.(entryFor(config, ACME))).toBe(true)
				expect(matches?.(entryFor(config, OTHER))).toBe(false)
			})
		})
	}

	it('has a live identity source for every per-identity provider', () => {
		for (const config of withMcp) {
			if (config.mcp?.entry?.kind !== 'per-identity') continue
			expect(IDENTITY_ENUMERATORS[config.name], `${config.name} needs an enumerator`).toBeDefined()
		}
	})

	it('never claims an entry belonging to another provider', () => {
		for (const mine of withMcp) {
			const matches = entryMatcherFor(mine, ACME, [])
			for (const theirs of withMcp) {
				if (theirs.name === mine.name) continue
				expect(
					matches?.(entryFor(theirs, ACME)),
					`${mine.name} must not claim the ${theirs.name} entry`,
				).toBe(false)
			}
		}
	})
})
