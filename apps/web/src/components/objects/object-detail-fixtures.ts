import type { ObjectResponse } from '@/lib/api'

/**
 * Read-only accessors for the object-detail fixture surface. All fixture data
 * rides in object.metadata under `_`-prefixed flat keys so it is excluded from
 * the key/value badge row (MetadataBadgesView filters `_` keys) and stays out
 * of the workspace schema's custom fields.
 *
 * The accessors return null when a fixture is absent, so the shell degrades to
 * the header + body for objects without a prototype payload.
 */

function str(metadata: ObjectResponse['metadata'], key: string): string | null {
	const value = metadata?.[key]
	return typeof value === 'string' && value.length > 0 ? value : null
}

export interface ObjectAsk {
	title: string
	sub: string | null
}

/** `_ask_title` (required) + `_ask_sub` (optional) — the agent's open question. */
export function getAsk(object: ObjectResponse): ObjectAsk | null {
	const title = str(object.metadata, '_ask_title')
	if (!title) return null
	return { title, sub: str(object.metadata, '_ask_sub') }
}

/** `_fold_title` — label of the collapsible document fold. */
export function getFoldTitle(object: ObjectResponse): string | null {
	return str(object.metadata, '_fold_title')
}

/** `_fold_markdown` — markdown rendered inside the collapsible document fold. */
export function getFoldMarkdown(object: ObjectResponse): string | null {
	return str(object.metadata, '_fold_markdown')
}

export interface EvidenceEntry {
	quote: string
	source: string
	date: string | null
}

/**
 * `_evidence_quote` (required) + `_evidence_source` (required) +
 * `_evidence_date` (optional). Rendered behind the evidence fold.
 */
export function getEvidence(object: ObjectResponse): EvidenceEntry | null {
	const quote = str(object.metadata, '_evidence_quote')
	const source = str(object.metadata, '_evidence_source')
	if (!quote || !source) return null
	return { quote, source, date: str(object.metadata, '_evidence_date') }
}
