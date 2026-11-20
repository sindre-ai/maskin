import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// Every agent session that mounts the Maskin MCP server carries its whole tool list in context
// before it does anything. Measured 2026-11-12 on main: 110 tools, 265,247 characters of tools/list
// JSON, roughly 75,000 tokens; create_comment alone is about 20,700 characters. The description cap
// (description-length.test.ts) does not catch growth in input schemas or in the number of tools,
// so this pins the whole list and each tool.
//
// If this fails, the change made the list bigger. First try to make it smaller: move how-to text
// into a skill, drop a rarely used parameter, merge near-duplicate tools. Raise a limit only on
// purpose, in a PR that says why, because every agent pays for it on every session.
const MAX_LIST_CHARS = 275_000
const MAX_TOOL_CHARS = 22_000

describe('tool list size', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness()
	})

	afterAll(async () => {
		await harness.close()
	})

	it(`the whole tools/list stays under ${MAX_LIST_CHARS} characters`, async () => {
		const tools = (await harness.client.listTools()).tools
		const size = JSON.stringify(tools).length
		expect(
			size,
			`tools/list is ${size} characters across ${tools.length} tools; the limit is ${MAX_LIST_CHARS}`,
		).toBeLessThanOrEqual(MAX_LIST_CHARS)
	})

	it(`no single tool is over ${MAX_TOOL_CHARS} characters`, async () => {
		const tools = (await harness.client.listTools()).tools
		const heavy = tools
			.map((t) => ({ name: t.name, size: JSON.stringify(t).length }))
			.filter((t) => t.size > MAX_TOOL_CHARS)
			.map((t) => `${t.name} (${t.size})`)
		expect(heavy, `Shrink these tools to at most ${MAX_TOOL_CHARS} characters`).toEqual([])
	})
})
