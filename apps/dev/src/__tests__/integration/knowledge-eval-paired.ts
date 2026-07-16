/**
 * Paired-regime knowledge harness — Phase 0 measurement (T8).
 *
 * Scores each representative pair twice:
 *   - "dump" regime: the full corpus goes into the user message. Same
 *     shape as the T4 baseline, but running on the 30-pair representative
 *     set from `knowledge-eval-representative.ts`.
 *   - "router" regime: a pluggable Retriever selects a subset of the
 *     corpus (the same subset a production reader would compose) and only
 *     those articles go into the user message. T10 supplies the
 *     Retriever; until T10 lands, callers can pass `null` and the router
 *     side of the run is left as a placeholder that trips the paired
 *     runner to skip the router leg (retrieval accuracy + token cost both
 *     recorded as `null`).
 *
 * Both regimes score:
 *   - `tokensPerCorrectAnswerExact` / `tokensPerCorrectAnswerSemantic` —
 *     total prompt input tokens divided by the number of pairs the
 *     respective grader marked correct. Exact-substring is the T4 audit
 *     trail; semantic-match is the primary (paraphrase-tolerant) metric.
 *     Semantic values are `null` when the caller doesn't pass a judge.
 *   - `retrievalAccuracy` — fraction of pairs where the article set
 *     handed to the model contains the gold source. For the dump regime
 *     this is always 1.0 (the whole corpus is dumped, gold is always
 *     present). For the router regime it is the meaningful number.
 *
 * Grader semantics reused from `knowledge-eval-harness.ts` — no fork,
 * single-writer-per-file. Model + temperature reused from the same
 * module (`BASELINE_MODEL`, `BASELINE_TEMPERATURE`) so the paired numbers
 * are directly comparable to T4's 4066.6 baseline.
 */

import {
	BASELINE_MODEL,
	BASELINE_SYSTEM_PROMPT,
	BASELINE_TEMPERATURE,
	type ChatFn,
	type SemanticJudge,
	gradeAnswer,
	gradeAnswerSemantic,
} from './knowledge-eval-harness'
import type { RepresentativeArticle, RepresentativePair } from './knowledge-eval-representative'

// A retriever picks the article subset the reader would see under the
// router regime. It also reports the retrieved fixtureIds so retrieval
// accuracy can be computed independently of the article payload. T10 will
// implement one of these on top of `lib/knowledge/router.ts`.
export type Retriever = (
	query: string,
	corpus: readonly RepresentativeArticle[],
) => { retrieved: RepresentativeArticle[]; retrievedIds: string[] }

export type RegimeName = 'dump' | 'router'

// Per-pair grading emits both graders side-by-side. `correctExact` keeps
// the T4/T8 contract (exact substring, case/whitespace insensitive) as
// the audit trail; `correctSemantic` is the primary metric — null when
// no judge was supplied so callers can distinguish "not scored" from
// "scored wrong".
export type PairedPairResult = {
	regime: RegimeName
	question: string
	expectedFixtureId: string
	retrievedIds: string[]
	promptTokens: number
	completionTokens: number
	response: string | null
	correctExact: boolean
	correctSemantic: boolean | null
	semanticReason: string | null
	retrievedContainsGold: boolean
}

export type RegimeSummary = {
	regime: RegimeName
	numPairs: number
	numCorrectExact: number
	numCorrectSemantic: number | null
	totalPromptTokens: number
	avgPromptTokensPerPair: number
	tokensPerCorrectAnswerExact: number
	tokensPerCorrectAnswerSemantic: number | null
	retrievalAccuracy: number
	perPair: PairedPairResult[]
}

export type PairedResult = {
	model: string
	temperature: number
	seed: string
	fixtureSourceCommit: string
	numPairs: number
	dump: RegimeSummary
	router: RegimeSummary | null
}

function serialise(corpus: readonly RepresentativeArticle[]): string {
	// Keep the shape close to T4's `serialiseCorpus` — order-preserving,
	// per-row header, blank-line separator — so the model sees the same
	// article-layout convention across regimes and fixtures.
	return corpus
		.map((row) => `---\nID: ${row.fixtureId}\nTitle: ${row.title}\n\n${row.body}`)
		.join('\n')
}

