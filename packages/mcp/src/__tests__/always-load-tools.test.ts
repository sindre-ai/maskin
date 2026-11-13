import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { ALWAYS_LOAD_META_KEY, ALWAYS_LOAD_TOOLS } from '../always-load'
import { MAX_INSTRUCTIONS_LENGTH, SERVER_INSTRUCTIONS } from '../server-instructions'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// The ten daily tools are loaded by the client at session start, so agents see their parameters
// without a tool search. Every session pays for them, hence the cap.
const MAX_ALWAYS_LOADED_TOKENS = 15_000

type ListedTool = { name: string; description?: string; _meta?: Record<string, unknown> }

describe('always-loaded tools', () => {
	let harness: AliasHarness
	let tools: ListedTool[]

	beforeAll(async () => {
		harness = await startAliasHarness()
		tools = (await harness.listTools()) as ListedTool[]
	})

	afterAll(async () => {
		await harness.close()
	})

	it('marks exactly the ten daily tools, and keeps their other metadata', () => {
		const marked = tools
			.filter((t) => t._meta?.[ALWAYS_LOAD_META_KEY] === true)
			.map((t) => t.name)
			.sort()
		expect(marked).toEqual([...ALWAYS_LOAD_TOOLS].sort())
		expect(marked).toHaveLength(10)
		// get_objects renders in the objects widget; the mark must not replace that.
		expect(tools.find((t) => t.name === 'get_objects')?._meta?.ui).toBeDefined()
	})

	it(`the ten definitions stay under ${MAX_ALWAYS_LOADED_TOKENS} tokens`, () => {
		const chars = tools
			.filter((t) => ALWAYS_LOAD_TOOLS.has(t.name))
			.reduce((sum, t) => sum + JSON.stringify(t).length, 0)
		// Same rough measure as the other size notes: four characters to a token.
		expect(
			chars / 4,
			`The always-loaded tools are about ${Math.round(chars / 4)} tokens; every session pays that. Make them smaller before raising the cap.`,
		).toBeLessThanOrEqual(MAX_ALWAYS_LOADED_TOKENS)
	})

	it('update_objects and create_objects carry an example call in their description', () => {
		for (const name of ['update_objects', 'create_objects']) {
			expect(tools.find((t) => t.name === name)?.description).toContain(`Example: ${name}(`)
		}
	})
})

describe('server instructions', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness()
	})

	afterAll(async () => {
		await harness.close()
	})

	it('are sent to the client at connect', () => {
		expect(harness.client.getInstructions()).toBe(SERVER_INSTRUCTIONS)
	})

	it(`fit in ${MAX_INSTRUCTIONS_LENGTH} characters, under the client's cut`, () => {
		expect(SERVER_INSTRUCTIONS.length).toBeLessThanOrEqual(MAX_INSTRUCTIONS_LENGTH)
	})

	it('only name tools that are registered', async () => {
		const registered = new Set((await harness.listTools()).map((t) => t.name))
		const named = SERVER_INSTRUCTIONS.match(/\b[a-z]+(?:_[a-z]+)+\b/g) ?? []
		const unknown = [...new Set(named)].filter(
			(token) =>
				// Field names and wildcards that are not tools.
				!['next_cursor', 'desktop_'].includes(token) &&
				/^(get|list|create|update|delete|set|post|send|pause|resume|stop|ask|connect|request|add|resend|gmail|transcribe|propose|withdraw|mark|traverse|query)_/.test(
					token,
				) &&
				!registered.has(token),
		)
		expect(unknown, 'Instructions name tools that do not exist').toEqual([])
	})
})
