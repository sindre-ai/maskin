// Names the keys an update_objects call sent that the tool ignores, but only when that leaves the
// whole call with nothing to write. The entry schema strips unknown keys, so by the time the
// handler runs they are gone and its "wrote nothing" refusal cannot say what was wrong. In
// sessions reviewed on 2026-11-12, four of five such refusals were `edges` nested inside an
// update entry, and the fifth was `description` where the field is `content`.
//
// Runs on the raw arguments, before validation. Returns a message to reject the call with, or null
// when the call writes something or there is no ignored key to name.

const ENTRY_FIELDS = new Set([
	'id',
	'title',
	'content',
	'status',
	'metadata',
	'driver',
	'attach_file_ids',
	'detach_file_ids',
])

const HINTS: Record<string, string> = {
	edges:
		'edges go at the top level beside updates, as edges: [{source_id, target_id, type}], not inside an update entry',
	description: 'the field is content',
	body: 'the field is content',
	text: 'the field is content',
	name: 'the field is title',
	driver_id: 'the field is driver',
}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === 'object' && v !== null && !Array.isArray(v)

const hasItems = (v: unknown) => Array.isArray(v) && v.length > 0

function entryWritesSomething(entry: Record<string, unknown>): boolean {
	for (const [key, value] of Object.entries(entry)) {
		if (key === 'id' || !ENTRY_FIELDS.has(key)) continue
		if (key === 'attach_file_ids' || key === 'detach_file_ids') {
			if (hasItems(value)) return true
		} else if (value !== undefined) {
			return true
		}
	}
	return false
}

export function explainIgnoredUpdateKeys(args: unknown): string | null {
	if (!isPlainObject(args) || hasItems(args.edges) || !Array.isArray(args.updates)) return null

	const ignored = new Set<string>()
	for (const entry of args.updates) {
		if (!isPlainObject(entry)) continue
		if (entryWritesSomething(entry)) return null
		for (const key of Object.keys(entry)) if (!ENTRY_FIELDS.has(key)) ignored.add(key)
	}
	if (ignored.size === 0) return null

	const keys = [...ignored]
	const hints = keys.flatMap((key) => (HINTS[key] ? [`${key}: ${HINTS[key]}`] : []))
	return `update_objects wrote nothing: the update entries only had keys this tool ignores (${keys.join(', ')}). ${hints.length > 0 ? `${hints.join('; ')}. ` : ''}Each entry needs an id plus at least one of ${[...ENTRY_FIELDS].filter((f) => f !== 'id').join(', ')}. Example: updates: [{id, status: "done"}], edges: [{source_id, target_id, type: "relates_to"}]. Nothing was written.`
}
