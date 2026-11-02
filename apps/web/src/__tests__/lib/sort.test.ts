import { sortBy, sortByName } from '@/lib/sort'

describe('sortByName', () => {
	it('sorts alphabetically, ignoring case', () => {
		const sorted = sortByName([
			{ id: '1', name: 'zebra' },
			{ id: '2', name: 'Apple' },
			{ id: '3', name: 'mango' },
		])
		expect(sorted.map((i) => i.name)).toEqual(['Apple', 'mango', 'zebra'])
	})

	it('orders numbers naturally', () => {
		const sorted = sortByName([
			{ id: '1', name: 'Agent 10' },
			{ id: '2', name: 'Agent 2' },
		])
		expect(sorted.map((i) => i.name)).toEqual(['Agent 2', 'Agent 10'])
	})

	it('breaks ties on id and does not mutate the input', () => {
		const input = [
			{ id: 'b', name: 'Same' },
			{ id: 'a', name: 'Same' },
		]
		expect(sortByName(input).map((i) => i.id)).toEqual(['a', 'b'])
		expect(input.map((i) => i.id)).toEqual(['b', 'a'])
	})
})

describe('sortByName with a custom tiebreak', () => {
	it('sorts items that have no id', () => {
		const sorted = sortByName(
			[
				{ key: 'b', name: 'Slack' },
				{ key: 'a', name: 'Slack' },
				{ key: 'c', name: 'Gmail' },
			],
			(i) => i.key,
		)
		expect(sorted.map((i) => i.key)).toEqual(['c', 'a', 'b'])
	})
})

describe('sortBy', () => {
	it('puts items with no label last', () => {
		const sorted = sortBy(
			[
				{ id: '1', label: '' },
				{ id: '2', label: 'Zed' },
				{ id: '3', label: 'abe' },
			],
			(i) => i.label,
			(i) => i.id,
		)
		expect(sorted.map((i) => i.id)).toEqual(['3', '2', '1'])
	})
})
