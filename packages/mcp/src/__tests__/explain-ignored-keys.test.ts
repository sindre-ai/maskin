import { describe, expect, it } from 'vitest'
import { explainIgnoredUpdateKeys } from '../explain-ignored-keys'

const ID = '11111111-1111-4111-8111-111111111111'
const OTHER = '22222222-2222-4222-8222-222222222222'
const edge = { source_id: ID, target_id: OTHER, type: 'relates_to' }

describe('explainIgnoredUpdateKeys', () => {
	it('names edges nested in an update entry and says where they go', () => {
		const text = explainIgnoredUpdateKeys({ updates: [{ id: ID, edges: [edge] }] })
		expect(text).toContain('(edges)')
		expect(text).toContain('beside updates')
		expect(text).toContain('Nothing was written')
	})

	it('points description at content', () => {
		const text = explainIgnoredUpdateKeys({ updates: [{ id: ID, description: 'x' }] })
		expect(text).toContain('description: the field is content')
	})

	it('names every ignored key once across entries', () => {
		const text = explainIgnoredUpdateKeys({
			updates: [
				{ id: ID, edges: [edge] },
				{ id: OTHER, edges: [edge], body: 'x' },
			],
		})
		expect(text).toContain('(edges, body)')
	})

	it('stays quiet when any entry changes a field', () => {
		expect(
			explainIgnoredUpdateKeys({
				updates: [
					{ id: ID, edges: [edge] },
					{ id: OTHER, status: 'done' },
				],
			}),
		).toBeNull()
	})

	it('stays quiet when top-level edges carry the write', () => {
		expect(explainIgnoredUpdateKeys({ updates: [{ id: ID, foo: 1 }], edges: [edge] })).toBeNull()
	})

	it('counts a non-empty attach list as a change, an empty one as nothing', () => {
		expect(explainIgnoredUpdateKeys({ updates: [{ id: ID, attach_file_ids: [OTHER] }] })).toBeNull()
		expect(
			explainIgnoredUpdateKeys({ updates: [{ id: ID, attach_file_ids: [], foo: 1 }] }),
		).toContain('(foo)')
	})

	it('leaves calls with no ignored key to the handler refusal', () => {
		expect(explainIgnoredUpdateKeys({ updates: [{ id: ID }] })).toBeNull()
		expect(explainIgnoredUpdateKeys({ updates: [] })).toBeNull()
		expect(explainIgnoredUpdateKeys({})).toBeNull()
		expect(explainIgnoredUpdateKeys('nope')).toBeNull()
	})
})
