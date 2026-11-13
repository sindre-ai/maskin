import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { renameNotice, withRenameNotice } from '../alias-notice'
import { type AliasHarness, DEFAULT_WORKSPACE_ID, startAliasHarness } from './helpers/alias-harness'

const U1 = '11111111-1111-4111-8111-111111111111'
const WS = DEFAULT_WORKSPACE_ID

// The reply tells the agent when an old parameter name was accepted, and which name is current.
describe('old parameter name notice', () => {
	let harness: AliasHarness

	beforeAll(async () => {
		harness = await startAliasHarness()
	})

	afterAll(async () => {
		await harness.close()
	})

	async function textItems(name: string, args: Record<string, unknown>): Promise<string[]> {
		const result = (await harness.client.callTool({ name, arguments: args })) as {
			content?: Array<{ type: string; text?: string }>
		}
		return (result.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '')
	}

	it('says so when a call used an old name, and names the current one', async () => {
		const texts = await textItems('list_objects', { workspace_id: WS, driver_id: U1 })
		const notice = texts.find((t) => t.includes('old parameter name'))
		expect(notice).toContain('"driver_id" is now "driver"')
	})

	it('names every old spelling a batch call used, by its own key', async () => {
		const texts = await textItems('create_objects', {
			workspace_id: WS,
			nodes: [{ $id: 'a', type: 'task', status: 'todo', title: 'A', driver_id: U1 }],
			edges: [{ source_id: 'a', target_id: U1, type: 'relates_to' }],
		})
		const notice = texts.find((t) => t.includes('old parameter name')) ?? ''
		expect(notice).toContain('"driver_id" is now "driver"')
		expect(notice).toContain('"source_id" is now "source"')
		expect(notice).toContain('"target_id" is now "target"')
	})

	it('adds nothing when the call used the current names', async () => {
		const texts = await textItems('list_objects', { workspace_id: WS, driver: U1 })
		expect(texts.some((t) => t.includes('old parameter name'))).toBe(false)
	})

	it('does not carry a notice over to the next call', async () => {
		await textItems('list_objects', { workspace_id: WS, driver_id: U1 })
		const texts = await textItems('list_objects', { workspace_id: WS })
		expect(texts.some((t) => t.includes('old parameter name'))).toBe(false)
	})
})

describe('renameNotice and withRenameNotice', () => {
	it('uses the last path segment of each spelling', () => {
		expect(renameNotice([{ old: 'updates.driver_id', new: 'updates.driver' }])).toContain(
			'"driver_id" is now "driver"',
		)
	})

	it('leaves a response with no content list, or no renames, as it is', () => {
		const noContent = { structuredContent: {} }
		expect(withRenameNotice(noContent, [{ old: 'a', new: 'b' }])).toBe(noContent)
		const plain = { content: [{ type: 'text', text: 'x' }] }
		expect(withRenameNotice(plain, [])).toBe(plain)
	})
})
