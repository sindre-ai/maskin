/** The zone this browser is set to (an IANA name), or null when it cannot say. */
export function browserTimezone(): string | null {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || null
	} catch {
		return null
	}
}

/** IANA names for the picker, sorted, with `current` always in the list even if the browser's database lacks it. */
export function timezoneOptions(current: string | null): string[] {
	let zones: string[] = []
	try {
		zones = Intl.supportedValuesOf('timeZone')
	} catch {
		// An older browser has no list; the current zone alone still works.
	}
	return [...new Set(['UTC', ...zones, ...(current ? [current] : [])])].sort((a, b) =>
		a.localeCompare(b),
	)
}
