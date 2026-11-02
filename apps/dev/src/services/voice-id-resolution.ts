import type { Database } from '@maskin/db'
import { objects } from '@maskin/db/schema'
import { and, eq, sql } from 'drizzle-orm'
import type { StartCard } from './voice-call-state'

/**
 * A realtime voice model copies 36-character ids badly: it drops a dash, wraps the id in quotes,
 * pastes the whole link, or keeps only the first eight characters it was shown in a receipt.
 * The tools behind it validate strictly (`z.string().uuid()`), so one slip used to cost the whole
 * call: "the system rejected the ID as invalid", and the card was never opened.
 *
 * This runs at the tool boundary. It repairs an id only when the repair is unambiguous, and it
 * never guesses: an id that cannot be resolved is reported, not swapped for another one.
 */

const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i
const HEX32_RE = /^[0-9a-f]{32}$/i
/** Shortest id prefix that is still specific enough to resolve. Eight characters is what receipts show. */
export const MIN_ID_PREFIX = 8

export type CanonicalId =
	| { kind: 'uuid'; id: string }
	| { kind: 'prefix'; hex: string }
	| { kind: 'bad' }

/** Pure clean-up of what the model sent. No lookups. */
export function canonicalizeId(raw: unknown): CanonicalId {
	if (typeof raw !== 'string') return { kind: 'bad' }
	const text = raw.trim()
	if (!text || text.length > 2100) return { kind: 'bad' }
	// A full id anywhere in the text: a link, "urn:uuid:...", quotes, braces, a trailing full stop.
	const embedded = text.match(UUID_RE)
	if (embedded) return { kind: 'uuid', id: embedded[0].toLowerCase() }
	const bare = text.replace(/[\s"'`<>{}()[\].,;:]/g, '').toLowerCase()
	if (HEX32_RE.test(bare)) {
		return {
			kind: 'uuid',
			id: `${bare.slice(0, 8)}-${bare.slice(8, 12)}-${bare.slice(12, 16)}-${bare.slice(16, 20)}-${bare.slice(20)}`,
		}
	}
	const hex = bare.replace(/-/g, '')
	if (/^[0-9a-f]+$/.test(hex) && hex.length >= MIN_ID_PREFIX && hex.length < 32) {
		return { kind: 'prefix', hex }
	}
	return { kind: 'bad' }
}

const startsWithHex = (id: string | null, hex: string) =>
	id?.replace(/-/g, '').toLowerCase().startsWith(hex) === true

export type IdResolution =
	| { ok: true; id: string; repaired: boolean }
	| { ok: false; reason: 'malformed' | 'not_found' | 'ambiguous' }

/**
 * Turns what the model sent into one object id of this workspace, or says why it cannot.
 * A prefix is looked for first among the cards the call started with, then among the workspace's
 * objects, and only a single match counts. A full id costs no lookup here.
 */
export async function resolveObjectId(
	db: Database,
	workspaceId: string,
	raw: unknown,
	startCards: StartCard[] | null = null,
): Promise<IdResolution> {
	const canon = canonicalizeId(raw)
	if (canon.kind === 'bad') return { ok: false, reason: 'malformed' }
	if (canon.kind === 'uuid') {
		return { ok: true, id: canon.id, repaired: canon.id !== raw }
	}
	const fromCards = new Set<string>()
	for (const card of startCards ?? []) {
		if (card.objectId && startsWithHex(card.objectId, canon.hex)) fromCards.add(card.objectId)
	}
	if (fromCards.size === 1) return { ok: true, id: [...fromCards][0] as string, repaired: true }
	if (fromCards.size > 1) return { ok: false, reason: 'ambiguous' }
	const rows = await db
		.select({ id: objects.id })
		.from(objects)
		.where(
			and(
				eq(objects.workspaceId, workspaceId),
				// canon.hex is hex-only, so this cannot carry a LIKE wildcard.
				sql`replace(${objects.id}::text, '-', '') like ${`${canon.hex}%`}`,
			),
		)
		.limit(2)
	if (rows.length === 1 && rows[0]) return { ok: true, id: rows[0].id, repaired: true }
	return { ok: false, reason: rows.length > 1 ? 'ambiguous' : 'not_found' }
}

/** Argument names that carry an object id (or a list of them) in the tools a voice agent calls. */
export const VOICE_ID_ARG_KEYS = new Set([
	'id',
	'ids',
	'object_id',
	'object_ids',
	'entity_id',
	'card_id',
	'source_id',
	'target_id',
])

const CLEAN_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/**
 * Repairs the id-shaped arguments of any tool call and returns a copy. Only a value that is not
 * already a clean uuid and resolves to exactly one object is replaced; everything else is passed
 * through untouched so the tool answers with its own error.
 */
export async function repairToolIdArgs(
	db: Database,
	workspaceId: string,
	args: Record<string, unknown>,
	startCards: StartCard[] | null,
): Promise<Record<string, unknown>> {
	const out: Record<string, unknown> = { ...args }
	const fix = async (value: unknown) => {
		if (typeof value !== 'string' || CLEAN_UUID_RE.test(value)) return value
		const res = await resolveObjectId(db, workspaceId, value, startCards)
		return res.ok ? res.id : value
	}
	for (const key of Object.keys(out)) {
		if (!VOICE_ID_ARG_KEYS.has(key)) continue
		const v = out[key]
		out[key] = Array.isArray(v) ? await Promise.all(v.map(fix)) : await fix(v)
	}
	return out
}
