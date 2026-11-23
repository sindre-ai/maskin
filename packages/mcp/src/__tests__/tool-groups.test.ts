import { beforeEach, describe, expect, it, vi } from 'vitest'

// Same envelope as invoke.test.ts: stub the SDK so createMcpServer registers every tool
// without a transport. registerAppTool hands back a handle per tool so the test can see
// which ones were disabled in tools/list.
const registered = new Map<string, { disable: ReturnType<typeof vi.fn> }>()

vi.mock('@modelcontextprotocol/ext-apps/server', () => ({
	registerAppTool: vi.fn((_server: unknown, name: string) => {
		const handle = { disable: vi.fn() }
		registered.set(name, handle)
		return handle
	}),
	registerAppResource: vi.fn(),
	RESOURCE_MIME_TYPE: 'text/html',
}))
vi.mock('@modelcontextprotocol/sdk/server/mcp.js', () => ({
	McpServer: vi.fn().mockImplementation(() => ({ registerResource: vi.fn(), connect: vi.fn() })),
	ResourceTemplate: vi.fn().mockImplementation(() => ({})),
}))
vi.mock('node:fs', () => ({
	readFileSync: vi.fn().mockReturnValue('<html>mock</html>'),
}))

import { createMcpServer } from '../server'
import {
	CORE_TOOLS,
	TOOL_GROUPS,
	TOOL_GROUP_NAMES,
	groupOfTool,
	groupedToolNamesIn,
	groupsForToolNames,
	isToolGroupsEnabled,
	isToolHidden,
	readGrantedToolGroups,
} from '../tool-groups'

const config = {
	apiBaseUrl: 'http://localhost:3000',
	apiKey: 'ank_testkey',
	defaultWorkspaceId: '00000000-0000-0000-0000-0000000000aa',
	telemetrySink: () => {},
}

beforeEach(() => {
	registered.clear()
})

function disabledNames(): string[] {
	return [...registered.entries()]
		.filter(([, h]) => h.disable.mock.calls.length > 0)
		.map(([n]) => n)
}

describe('tool groups', () => {
	it('places every registered tool in the core or in exactly one group', () => {
		createMcpServer(config)
		const unplaced = [...registered.keys()].filter(
			(name) => !CORE_TOOLS.has(name) && groupOfTool(name) === undefined,
		)
		expect(unplaced).toEqual([])

		const seen = new Map<string, string>()
		for (const group of TOOL_GROUP_NAMES) {
			for (const tool of TOOL_GROUPS[group]) {
				expect(seen.get(tool), `${tool} is in two groups`).toBeUndefined()
				expect(CORE_TOOLS.has(tool), `${tool} is core and grouped`).toBe(false)
				seen.set(tool, group)
			}
		}
	})

	it('names only tools that exist', () => {
		createMcpServer(config)
		const names = [...CORE_TOOLS, ...Object.values(TOOL_GROUPS).flat()]
		expect(names.filter((name) => !registered.has(name))).toEqual([])
	})

	it('leaves a plain agent fewer than half of the tools', () => {
		createMcpServer({ ...config, toolGroups: [] })
		const listed = registered.size - disabledNames().length
		expect(listed).toBe(CORE_TOOLS.size)
		expect(listed).toBeLessThan(registered.size / 2)
	})

	it('lists everything when no groups are set', () => {
		createMcpServer(config)
		expect(disabledNames()).toEqual([])
	})

	it('lists the tools of a granted group and hides the others', () => {
		createMcpServer({ ...config, toolGroups: ['files'] })
		const hidden = disabledNames()
		expect(hidden).not.toContain('create_file')
		expect(hidden).toContain('desktop_run')
		expect(hidden).toContain('create_actor')
		expect(hidden).not.toContain('get_objects')
	})

	it('puts every desktop tool in the computer group', () => {
		createMcpServer({ ...config, toolGroups: [] })
		const desktop = [...registered.keys()].filter((n) => n.startsWith('desktop_'))
		expect(desktop.length).toBeGreaterThan(0)
		for (const name of desktop) expect(isToolHidden(name, [])).toBe(true)
		expect(isToolHidden('desktop_run', ['computer'])).toBe(false)
	})
})

describe('readGrantedToolGroups', () => {
	it('is undefined without a list, so nothing is hidden', () => {
		expect(readGrantedToolGroups(null)).toBeUndefined()
		expect(readGrantedToolGroups({ mcpServers: {} })).toBeUndefined()
		expect(readGrantedToolGroups({ maskin_tool_groups: 'files' })).toBeUndefined()
	})

	it('keeps known group names and drops the rest', () => {
		expect(readGrantedToolGroups({ maskin_tool_groups: ['files', 'nope', 'computer'] })).toEqual([
			'computer',
			'files',
		])
		expect(readGrantedToolGroups({ maskin_tool_groups: [] })).toEqual([])
	})
})

describe('isToolGroupsEnabled', () => {
	it('is off unless the variable is true or 1', () => {
		expect(isToolGroupsEnabled({})).toBe(false)
		expect(isToolGroupsEnabled({ MASKIN_TOOL_GROUPS: 'off' })).toBe(false)
		expect(isToolGroupsEnabled({ MASKIN_TOOL_GROUPS: 'true' })).toBe(true)
		expect(isToolGroupsEnabled({ MASKIN_TOOL_GROUPS: '1' })).toBe(true)
	})
})

describe('seeding helpers', () => {
	it('maps tool names to the groups that hold them', () => {
		expect(groupsForToolNames(['get_objects', 'create_file', 'desktop_click', 'nope'])).toEqual([
			'computer',
			'files',
		])
		expect(groupsForToolNames([])).toEqual([])
	})

	it('finds grouped tool names written in a prompt', () => {
		const text =
			'Use create_trigger, then desktop_screenshot. Never call get_objects or some_other_word.'
		expect(groupedToolNamesIn(text).sort()).toEqual(['create_trigger', 'desktop_screenshot'])
	})
})
