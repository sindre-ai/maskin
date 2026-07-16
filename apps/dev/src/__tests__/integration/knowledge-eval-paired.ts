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
 *   - `tokensPerCorrectAnswerSemantic` (primary) and
 *     `tokensPerCorrectAnswerExact` (audit) — total prompt input tokens
 *     divided by the number of pairs each grader marked correct.
 *     Semantic-match is the primary metric — it grades meaning via a
 *     second `claude-haiku-4-5-20251001` call (see `gradeAnswerSemantic`
 *     in the harness) so paraphrased answers that carry the right
 *     information no longer false-fail. Exact-substring stays as an
 *     audit trail — same definition as T4's 4066.6 baseline.
 *     Semantic fields are populated only when the caller passes a
 *     `judge` on `PairedRunOptions`; when it is `null` (default) they
 *     stay `null` and only the exact-substring grader runs.
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

export type PairedPairResult = {
	regime: RegimeName
	question: string
	expectedFixtureId: string
	retrievedIds: string[]
	promptTokens: number
	completionTokens: number
	response: string | null
	// Exact-substring grader — kept as the audit trail comparable to T4's
	// baseline. `correctSemantic` is the primary correctness signal when a
	// judge is provided; `null` when no judge ran (`PairedRunOptions.judge`
	// left unset).
	correctExact: boolean
	correctSemantic: boolean | null
	semanticJudgeReason: string | null
	judgePromptTokens: number
	judgeCompletionTokens: number
	retrievedContainsGold: boolean
}

export type RegimeSummary = {
	regime: RegimeName
	numPairs: number
	// Semantic-match: primary metric. `null` when no judge was provided —
	// the paired runner then only scores exact-substring, matching T8's
	// original shape. Wire a judge in via `PairedRunOptions.judge` to fill
	// these fields.
	numCorrectSemantic: number | null
	tokensPerCorrectAnswerSemantic: number | null
	// Exact-substring: audit trail. Always populated.
	numCorrectExact: number
	tokensPerCorrectAnswerExact: number
	totalPromptTokens: number
	avgPromptTokensPerPair: number
	// Reader-side token counters, unchanged.
	// Judge-side counters — audit only. They do NOT count against the
	// router's ship metric (`tokensPerCorrectAnswer*`), which measures the
	// reader's prompt token budget, but stay visible so the cost of the
	// grader itself is legible.
	totalJudgePromptTokens: number
	totalJudgeCompletionTokens: number
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
	const retrievalHits = perPair.filter((p) => p.retrievedContainsGold).length
	// Semantic totals stay `null` if the judge never ran on any pair — mixed
	// runs (some scored, some not) shouldn't happen with the current runner
	// but if they do, we treat a missing semantic verdict as "not counted",
	// which keeps the primary metric conservative.
	const anySemanticScored = perPair.some((p) => p.correctSemantic !== null)
	const numCorrectSemantic = anySemanticScored
		? perPair.filter((p) => p.correctSemantic === true).length
		: null
	const tokensPerCorrectAnswerSemantic =
		numCorrectSemantic === null
			? null
			: numCorrectSemantic === 0
				? Number.POSITIVE_INFINITY
				: totalPromptTokens / numCorrectSemantic
	const totalJudgePromptTokens = perPair.reduce((s, p) => s + p.judgePromptTokens, 0)
	const totalJudgeCompletionTokens = perPair.reduce((s, p) => s + p.judgeCompletionTokens, 0)
	return {
		regime,
		numPairs,
		numCorrectSemantic,
		tokensPerCorrectAnswerSemantic,
		numCorrectExact,
		tokensPerCorrectAnswerExact:
			numCorrectExact === 0 ? Number.POSITIVE_INFINITY : totalPromptTokens / numCorrectExact,
		totalPromptTokens,
		avgPromptTokensPerPair: numPairs === 0 ? 0 : totalPromptTokens / numPairs,
		totalJudgePromptTokens,
		totalJudgeCompletionTokens,
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

async function scorePair(
	regime: RegimeName,
	pair: RepresentativePair,
	retrievedIds: string[],
	retrievedContainsGold: boolean,
	chatResult: { content: string | null; promptTokens: number; completionTokens: number },
	expectedExcerpt: string,
	judge: ChatFn | null,
): Promise<PairedPairResult> {
	const correctExact = gradeAnswer(chatResult.content, expectedExcerpt)
	let correctSemantic: boolean | null = null
	let semanticJudgeReason: string | null = null
	let judgePromptTokens = 0
	let judgeCompletionTokens = 0
	if (judge !== null) {
		const semantic = await gradeAnswerSemantic(chatResult.content, expectedExcerpt, judge)
		correctSemantic = semantic.correct
		semanticJudgeReason = semantic.reason
		judgePromptTokens = semantic.promptTokens
		judgeCompletionTokens = semantic.completionTokens
	}
	return {
		regime,
		question: pair.question,
		expectedFixtureId: pair.expectedFixtureId,
		retrievedIds,
		promptTokens: chatResult.promptTokens,
		completionTokens: chatResult.completionTokens,
		response: chatResult.content,
		correctExact,
		correctSemantic,
		semanticJudgeReason,
		judgePromptTokens,
		judgeCompletionTokens,
		retrievedContainsGold,
	}
}

export async function runDumpRegime(
	pairs: readonly RepresentativePair[],
	corpus: readonly RepresentativeArticle[],
	chat: ChatFn,
	judge: ChatFn | null = null,
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
		const chatResult = await chat(messages)
		const goldPair = goldByQuestion.get(pair.question)
		const expectedExcerpt = goldPair?.expectedExcerpt ?? ''
		perPair.push(await scorePair('dump', pair, allIds, true, chatResult, expectedExcerpt, judge))
	}
	return summarise('dump', perPair)
}

export async function runRouterRegime(
	pairs: readonly RepresentativePair[],
	corpus: readonly RepresentativeArticle[],
	chat: ChatFn,
	retriever: Retriever,
	judge: ChatFn | null = null,
): Promise<RegimeSummary> {
	const perPair: PairedPairResult[] = []
	const goldByQuestion = indexPairs(pairs)
	for (const pair of pairs) {
		const { retrieved, retrievedIds } = retriever(pair.question, corpus)
		const messages = buildMessages(retrieved, pair.question)
		const chatResult = await chat(messages)
		const goldPair = goldByQuestion.get(pair.question)
		const expectedExcerpt = goldPair?.expectedExcerpt ?? ''
		const retrievedContainsGold = retrievedIds.includes(pair.expectedFixtureId)
		perPair.push(
			await scorePair(
				'router',
				pair,
				retrievedIds,
				retrievedContainsGold,
				chatResult,
				expectedExcerpt,
				judge,
			),
		)
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
	// Semantic-match grader (see `gradeAnswerSemantic`). When `null` or
	// omitted the exact-substring grader is the only signal — the
	// pre-semantic behaviour T8 shipped with. When provided, each pair is
	// scored under BOTH graders and `numCorrectSemantic` +
	// `tokensPerCorrectAnswerSemantic` become the primary metric on each
	// regime summary; exact-substring stays as the audit trail.
	judge?: ChatFn | null
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
