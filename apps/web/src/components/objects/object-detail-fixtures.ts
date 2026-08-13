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

/** Evidence block (metadata._evidence_quote/_evidence_source/_evidence_date). */
export function getEvidence(object: ObjectResponse): EvidenceFixture | null {
	const quote = asString(object.metadata?._evidence_quote)
	if (!quote) return null
	return {
		quote,
		source: asString(object.metadata?._evidence_source) ?? undefined,
		date: asString(object.metadata?._evidence_date) ?? undefined,
	}
}

/** Collapsible document fold (metadata._fold_title/_fold_markdown). */
export function getDocumentFold(object: ObjectResponse): DocumentFoldFixture | null {
	const title = asString(object.metadata?._fold_title)
	const markdown = asString(object.metadata?._fold_markdown)
	return title && markdown ? { title, markdown } : null
}
