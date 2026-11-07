import type { SearchSort, UpdatedFilter } from '@/lib/search/url-state'
import { RadioFilter } from './search-chips'

export const SORT_OPTIONS: Array<{ value: SearchSort; label: string }> = [
	{ value: 'rel', label: 'Relevance' },
	{ value: 'recent', label: 'Recently updated' },
	{ value: 'az', label: 'A to Z' },
]

export const UPDATED_OPTIONS: Array<{ value: UpdatedFilter; label: string }> = [
	{ value: '', label: 'Any time' },
	{ value: 'day', label: 'Past day' },
	{ value: 'week', label: 'Past week' },
	{ value: 'month', label: 'Past month' },
]

// Radix radio items cannot hold an empty value, so "no Updated window" is this word in the menu.
const ANY_TIME = 'any'

/** The Updated pill: a window on how recently a row changed. */
export function UpdatedPill({
	value,
	onChange,
}: {
	value: UpdatedFilter
	onChange: (value: UpdatedFilter) => void
}) {
	const options = UPDATED_OPTIONS.map((o) => ({ ...o, value: o.value || ANY_TIME }))
	const label = UPDATED_OPTIONS.find((o) => o.value === value)?.label ?? 'Any time'
	return (
		<RadioFilter
			name="Updated"
			value={value || ANY_TIME}
			options={options}
			onChange={(next) => onChange(next === ANY_TIME ? '' : (next as UpdatedFilter))}
			summary={value === '' ? 'Updated' : `Updated: ${label}`}
			active={value !== ''}
		/>
	)
}

/** The Sort pill, at the right end of the filter row. */
export function SortPill({
	value,
	onChange,
}: {
	value: SearchSort
	onChange: (value: SearchSort) => void
}) {
	const label = SORT_OPTIONS.find((o) => o.value === value)?.label ?? 'Relevance'
	return (
		<RadioFilter
			name="Sort"
			value={value}
			options={SORT_OPTIONS}
			onChange={onChange}
			summary={`Sort: ${label}`}
			active={value !== 'rel'}
			className="ml-auto"
		/>
	)
}
