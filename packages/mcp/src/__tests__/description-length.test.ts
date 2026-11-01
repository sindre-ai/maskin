import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { type AliasHarness, startAliasHarness } from './helpers/alias-harness'

// Tool search and the client's tool list both read the description, and clients
// truncate long ones. Cap every registered description (the listed text a client
// sees, not just the raw entry in tools.ts) so a long how-to never creeps back in.
const MAX_DESCRIPTION_LENGTH = 1500

// get_actor is out of scope for the description shortening (the 6 Nov misfire
// read judges it, so its text must not change before then). Remove this entry
// and shorten it after that read.
const OVER_CAP_UNTIL_MISFIRE_READ = new Set(['get_actor'])

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
			.filter((t) => !OVER_CAP_UNTIL_MISFIRE_READ.has(t.name))
			.map((t) => ({ name: t.name, length: (t.description ?? '').length }))
			.filter((t) => t.length > MAX_DESCRIPTION_LENGTH)
			.map((t) => `${t.name} (${t.length})`)
		expect(
			tooLong,
			`Shorten these descriptions to at most ${MAX_DESCRIPTION_LENGTH} characters`,
		).toEqual([])
	})

	it('the exemption list only names tools that are still over the cap', async () => {
		const tools = (await harness.client.listTools()).tools
		const stale = [...OVER_CAP_UNTIL_MISFIRE_READ].filter((name) => {
			const t = tools.find((x) => x.name === name)
			return !t || (t.description ?? '').length <= MAX_DESCRIPTION_LENGTH
		})
		expect(stale, 'Remove these from OVER_CAP_UNTIL_MISFIRE_READ').toEqual([])
	})
})
