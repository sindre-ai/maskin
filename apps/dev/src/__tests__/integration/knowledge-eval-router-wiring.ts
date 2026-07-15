/**
 * T10 wiring — plug the T5 router (`apps/dev/src/lib/knowledge/router.ts`)
 * into the T8 paired-runner (`knowledge-eval-paired.ts`) as a `Retriever`.
 *
 * The two article shapes are structurally identical modulo the id field:
 *   - Router: `KnowledgeArticle = { id, title, body, metadata }`
 *   - Fixture: `RepresentativeArticle = { fixtureId, title, body, metadata }`
 *
 * We map `fixtureId → id`, drive `route()`, then look each hit back up in
 * the original corpus so the paired runner sees the exact fixture rows it
 * expects. The retrieved-id array is the router's top-K ordering (score
 * DESC, id ASC tiebreak) so retrieval accuracy is measured against what
 * a production reader would actually load.
 *
 * Kept in a companion file so T8's harness modules stay single-writer.
 */

import { type KnowledgeArticle, type RouteOptions, route } from '../../lib/knowledge/router'
import type { Retriever } from './knowledge-eval-paired'
import type { RepresentativeArticle } from './knowledge-eval-representative'

// Defaults match T5's `route()` defaults; overrideable per-run for
// sensitivity sweeps without touching this file's callers.
export const DEFAULT_ROUTER_TOP_K = 3
export const DEFAULT_ROUTER_MIN_SCORE = 0.5

function toKnowledgeArticle(row: RepresentativeArticle): KnowledgeArticle {
	return {
		id: row.fixtureId,
		title: row.title,
		body: row.body,
		metadata: row.metadata,
	}
}

export type RouterRetrieverOptions = Pick<RouteOptions, 'topK' | 'minScore' | 'scope'>

// Factory returns a `Retriever` closed over the router config. The corpus
// is passed in per-call by the paired runner (same shape T8's harness
// documents), so this stays stateless and safe to reuse across runs.
export function createRouterRetriever(options: RouterRetrieverOptions = {}): Retriever {
	const topK = options.topK ?? DEFAULT_ROUTER_TOP_K
	const minScore = options.minScore ?? DEFAULT_ROUTER_MIN_SCORE
	const scope = options.scope

	return (query, corpus) => {
		const byId = new Map(corpus.map((row) => [row.fixtureId, row]))
		const routable = corpus.map(toKnowledgeArticle)
		const result = route(query, routable, { topK, minScore, scope })
		const retrieved: RepresentativeArticle[] = []
		const retrievedIds: string[] = []
		for (const hit of result.hits) {
			const original = byId.get(hit.article.id)
			if (!original) continue
			retrieved.push(original)
			retrievedIds.push(hit.article.id)
		}
		return { retrieved, retrievedIds }
	}
}
