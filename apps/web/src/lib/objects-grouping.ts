import type { ActorListItem, ObjectResponse } from './api'

/** Sentinel group label for objects whose group value is empty/absent. */
export const NO_VALUE_GROUP = 'No value'

const DATE_GROUP_RE = /^\d{4}-\d{2}-\d{2}$/
const MONTHS = [
	'January',
	'February',
	'March',
	'April',
	'May',
	'June',
	'July',
	'August',
	'September',
	'October',
	'November',
	'December',
]

/** The raw group key an object falls into for a `groupBy` column — `'No value'`
 *  when the field is empty, mirroring the board's column derivation so a group
 *  seen in List and Board is spelled the same way. */
export function getObjectGroupValue(object: ObjectResponse, groupBy?: string): string {
	if (!groupBy || groupBy === 'status') return object.status
	if (groupBy.startsWith('metadata.')) {
		const key = groupBy.slice('metadata.'.length)
		const metadata = object.metadata as Record<string, unknown> | null
		const value = metadata?.[key]
		return value == null || value === '' ? NO_VALUE_GROUP : String(value)
	}
	const value = object[groupBy as keyof ObjectResponse]
	return value == null || value === '' ? NO_VALUE_GROUP : String(value)
}

function formatGroupDate(dateKey: string): string {
	if (!DATE_GROUP_RE.test(dateKey)) return dateKey
	const [y, m, d] = dateKey.split('-').map(Number) as [number, number, number]
	const suffix =
		d % 10 === 1 && d !== 11
			? 'st'
			: d % 10 === 2 && d !== 12
				? 'nd'
				: d % 10 === 3 && d !== 13
					? 'rd'
					: 'th'
	return `${d}${suffix} ${MONTHS[m - 1]} ${y}`
}

/** Human-readable group header label for a raw group value. Status values are
 *  de-underscored; actor-keyed groups resolve to the actor's name; date-keyed
 *  groups render "2nd March 2026"; anything else passes through unchanged. */
export function getObjectGroupLabel(
	groupBy: string | undefined,
	rawValue: string,
	actors?: ActorListItem[],
): string {
	if (groupBy === 'status') return rawValue.replace(/_/g, ' ')
	if (groupBy === 'driver' || groupBy === 'owner' || groupBy === 'createdBy') {
		return actors?.find((a) => a.id === rawValue)?.name ?? rawValue
	}
	return formatGroupDate(rawValue)
}
