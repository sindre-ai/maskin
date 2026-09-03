import { describe, expect, it } from 'vitest'
import devActors from '../../../lib/marketplace-loops/data/dev-actors.json'
import growthActors from '../../../lib/marketplace-loops/data/growth-actors.json'
import {
	BROWSER_MCP_SERVER,
	BROWSER_MCP_SERVER_NAME,
	actorSnapshot,
	expandBrowserCapability,
} from '../../../lib/marketplace-loops/loop-snapshot'

const baseRow = {
	type: 'agent',
	name: 'Event Producer',
	description: null,
	systemPrompt: 'You have a Playwright MCP.',
	llmProvider: 'anthropic',
	llmConfig: null,
}

const browserServer = {
	type: 'stdio',
	command: 'npx',
	args: ['@playwright/mcp@latest', '--cdp-endpoint', '${BROWSER_CDP_URL}'],
}

describe('actorSnapshot', () => {
	it('drops mcpServers so publisher secrets never reach the snapshot', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: {
				mcpServers: { hubspot: { command: 'npx', env: { HUBSPOT_TOKEN: 'pat-live-secret' } } },
			},
		})
		expect(JSON.stringify(out)).not.toContain('pat-live-secret')
		expect(out.tools).toEqual({})
	})

	it('preserves the browser as a boolean capability when an entry references the CDP placeholder', () => {
		const out = actorSnapshot({
			...baseRow,
			tools: {
				mcpServers: {
					playwright: browserServer,
					hubspot: { command: 'npx', env: { HUBSPOT_TOKEN: 'pat-live-secret' } },
				},
			},
		})
		// The flag survives; the config it came from does not.
		expect(out.tools).toEqual({ browser: true })
		expect(JSON.stringify(out)).not.toContain('pat-live-secret')
	})

	it('does not set the browser flag for actors with no browser entry', () => {
		const out = actorSnapshot({ ...baseRow, tools: { mcpServers: { hubspot: {} } } })
		expect(out.tools).toEqual({})
	})

	it('leaves non-object tools untouched', () => {
		expect(actorSnapshot({ ...baseRow, tools: null }).tools).toBeNull()
	})
})

describe('expandBrowserCapability', () => {
	it('turns the browser flag back into a real MCP entry the sidecar check matches', () => {
		const out = expandBrowserCapability({ browser: true }) as Record<string, unknown>
		expect(out).toEqual({ mcpServers: { [BROWSER_MCP_SERVER_NAME]: BROWSER_MCP_SERVER } })
		// session-manager.ts's needsBrowserSidecar() string-matches this in the
		// serialised MCP config — if it stops appearing, no Chromium is provisioned.
		expect(JSON.stringify(out)).toContain('${BROWSER_CDP_URL}')
	})

	it('round-trips a published actor back to a browser-capable install', () => {
		const snapshot = actorSnapshot({
			...baseRow,
			tools: { mcpServers: { playwright: browserServer } },
		})
		expect(JSON.stringify(expandBrowserCapability(snapshot.tools))).toContain('${BROWSER_CDP_URL}')
	})

	it('keeps other MCP servers and never clobbers an existing entry of the same name', () => {
		const installerOwn = { command: 'docker', args: ['run', 'my-own-browser'] }
		const out = expandBrowserCapability({
			browser: true,
			mcpServers: { hubspot: { command: 'npx' }, [BROWSER_MCP_SERVER_NAME]: installerOwn },
		}) as Record<string, unknown>
		const servers = out.mcpServers as Record<string, unknown>
		expect(servers[BROWSER_MCP_SERVER_NAME]).toEqual(installerOwn)
		expect(servers.hubspot).toEqual({ command: 'npx' })
	})

	it('is a no-op without the flag', () => {
		const tools = { mcpServers: { hubspot: { command: 'npx' } } }
		expect(expandBrowserCapability(tools)).toEqual(tools)
		expect(expandBrowserCapability({ browser: false })).toEqual({ browser: false })
		expect(expandBrowserCapability(null)).toBeNull()
	})
})

// Guards the checked-in catalogue data itself: these snapshots were captured
// before the browser flag existed, so every actor whose system prompt promises
// Playwright had tools:{} and silently ran without a Chromium sidecar. If the
// data is ever re-captured, this fails unless the flag survives the round-trip.
describe('catalogue actor data', () => {
	it.each([
		['dev-actors', devActors],
		['growth-actors', growthActors],
	])('gives every %s actor that claims Playwright the browser capability', (_name, data) => {
		const claiming = Object.values(
			data as Record<string, { name: string; systemPrompt: string; tools: unknown }>,
		).filter((a) => a.systemPrompt?.includes('laywright'))
		expect(claiming.length).toBeGreaterThan(0)
		for (const actor of claiming) {
			expect(
				JSON.stringify(expandBrowserCapability(actor.tools)),
				`${actor.name} promises Playwright but gets no browser sidecar`,
			).toContain('${BROWSER_CDP_URL}')
		}
	})
})