function buildMessages(
	corpus: readonly RepresentativeArticle[],
	question: string,
): Array<{ role: 'system' | 'user'; content: string }> {
	return [
		{ role: 'system', content: BASELINE_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Knowledge corpus:\n${serialise(corpus)}\n\nQuestion: ${question}`,
		},
	]
}

function summarise(regime: RegimeName, perPair: PairedPairResult[]): RegimeSummary {
	const numPairs = perPair.length
	const totalPromptTokens = perPair.reduce((s, p) => s + p.promptTokens, 0)
	const numCorrectExact = perPair.filter((p) => p.correctExact).length
	const semanticScored = perPair.filter((p) => p.correctSemantic !== null)
	const numCorrectSemantic =
		semanticScored.length === 0 ? null : semanticScored.filter((p) => p.correctSemantic).length
	const retrievalHits = perPair.filter((p) => p.retrievedContainsGold).length
	return {
		regime,
		numPairs,
		numCorrectExact,
		numCorrectSemantic,
		totalPromptTokens,
		avgPromptTokensPerPair: numPairs === 0 ? 0 : totalPromptTokens / numPairs,
		tokensPerCorrectAnswerExact:
			numCorrectExact === 0 ? Number.POSITIVE_INFINITY : totalPromptTokens / numCorrectExact,
		tokensPerCorrectAnswerSemantic:
			numCorrectSemantic === null
				? null
				: numCorrectSemantic === 0
					? Number.POSITIVE_INFINITY
					: totalPromptTokens / numCorrectSemantic,
		retrievalAccuracy: numPairs === 0 ? 0 : retrievalHits / numPairs,
		perPair,
	}
}

// Look up the excerpt on the gold row exactly once — the grader itself
// only sees `response` + `expectedExcerpt`, so we pre-index the pairs by
// their gold row for the retrieval-accuracy computation.
function indexPairs(pairs: readonly RepresentativePair[]): Map<string, RepresentativePair> {
	return new Map(pairs.map((p) => [p.question, p]))
}

// Score one candidate answer under both graders. When `judge` is `null`,
// the semantic side records `null` — audit-trail-only mode preserves the
// pre-semantic contract for callers that haven't wired a judge yet.
async function scorePair(
	response: string | null,
	expectedExcerpt: string,
	judge: SemanticJudge | null,
): Promise<{
	correctExact: boolean
	correctSemantic: boolean | null
	semanticReason: string | null
}> {
	const correctExact = gradeAnswer(response, expectedExcerpt)
	if (judge === null) return { correctExact, correctSemantic: null, semanticReason: null }
	const semantic = await gradeAnswerSemantic(response, expectedExcerpt, judge)
	return {
		correctExact,
		correctSemantic: semantic.correct,
		semanticReason: semantic.reason,
	}
}

export async function runDumpRegime(
	pairs: readonly RepresentativePair[],
	corpus: readonly RepresentativeArticle[],
	chat: ChatFn,
	judge: SemanticJudge | null = null,
): Promise<RegimeSummary> {
	const perPair: PairedPairResult[] = []
	const goldByQuestion = indexPairs(pairs)
	// In the dump regime the retrieved set is the entire corpus, so the
	// gold row is always present. We still emit `retrievedIds` and
	// `retrievedContainsGold` so the JSON artifact shape stays symmetric
	// across regimes — makes the T10 diff trivial.
	const allIds = corpus.map((c) => c.fixtureId)
	for (const pair of pairs) {
		const messages = buildMessages(corpus, pair.question)
		const { content, promptTokens, completionTokens } = await chat(messages)
		const goldPair = goldByQuestion.get(pair.question)
		const expectedExcerpt = goldPair?.expectedExcerpt ?? ''
		const grades = await scorePair(content, expectedExcerpt, judge)
		perPair.push({
			regime: 'dump',
			question: pair.question,
			expectedFixtureId: pair.expectedFixtureId,
			retrievedIds: allIds,
			promptTokens,
			completionTokens,
			response: content,
			...grades,
			retrievedContainsGold: true,
		})
	}
	return summarise('dump', perPair)
}

export async function runRouterRegime(
	pairs: readonly RepresentativePair[],
	corpus: readonly RepresentativeArticle[],
	chat: ChatFn,
	retriever: Retriever,
	judge: SemanticJudge | null = null,
): Promise<RegimeSummary> {
	const perPair: PairedPairResult[] = []
	const goldByQuestion = indexPairs(pairs)
	for (const pair of pairs) {
		const { retrieved, retrievedIds } = retriever(pair.question, corpus)
		const messages = buildMessages(retrieved, pair.question)
		const { content, promptTokens, completionTokens } = await chat(messages)
		const goldPair = goldByQuestion.get(pair.question)
		const expectedExcerpt = goldPair?.expectedExcerpt ?? ''
		const grades = await scorePair(content, expectedExcerpt, judge)
		perPair.push({
			regime: 'router',
			question: pair.question,
			expectedFixtureId: pair.expectedFixtureId,
			retrievedIds,
			promptTokens,
			completionTokens,
			response: content,
			...grades,
			retrievedContainsGold: retrievedIds.includes(pair.expectedFixtureId),
		})
	}
	return summarise('router', perPair)
}

export type PairedRunOptions = {
	seed: string
	fixtureSourceCommit: string
	model?: string
	// When `null`, the router regime is skipped and only the dump
	// baseline is recorded. T8 records this shape; T10 flips it on with
	// a real Retriever.
	retriever?: Retriever | null
	// When set, each pair is scored with both the exact-substring grader
	// (audit trail) and the semantic judge (primary metric). When absent
	// or `null`, semantic scores render as `null` in the summary — same
	// pre-semantic contract T8/T10 recorded.
	judge?: SemanticJudge | null
}

export async function runPairedEval(
	pairs: readonly RepresentativePair[],
	corpus: readonly RepresentativeArticle[],
	chat: ChatFn,
	opts: PairedRunOptions,
): Promise<PairedResult> {
	const judge = opts.judge ?? null
	const dump = await runDumpRegime(pairs, corpus, chat, judge)
	const router =
		opts.retriever == null
			? null
			: await runRouterRegime(pairs, corpus, chat, opts.retriever, judge)
	return {
		model: opts.model ?? BASELINE_MODEL,
		temperature: BASELINE_TEMPERATURE,
		seed: opts.seed,
		fixtureSourceCommit: opts.fixtureSourceCommit,
		numPairs: pairs.length,
		dump,
		router,
	}
}

// Compute retrieval accuracy standalone — exposed for unit tests and for
// T10 to score a router without re-running the whole eval.
export function computeRetrievalAccuracy(
	pairs: readonly RepresentativePair[],
	retrievedByQuestion: Map<string, string[]>,
): number {
	if (pairs.length === 0) return 0
	let hits = 0
	for (const pair of pairs) {
		const retrieved = retrievedByQuestion.get(pair.question) ?? []
		if (retrieved.includes(pair.expectedFixtureId)) hits += 1
	}
	return hits / pairs.length
}
