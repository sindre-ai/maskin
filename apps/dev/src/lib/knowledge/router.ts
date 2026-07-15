// Prototype-scale knowledge router. Filters v1 knowledge articles by frontmatter
// (metadata.format_version = "v1"), scores each against a query using tag / doc_type /
// summary / title overlap, and returns a small top-K set so the caller can compose
// context from just those articles instead of dumping the whole corpus. Scoring is
// deterministic (id-ascending tiebreak) so downstream evals can compare reproducibly.
//
// v1 frontmatter fields consumed here mirror `docs/reference/knowledge-format.md`.

export type KnowledgeScope = 'workspace' | 'product-area' | 'org' | 'universal'

export type KnowledgeDocType =
	| 'topic_page'
	| 'playbook'
	| 'operational'
	| 'profile'
	| 'changelog'
	| 'reference'
	| 'note'

export interface KnowledgeArticle {
	id: string
	title: string
	body: string
	metadata: {
		format_version?: string
		doc_type?: KnowledgeDocType | string
		summary?: string
		tags?: string[]
		confidence?: 'low' | 'medium' | 'high'
		scope?: KnowledgeScope | string
		last_validated_at?: string
	}
}

export interface RouteOptions {
	topK?: number
	scope?: KnowledgeScope[]
	minScore?: number
}

export interface RouteHit {
	article: KnowledgeArticle
	score: number
	matched: {
		tags: string[]
		docType: boolean
		titleTerms: string[]
		summaryTerms: string[]
	}
}

export interface RouteResult {
	hits: RouteHit[]
	filteredCount: number
	scoredCount: number
}

const DEFAULT_TOP_K = 3
const CONFIDENCE_WEIGHT = { high: 1.2, medium: 1.0, low: 0.8 } as const

const STOP_WORDS = new Set([
	'a',
	'an',
	'and',
	'are',
	'as',
	'at',
	'be',
	'by',
	'do',
	'does',
	'for',
	'from',
	'has',
	'have',
	'how',
	'i',
	'in',
	'is',
	'it',
	'its',
	'of',
	'on',
	'or',
	'our',
	'the',
	'this',
	'to',
	'was',
	'we',
	'what',
	'when',
	'where',
	'who',
	'why',
	'with',
])

export function tokenizeQuery(query: string): string[] {
	return query
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter((t) => t.length >= 3 && !STOP_WORDS.has(t))
}

export function route(
	query: string,
	corpus: KnowledgeArticle[],
	options: RouteOptions = {},
): RouteResult {
	const topK = options.topK ?? DEFAULT_TOP_K
	const minScore = options.minScore ?? 0.5
	const requestedScopes = options.scope ? new Set(options.scope) : null
	const terms = tokenizeQuery(query)

	const v1 = corpus.filter((a) => a.metadata.format_version === 'v1')
	const scoped = requestedScopes
		? v1.filter((a) => !a.metadata.scope || requestedScopes.has(a.metadata.scope as KnowledgeScope))
		: v1

	const hits: RouteHit[] = []
	for (const article of scoped) {
		const scored = scoreArticle(article, terms)
		if (scored.score >= minScore) {
			hits.push(scored)
		}
	}

	hits.sort((a, b) => {
		if (b.score !== a.score) return b.score - a.score
		return a.article.id.localeCompare(b.article.id)
	})

	return {
		hits: hits.slice(0, topK),
		filteredCount: v1.length,
		scoredCount: scoped.length,
	}
}

function scoreArticle(article: KnowledgeArticle, terms: string[]): RouteHit {
	const meta = article.metadata
	const tags = meta.tags ?? []
	const summary = (meta.summary ?? '').toLowerCase()
	const title = article.title.toLowerCase()
	const docType = meta.doc_type ?? ''

	const matchedTags: string[] = []
	for (const tag of tags) {
		const lower = tag.toLowerCase()
		for (const term of terms) {
			if (lower.includes(term)) {
				matchedTags.push(tag)
				break
			}
		}
	}

	const matchedTitle = terms.filter((t) => title.includes(t))
	const matchedSummary = terms.filter((t) => summary.includes(t))
	const docTypeHit = terms.some((t) => docType.toLowerCase().includes(t))

	let raw = 0
	raw += matchedTags.length * 3
	raw += docTypeHit ? 2 : 0
	raw += matchedTitle.length * 1.5
	raw += matchedSummary.length * 1

	const confWeight = meta.confidence ? CONFIDENCE_WEIGHT[meta.confidence] : 1.0
	const score = raw * confWeight

	return {
		article,
		score,
		matched: {
			tags: matchedTags,
			docType: docTypeHit,
			titleTerms: matchedTitle,
			summaryTerms: matchedSummary,
		},
	}
}

// Assembles a compact context string from the hits. Callers pass this to the model
// in the router regime. Dump-into-context callers pass every article through the
// same shape (via `assembleV1DumpContext`) so the token comparison is apples-to-apples.
export function assembleContext(articles: KnowledgeArticle[]): string {
	return articles.map(renderArticle).join('\n\n---\n\n')
}

// Named `assembleV1DumpContext` — not `assembleFullContext` — so the caller sees
// the v1 filter in the name. A non-v1 corpus (e.g. T4's fixture before T2's
// backfill lands) returns an empty string, not the "full" corpus. Callers that
// need to see everything regardless of frontmatter should use `assembleContext`
// on the raw corpus.
export function assembleV1DumpContext(corpus: KnowledgeArticle[]): string {
	const v1 = corpus.filter((a) => a.metadata.format_version === 'v1')
	return assembleContext(v1)
}

function renderArticle(a: KnowledgeArticle): string {
	const meta = a.metadata
	const header: string[] = [`# ${a.title}`, `id: ${a.id}`]
	if (meta.doc_type) header.push(`type: ${meta.doc_type}`)
	if (meta.summary) header.push(`summary: ${meta.summary}`)
	if (meta.tags?.length) header.push(`tags: ${meta.tags.join(', ')}`)
	if (meta.scope) header.push(`scope: ${meta.scope}`)
	if (meta.confidence) header.push(`confidence: ${meta.confidence}`)
	return `${header.join('\n')}\n\n${a.body}`
}

// Deterministic token approximation — Math.ceil(chars / 4). Enough resolution to
// compare two regimes on the same fixture. T4's harness is the source of truth for
// the model-native counter once the fixture and baseline land; this proxy lets T5
// exercise the mechanism deterministically in isolation.
export function approxTokens(text: string): number {
	if (!text) return 0
	return Math.ceil(text.length / 4)
}
