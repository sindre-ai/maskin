import {
	LIST_VIEWS_ALL_KEY,
	listViewsSettingsPatch,
	objectViewTabs,
	readListViews,
	viewTabs,
} from '@/lib/page-views'

const A = '11111111-1111-4111-8111-111111111111'
const B = '22222222-2222-4222-8222-222222222222'
const C = '33333333-3333-4333-8333-333333333333'

describe('readListViews', () => {
	const settings = {
		list_views: {
			contact: [{ name: 'Pipeline', file_id: A }],
			[LIST_VIEWS_ALL_KEY]: [{ name: 'Overview', file_id: B }],
		},
	}

	it('reads the views for one type, in order', () => {
		expect(readListViews(settings, 'contact')).toEqual([{ name: 'Pipeline', fileId: A }])
	})

	it('reads the list with no type from the all key', () => {
		expect(readListViews(settings, undefined)).toEqual([{ name: 'Overview', fileId: B }])
	})

	it('is empty for a type with none, and for missing or malformed settings', () => {
		expect(readListViews(settings, 'bet')).toEqual([])
		expect(readListViews(undefined, 'contact')).toEqual([])
		expect(readListViews({ list_views: 'nope' }, 'contact')).toEqual([])
		expect(readListViews({ list_views: [A] }, 'contact')).toEqual([])
		expect(readListViews({ list_views: { contact: 'nope' } }, 'contact')).toEqual([])
	})

	it('skips a row that is not a name and a file id', () => {
		expect(
			readListViews(
				{ list_views: { contact: [{ name: 'x' }, { name: 'Ok', file_id: A }] } },
				'contact',
			),
		).toEqual([{ name: 'Ok', fileId: A }])
	})
})

describe('listViewsSettingsPatch', () => {
	const settings = {
		list_views: { contact: [{ name: 'Pipeline', file_id: A }] },
		pinned_files: [C],
	}

	it('sets one type and carries the other types over', () => {
		const patch = listViewsSettingsPatch(settings, 'bet', [{ name: 'Risks', fileId: B }])
		expect(patch).toEqual({
			list_views: {
				contact: [{ name: 'Pipeline', file_id: A }],
				bet: [{ name: 'Risks', file_id: B }],
			},
		})
	})

	it('writes only the list_views key, never the rest of the settings', () => {
		const patch = listViewsSettingsPatch(settings, 'contact', [])
		expect(Object.keys(patch)).toEqual(['list_views'])
	})

	it('drops a type once its last view is removed', () => {
		expect(listViewsSettingsPatch(settings, 'contact', [])).toEqual({ list_views: {} })
	})

	it('files the list with no type under all', () => {
		const patch = listViewsSettingsPatch(undefined, undefined, [{ name: 'Overview', fileId: B }])
		expect(patch).toEqual({
			list_views: { [LIST_VIEWS_ALL_KEY]: [{ name: 'Overview', file_id: B }] },
		})
	})
})

describe('view tabs', () => {
	const views = [
		{ name: 'Pipeline', fileId: A },
		{ name: 'Risks', fileId: B },
	]

	it('numbers the tabs in order, as a flow does', () => {
		expect(viewTabs(views).map((v) => v.value)).toEqual(['view-0', 'view-1'])
	})

	it('lists the views on a list page tab row', () => {
		const tabs = viewTabs(
			readListViews({ list_views: { contact: [{ name: 'Pipeline', file_id: A }] } }, 'contact'),
		)
		expect(tabs).toEqual([{ name: 'Pipeline', fileId: A, value: 'view-0' }])
	})

	it('lists the views on an item page tab row from metadata.views', () => {
		const metadata = { views: [{ name: 'Timeline', file_id: A }] }
		expect(objectViewTabs(metadata, true)).toEqual([
			{ name: 'Timeline', fileId: A, value: 'view-0' },
		])
	})

	it('shows no tabs on an item page when the feature is off, or the item has no views', () => {
		expect(objectViewTabs({ views: [{ name: 'Timeline', file_id: A }] }, false)).toEqual([])
		expect(objectViewTabs({}, true)).toEqual([])
		expect(objectViewTabs(null, true)).toEqual([])
	})
})
