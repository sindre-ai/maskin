import { type Database, toolBrokerCatalog } from '@maskin/db'
import { eq, inArray, notInArray, sql } from 'drizzle-orm'
import { logger } from '../logger'

// ---------------------------------------------------------------------------
// Catalogue ingest.
//
// Maskin never talks to the catalogue's source. A job outside this repo fetches
// it, applies the detected-only filter and normalises every record, then hands
// the result here. This module's job is to make that hand-off safe: it is the
// last point at which an upstream-shaped value could enter the database, and it
// refuses rather than sanitising, because a quietly stripped field is a field
// nobody notices is missing.
//
// Two behaviours that matter more than the upsert itself:
//
//   - Entries that vanish upstream are marked INACTIVE, never deleted. A
//     workspace may already have connected one, and its absence upstream is not
//     a reason for us to forget what it was.
//
//   - An anomalous collapse in row count ABORTS the sync. Upstream breaking
//     should not silently empty our catalogue; a run that would deactivate most
//     of it is far more likely to be a broken fetch than 400 integrations
//     disappearing at once.
// ---------------------------------------------------------------------------

/** Below this share of the previous count, a sync is treated as upstream breakage. */
const COLLAPSE_THRESHOLD = 0.6

/**
 * The guard only applies once the catalogue is big enough for a ratio to mean
 * something. On a catalogue of two, removing one entry is a 50% collapse and
 * obviously fine; on a catalogue of five hundred it is a broken fetch. Without
 * this floor the guard blocks ordinary edits to a small or freshly-seeded
 * catalogue, which would teach whoever hits it to disable the guard.
 */
const COLLAPSE_FLOOR = 10

export interface CatalogEntryInput {
	name: string
	description?: string | null
	domain: string
	/** Key in Maskin storage. Never a URL — see `assertNormalised`. */
	iconPath?: string | null
	connectKind: 'mcp' | 'openapi'
	endpointUrl: string
	authKind: 'none' | 'api_key' | 'oauth2'
	supportsDcr?: boolean
	credentialSetup?: string | null
	verifiedAt?: string | null
}

export interface CatalogSyncResult {
	received: number
	upserted: number
	deactivated: number
	skipped: number
}

/** A submitted entry carried something that must never be stored. */
export class CatalogNormalisationError extends Error {
	constructor(
		readonly field: string,
		readonly reason: string,
	) {
		super(`Catalogue entry rejected: ${field} ${reason}`)
		this.name = 'CatalogNormalisationError'
	}
}

/** The sync would have destroyed most of the catalogue, so it did nothing. */
export class CatalogCollapseError extends Error {
	constructor(
		readonly received: number,
		readonly existing: number,
	) {
		super(
			`Refusing to sync ${received} entries against an existing ${existing}: an upstream failure must not empty the catalogue`,
		)
		this.name = 'CatalogCollapseError'
	}
}

/**
 * Reject anything upstream-shaped before it reaches the database.
 *
 * The database CHECK already refuses a URL in `icon_path`; this repeats it here
 * so the caller gets a named field rather than a constraint violation, and adds
 * the checks a column type cannot express.
 */
export const assertNormalised = (entry: CatalogEntryInput): void => {
	if (entry.iconPath && /^[a-z][a-z0-9+.-]*:/i.test(entry.iconPath)) {
		// An upstream icon URL in the DOM leaks the catalogue's source into every
		// browser request — invisible to any scan of our source, because the
		// string never appears in it.
		throw new CatalogNormalisationError('iconPath', 'must be a storage key, not a URL')
	}

	// The endpoint is the third party's own address, which is exactly what we
	// want; anything else with a scheme is suspect.
	if (!/^https?:\/\//i.test(entry.endpointUrl)) {
		throw new CatalogNormalisationError('endpointUrl', 'must be an http(s) URL')
	}

	if (!entry.name.trim()) throw new CatalogNormalisationError('name', 'is required')
	if (!entry.domain.trim()) throw new CatalogNormalisationError('domain', 'is required')
}

/**
 * Replace the catalogue with `entries`, idempotently.
 *
 * Keyed on `endpointUrl` — the provider's own address is the natural identity,
 * and it survives an upstream id changing.
 */
export const syncCatalog = async (
	db: Database,
	entries: CatalogEntryInput[],
): Promise<CatalogSyncResult> => {
	for (const entry of entries) assertNormalised(entry)

	const [{ count: existing = 0 } = { count: 0 }] = await db
		.select({ count: sql<number>`count(*)::int` })
		.from(toolBrokerCatalog)
		.where(eq(toolBrokerCatalog.status, 'active'))

	// The guard runs before any write, so a bad run changes nothing at all.
	if (existing >= COLLAPSE_FLOOR && entries.length < existing * COLLAPSE_THRESHOLD) {
		logger.error('Aborting catalogue sync: received far fewer entries than are stored', {
			received: entries.length,
			existing,
		})
		throw new CatalogCollapseError(entries.length, existing)
	}

	let upserted = 0
	for (const entry of entries) {
		await db
			.insert(toolBrokerCatalog)
			.values({
				name: entry.name,
				description: entry.description ?? null,
				domain: entry.domain,
				iconPath: entry.iconPath ?? null,
				connectKind: entry.connectKind,
				endpointUrl: entry.endpointUrl,
				authKind: entry.authKind,
				supportsDcr: entry.supportsDcr ?? false,
				credentialSetup: entry.credentialSetup ?? null,
				verifiedAt: entry.verifiedAt ? new Date(entry.verifiedAt) : null,
				status: 'active',
			})
			.onConflictDoUpdate({
				target: toolBrokerCatalog.endpointUrl,
				set: {
					name: entry.name,
					description: entry.description ?? null,
					domain: entry.domain,
					iconPath: entry.iconPath ?? null,
					connectKind: entry.connectKind,
					authKind: entry.authKind,
					supportsDcr: entry.supportsDcr ?? false,
					credentialSetup: entry.credentialSetup ?? null,
					verifiedAt: entry.verifiedAt ? new Date(entry.verifiedAt) : null,
					// A previously-inactive entry that reappears becomes active again.
					status: 'active',
					updatedAt: new Date(),
				},
			})
		upserted += 1
	}

	// Anything not in this run is gone upstream — deactivate, never delete.
	const seen = entries.map((entry) => entry.endpointUrl)
	const deactivated = await db
		.update(toolBrokerCatalog)
		.set({ status: 'inactive', updatedAt: new Date() })
		.where(
			seen.length > 0
				? notInArray(toolBrokerCatalog.endpointUrl, seen)
				: // An empty run only reaches here when the catalogue was empty too.
					inArray(toolBrokerCatalog.endpointUrl, seen),
		)
		.returning({ id: toolBrokerCatalog.id })

	logger.info('Catalogue sync complete', {
		received: entries.length,
		upserted,
		deactivated: deactivated.length,
	})

	return {
		received: entries.length,
		upserted,
		deactivated: deactivated.length,
		skipped: entries.length - upserted,
	}
}
