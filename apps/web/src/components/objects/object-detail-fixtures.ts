import type { ObjectResponse } from '@/lib/api'

export interface EvidenceFixture {
	quote: string
	source?: string
	date?: string
}

export interface DocumentFoldFixture {
	title: string
	markdown: string
}

function asString(value: unknown): string | null {
	return typeof value === 'string' && value.length > 0 ? value : null
}

/** The agent's open question (metadata._ask) shown in the ask banner. */
export function getAsk(object: ObjectResponse): string | null {
	return asString(object.metadata?._ask)
}

/**
 * Evidence quotes. Reads the single `_evidence_quote` shape and the indexed
 * `_evidence_quote_2` / `_evidence_quote_3` … variants, so a document can carry
 * a row of pull-quotes (mockup 1127–1136) without a schema change.
 */
export function getEvidence(object: ObjectResponse): EvidenceFixture[] {
	const metadata = object.metadata
	if (!metadata) return []
	const out: EvidenceFixture[] = []
	for (let index = 1; ; index++) {
		const suffix = index === 1 ? '' : `_${index}`
		const quote = asString(metadata[`_evidence_quote${suffix}`])
		if (!quote) break
		out.push({
			quote,
			source: asString(metadata[`_evidence_source${suffix}`]) ?? undefined,
			date: asString(metadata[`_evidence_date${suffix}`]) ?? undefined,
		})
	}
	return out
}

/** Collapsible document fold (metadata._fold_title/_fold_markdown). */
export function getDocumentFold(object: ObjectResponse): DocumentFoldFixture | null {
	const title = asString(object.metadata?._fold_title)
	const markdown = asString(object.metadata?._fold_markdown)
	return title && markdown ? { title, markdown } : null
}
