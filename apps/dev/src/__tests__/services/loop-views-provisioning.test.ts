import { LOOP_ID_TOKEN } from '../../lib/marketplace-loops/view-snapshot'
import {
	readInstalledViews,
	renderViewHtml,
	toViewItems,
} from '../../services/loop-views-provisioning'

const SRC_A = '11111111-1111-4111-a111-111111111111'
const SRC_B = '22222222-2222-4222-a222-222222222222'

describe('toViewItems', () => {
	it('returns only view items, in tab order', () => {
		const items = toViewItems([
			{
				itemType: 'view',
				sourceItemId: SRC_B,
				itemSnapshot: { name: 'Second', position: 1, html: '<p>b</p>' },
			},
			{ itemType: 'skill', sourceItemId: 'skill', itemSnapshot: { name: 'x', content: 'y' } },
			{
				itemType: 'view',
				sourceItemId: SRC_A,
				itemSnapshot: { name: 'First', position: 0, html: '<p>a</p>' },
			},
		])
		expect(items.map((i) => i.name)).toEqual(['First', 'Second'])
	})

	it('drops a view with no usable name or page', () => {
		const items = toViewItems([
			{ itemType: 'view', sourceItemId: SRC_A, itemSnapshot: { name: '  ', html: '<p/>' } },
			{
				itemType: 'view',
				sourceItemId: SRC_B,
				itemSnapshot: { name: 'x'.repeat(31), html: '<p/>' },
			},
			{ itemType: 'view', sourceItemId: 'c', itemSnapshot: { name: 'No page' } },
		])
		expect(items).toEqual([])
	})
})

describe('renderViewHtml', () => {
	it('swaps every loop id token for the loop object id', () => {
		const html = `a ${LOOP_ID_TOKEN} b ${LOOP_ID_TOKEN}`
		expect(renderViewHtml(html, SRC_A)).toBe(`a ${SRC_A} b ${SRC_A}`)
	})

	it('returns a page with no token unchanged', () => {
		expect(renderViewHtml('<p>hi</p>', SRC_A)).toBe('<p>hi</p>')
	})
})

describe('readInstalledViews', () => {
	it('reads the install record off the loop metadata and ignores malformed rows', () => {
		const ref = { source_item_id: SRC_A, file_id: SRC_B, source_hash: 'a', file_hash: 'b' }
		expect(readInstalledViews({ installed_views: [ref, { nope: true }, null] })).toEqual([ref])
		expect(readInstalledViews(null)).toEqual([])
		expect(readInstalledViews({ installed_views: 'x' })).toEqual([])
	})
})
