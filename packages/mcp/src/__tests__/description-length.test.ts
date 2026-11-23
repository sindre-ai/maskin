import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// Tool search and the client's tool list both read the description, and clients
// truncate long ones. Cap every registered description (the listed text a client
// sees, not just the raw entry in tools.ts) so a long how-to never creeps back in.
const MAX_DESCRIPTION_LENGTH = 1500

describe('tool description length', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness()
	})

	afterAll(async () => {
		await harness.close()
	})

	it(`no registered tool description is over ${MAX_DESCRIPTION_LENGTH} characters`, async () => {
		const tools = (await harness.client.listTools()).tools
		const tooLong = tools
			.map((t) => ({ name: t.name, length: (t.description ?? '').length }))
			.filter((t) => t.length > MAX_DESCRIPTION_LENGTH)
			.map((t) => `${t.name} (${t.length})`)
		expect(
			tooLong,
			`Shorten these descriptions to at most ${MAX_DESCRIPTION_LENGTH} characters`,
		).toEqual([])
	})
})
