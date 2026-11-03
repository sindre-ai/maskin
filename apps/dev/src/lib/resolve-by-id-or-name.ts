// Lowercase hex and hyphens in the 8-4-4-4-12 shape. Uppercase never reaches the
// resolver for skills: the path schema (skillNameSchema) rejects it with a 400.
const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export type ResolveMatch = { id: string; name: string }

export type ResolveResult<T> =
	| { kind: 'found'; row: T; via: 'id' | 'name' }
	| { kind: 'none' }
	| { kind: 'ambiguous'; matches: ResolveMatch[] }

/**
 * Resolve a caller-supplied reference that may be a row id or a row name.
 *
 * - UUID-shaped ref: try the id first. If no row has that id, fall back to the
 *   name, so a row that happens to be named like a UUID stays reachable (id
 *   wins, never an error).
 * - Any other ref: name only.
 * - Exact matching only: no trimming, no fuzzy and no case-insensitive match.
 *
 * Both finders must filter by the caller's workspace, so an id from another
 * workspace resolves to none. findByName returns every match so a type with
 * non-unique names can report ambiguity instead of picking the first row.
 */
export async function resolveByIdOrName<T extends ResolveMatch>({
	ref,
	findById,
	findByName,
}: {
	ref: string
	findById: (id: string) => Promise<T | null | undefined>
	findByName: (name: string) => Promise<T[]>
}): Promise<ResolveResult<T>> {
	if (UUID_SHAPE.test(ref)) {
		const byId = await findById(ref)
		if (byId) return { kind: 'found', row: byId, via: 'id' }
	}

	const byName = await findByName(ref)
	const [first, ...rest] = byName
	if (!first) return { kind: 'none' }
	if (rest.length === 0) return { kind: 'found', row: first, via: 'name' }

	const matches = byName
		.map(({ id, name }) => ({ id, name }))
		.sort((a, b) => a.id.localeCompare(b.id))
	return { kind: 'ambiguous', matches }
}
