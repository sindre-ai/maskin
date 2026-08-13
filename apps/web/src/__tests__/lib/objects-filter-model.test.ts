import {
	DEFAULT_ORDER,
	DEFAULT_SORT,
	type ObjectsFilterModel,
	defaultObjectsFilterModel,
	fromUrlSearch,
	toBoardParams,
	toDisplaySettingsBody,
	toListParams,
} from '@/lib/objects-filter-model'

const baseModel = (): ObjectsFilterModel => defaultObjectsFilterModel()

describe('objects-filter-model', () => {
	describe('defaultObjectsFilterModel', () => {
		it('defaults to sort=createdAt, order=desc, empty metadata, archived off', () => {
			const model = defaultObjectsFilterModel()
			expect(model).toEqual({
				sort: DEFAULT_SORT,
				order: DEFAULT_ORDER,
				metadata: {},
				includeArchived: false,
			})
		})

		it('returns a fresh object each call (no shared mutation)', () => {
			const a = defaultObjectsFilterModel()
			const b = defaultObjectsFilterModel()
			expect(a).not.toBe(b)
			a.metadata = { x: '1' }
			expect(b.metadata).toEqual({})
		})
	})

	describe('fromUrlSearch', () => {
		it('applies defaults when inputs are absent', () => {
			const model = fromUrlSearch({})
			expect(model.sort).toBe(DEFAULT_SORT)
			expect(model.order).toBe(DEFAULT_ORDER)
			expect(model.includeArchived).toBe(false)
			expect(model.metadata).toEqual({})
		})

		it('maps every input field onto the model', () => {
			const model = fromUrlSearch({
				type: 'bet',
				status: 'active,define',
				driver: 'a1',
				sort: 'updatedAt',
				order: 'asc',
				q: 'hello',
				groupBy: 'status',
				ids: 'o1,o2',
				includeArchived: true,
				metadata: { priority: '5' },
			})
			expect(model).toMatchObject({
				type: 'bet',
				status: 'active,define',
				driver: 'a1',
				sort: 'updatedAt',
				order: 'asc',
				q: 'hello',
				groupBy: 'status',
				ids: 'o1,o2',
				includeArchived: true,
				metadata: { priority: '5' },
			})
		})

		it('defensive-copies metadata so later mutation cannot leak backward', () => {
			const source = { priority: '5' }
			const model = fromUrlSearch({ metadata: source })
			source.priority = 'changed'
			expect(model.metadata).toEqual({ priority: '5' })
		})
	})

	describe('toListParams', () => {
		it('omits empty filters and ids but keeps sort/order', () => {
			const params = toListParams(baseModel())
			expect(params).toEqual({ sort: DEFAULT_SORT, order: DEFAULT_ORDER })
		})

		it('includes type/status/driver/ids and metadata.* keys', () => {
			const params = toListParams({
				...fromUrlSearch({
					type: 'bet',
					status: 'active,define',
					driver: 'a1',
					ids: 'o1,o2',
					metadata: { priority: '5', active: 'true' },
				}),
			})
			expect(params).toMatchObject({
				type: 'bet',
				status: 'active,define',
				driver: 'a1',
				ids: 'o1,o2',
				'metadata.priority': '5',
				'metadata.active': 'true',
				sort: DEFAULT_SORT,
				order: DEFAULT_ORDER,
			})
		})

		it('never emits the search term — q belongs to the page search endpoint', () => {
			const params = toListParams(fromUrlSearch({ q: 'hello' }))
			expect(params.q).toBeUndefined()
		})

		it('emits include_archived only when on AND allowed', () => {
			const on = fromUrlSearch({ includeArchived: true })
			expect(toListParams(on)).toHaveProperty('include_archived', 'true')
			expect(toListParams(on, { includeArchivedAllowed: false })).not.toHaveProperty(
				'include_archived',
			)
			expect(toListParams(baseModel())).not.toHaveProperty('include_archived')
		})
	})

	describe('toBoardParams', () => {
		it('returns null when no single object type is selected', () => {
			expect(toBoardParams(baseModel(), { pageSize: 20 })).toBeNull()
		})

		it('carries every List filter into the Board params — parity by construction', () => {
			const model = fromUrlSearch({
				type: 'bet',
				status: 'active,define',
				driver: 'a1',
				groupBy: 'status',
				sort: 'updatedAt',
				order: 'asc',
				metadata: { priority: '5' },
				includeArchived: true,
			})
			const listParams = toListParams(model)
			const boardParams = toBoardParams(model, { pageSize: 20 })
			expect(boardParams).not.toBeNull()
			// Every key/value the List query sees must also reach the Board query.
			// This is the T1 parity guarantee in executable form.
			for (const [key, value] of Object.entries(listParams)) {
				expect(boardParams?.[key]).toBe(value)
			}
		})

		it('adds paging and pass-through q/groupBy', () => {
			const params = toBoardParams(fromUrlSearch({ type: 'bet', q: 'x', groupBy: 'status' }), {
				pageSize: 25,
				offset: '10',
			})
			expect(params).toMatchObject({
				type: 'bet',
				limit: '25',
				offset: '10',
				q: 'x',
				groupBy: 'status',
			})
		})

		it('does not duplicate type when it already came from the shared model', () => {
			const params = toBoardParams(fromUrlSearch({ type: 'bet' }), { pageSize: 20 })
			expect(Object.keys(params ?? {}).filter((k) => k === 'type')).toHaveLength(1)
			expect(params?.type).toBe('bet')
		})

		it('gates include_archived on the same allowance as List', () => {
			const model = fromUrlSearch({ type: 'bet', includeArchived: true })
			expect(toBoardParams(model, { pageSize: 20 })?.include_archived).toBe('true')
			expect(
				toBoardParams(model, { pageSize: 20, includeArchivedAllowed: false })?.include_archived,
			).toBeUndefined()
		})
	})

	describe('toDisplaySettingsBody', () => {
		it('always persists sort/order/columnVisibility and nulls an absent groupBy', () => {
			const model = { ...fromUrlSearch({ columnVisibility: { createdBy: false } }) }
			const body = toDisplaySettingsBody(model)
			expect(body).toMatchObject({
				sort: DEFAULT_SORT,
				order: DEFAULT_ORDER,
				groupBy: null,
				columnVisibility: { createdBy: false },
			})
			expect(body.filters).toBeUndefined()
		})

		it('omits filters when no status/driver/metadata is set', () => {
			const body = toDisplaySettingsBody(baseModel())
			expect(body.filters).toBeUndefined()
		})

		it('maps status/driver/metadata into the filters block', () => {
			const body = toDisplaySettingsBody(
				fromUrlSearch({
					status: 'active',
					driver: 'a1',
					groupBy: 'status',
					metadata: { priority: '5' },
				}),
			)
			expect(body.groupBy).toBe('status')
			expect(body.filters).toEqual({
				status: 'active',
				driver: 'a1',
				metadata: { priority: '5' },
			})
		})
	})
})
