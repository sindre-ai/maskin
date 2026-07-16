/**
 * Dump-into-context baseline harness for the 20-pair knowledge eval.
 *
 * The router in T5 will import `KNOWLEDGE_CORPUS` / `EVAL_PAIRS` from the
 * fixture module and reuse `gradeAnswer`; the dump-baseline path lives here.
 */

import {
	type CorpusEntry,
	EVAL_PAIRS,
	type EvalPair,
	FIXTURE_SEED,
	FIXTURE_SOURCE_COMMIT,
	KNOWLEDGE_CORPUS,
} from './knowledge-eval-fixture'

export const BASELINE_MODEL = process.env.KNOWLEDGE_EVAL_MODEL ?? 'claude-haiku-4-5-20251001'
export const BASELINE_TEMPERATURE = 0
export const BASELINE_SYSTEM_PROMPT =
	'You are answering a question using ONLY the knowledge corpus provided by the user. Quote or paraphrase the relevant article directly. If the corpus does not contain the answer, say so. Answer in 1–3 sentences.'

/**
 * Serialise the corpus into a single string that goes into the user message
 * alongside the question. Order-preserving so the token count for a given
 * corpus + question pair is deterministic.
 */
export function serialiseCorpus(corpus: readonly CorpusEntry[]): string {
	return corpus
		.map((row) => `---\nID: ${row.fixtureId}\nTitle: ${row.title}\n\n${row.content}`)
		.join('\n')
}

export function buildDumpMessages(
	corpus: readonly CorpusEntry[],
	question: string,
): Array<{ role: 'system' | 'user'; content: string }> {
	return [
		{ role: 'system', content: BASELINE_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Knowledge corpus:\n${serialiseCorpus(corpus)}\n\nQuestion: ${question}`,
		},
	]
}

/**
 * A correct answer surfaces the expected excerpt. Substring match,
 * whitespace- and case-insensitive so minor rewording doesn't false-fail.
 * Every excerpt in `EVAL_PAIRS` was chosen from the source corpus row so a
 * grounded answer that quotes or closely paraphrases the article will hit it.
 */
export function gradeAnswer(response: string | null, expectedExcerpt: string): boolean {
	if (!response) return false
	const normalise = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim()
	return normalise(response).includes(normalise(expectedExcerpt))
}

// Judge prompt: yes/no verdict on whether `response` contains the information
// in `expectedExcerpt`. Answers with a paraphrase — the case that trips the
// exact-substring grader — should score `yes`; answers that hit a different
// topic, hedge without stating the information, or refuse should score `no`.
// Temperature 0 keeps repeat calls stable.
export const SEMANTIC_JUDGE_MODEL = 'claude-haiku-4-5-20251001'
export const SEMANTIC_JUDGE_SYSTEM_PROMPT =
	'You are grading whether a candidate answer contains the information in a gold excerpt from a knowledge article. Say "yes" if the answer states the same fact or rule as the gold excerpt — verbatim quoting, paraphrase, and equivalent restatement all count. Say "no" if the answer omits, contradicts, or hedges the information, or answers a different question. Reply with exactly two lines: line 1 is "yes" or "no" (lowercase, nothing else); line 2 is a one-sentence reason.'

export function buildSemanticJudgeMessages(
	response: string,
	expectedExcerpt: string,
): Array<{ role: 'system' | 'user'; content: string }> {
	return [
		{ role: 'system', content: SEMANTIC_JUDGE_SYSTEM_PROMPT },
		{
			role: 'user',
			content: `Gold excerpt:\n${expectedExcerpt}\n\nCandidate answer:\n${response}`,
		},
	]
}

export type SemanticGrade = { correct: boolean; reason: string; verdict: string }

// A judge takes the candidate answer + gold excerpt and returns yes/no +
// reason. Callers pass an `AnthropicJudge` for the real-model path, or a
// stub for tests. When the response is null (model refused / errored) we
// short-circuit to `correct: false` without calling the judge — same
// contract as `gradeAnswer`.
export type SemanticJudge = (response: string, expectedExcerpt: string) => Promise<SemanticGrade>

export async function gradeAnswerSemantic(
	response: string | null,
	expectedExcerpt: string,
	judge: SemanticJudge,
): Promise<SemanticGrade> {
	if (!response) return { correct: false, reason: 'no response', verdict: 'no' }
	return judge(response, expectedExcerpt)
}

// Wire the semantic judge to the same Anthropic path the reader uses so
// the paired run reports both graders on a single invocation. Reads the
// verdict off line 1; anything not starting with `yes` (after trim,
// lowercased) is scored as `no`.
export function createAnthropicJudge(
	apiKey: string,
	model: string = SEMANTIC_JUDGE_MODEL,
): SemanticJudge {
	return async (response, expectedExcerpt) => {
		const messages = buildSemanticJudgeMessages(response, expectedExcerpt)
		const { content } = await callAnthropicWithUsage(messages, model, apiKey)
		const text = (content ?? '').trim()
		const [firstLine = '', ...rest] = text.split('\n')
		const verdict = firstLine.trim().toLowerCase()
		return {
			correct: verdict.startsWith('yes'),
			reason: rest.join(' ').trim() || firstLine.trim(),
			verdict,
		}
	}
}

export type PairResult = {
	question: string
	expectedFixtureId: string
	promptTokens: number
	completionTokens: number
	response: string | null
	correct: boolean
}

export type BaselineResult = {
	model: string
	temperature: number
	seed: string
	fixtureSourceCommit: string
	numPairs: number
	numCorrect: number
	totalPromptTokens: number
	avgPromptTokensPerPair: number
	tokensPerCorrectAnswer: number
	perPair: PairResult[]
}

export type ChatFn = (
	messages: Array<{ role: 'system' | 'user'; content: string }>,
) => Promise<{ content: string | null; promptTokens: number; completionTokens: number }>

export async function runDumpBaseline(
	pairs: readonly EvalPair[],
	corpus: readonly CorpusEntry[],
	chat: ChatFn,
	opts: { model: string; seed: string; fixtureSourceCommit: string },
): Promise<BaselineResult> {
	const perPair: PairResult[] = []
	for (const pair of pairs) {
		const messages = buildDumpMessages(corpus, pair.question)
		const { content, promptTokens, completionTokens } = await chat(messages)
		perPair.push({
			question: pair.question,
			expectedFixtureId: pair.expectedFixtureId,
			promptTokens,
			completionTokens,
			response: content,
			correct: gradeAnswer(content, pair.expectedExcerpt),
		})
	}
	const totalPromptTokens = perPair.reduce((s, p) => s + p.promptTokens, 0)
	const numCorrect = perPair.filter((p) => p.correct).length
	return {
		model: opts.model,
		temperature: BASELINE_TEMPERATURE,
		seed: opts.seed,
		fixtureSourceCommit: opts.fixtureSourceCommit,
		numPairs: perPair.length,
		numCorrect,
		totalPromptTokens,
		avgPromptTokensPerPair: totalPromptTokens / perPair.length,
		// tokens-per-correct-answer: prompt-side input tokens per correctly answered
		// pair. Infinity if the model got nothing right — treated as a failed
		// baseline run.
		tokensPerCorrectAnswer:
			numCorrect === 0 ? Number.POSITIVE_INFINITY : totalPromptTokens / numCorrect,
		perPair,
	}
}

/**
 * Real-model call. Uses OpenAI chat.completions directly so we can read
 * `usage.prompt_tokens` — the existing `OpenAIAdapter` throws that field
 * away. Not wired into the general LLM adapter to keep this harness
 * self-contained.
 */
export async function callOpenAIWithUsage(
	messages: Array<{ role: 'system' | 'user'; content: string }>,
	model: string,
	apiKey: string,
): Promise<{ content: string | null; promptTokens: number; completionTokens: number }> {
	const response = await fetch('https://api.openai.com/v1/chat/completions', {
		method: 'POST',
		headers: {
			'Content-Type': 'application/json',
			Authorization: `Bearer ${apiKey}`,
		},
		body: JSON.stringify({
			model,
			messages,
			temperature: BASELINE_TEMPERATURE,
		}),
	})
	if (!response.ok) {
		const body = await response.text()
		throw new Error(`OpenAI API error: ${response.status} ${body}`)
	}
	const data = (await response.json()) as {
		choices: Array<{ message: { content: string | null } }>
		usage: { prompt_tokens: number; completion_tokens: number }
	}
	return {
		content: data.choices[0]?.message?.content ?? null,
		promptTokens: data.usage.prompt_tokens,
		completionTokens: data.usage.completion_tokens,
	}
}

/**
 * Anthropic messages call — the default real-model path for the baseline
 * because it's what the workspace runtime has authenticated credentials
 * for. Reads `usage.input_tokens` to keep the token counter honest against
 * the model that actually served the request.
 *
 * `apiKey` can be either an `sk-ant-*` API key or a Claude Code OAuth
 * access token; the caller passes whichever env var is set. When the token
 * is an OAuth bearer, we also send the `oauth-2025-04-20` beta header
 * (required for OAuth-scoped requests). System prompt goes into the
 * top-level `system` field, not the messages array — Anthropic's contract.
 */
export async function callAnthropicWithUsage(
	messages: Array<{ role: 'system' | 'user'; content: string }>,
	model: string,
	apiKey: string,
): Promise<{ content: string | null; promptTokens: number; completionTokens: number }> {
	const systemPrompt = messages
		.filter((m) => m.role === 'system')
		.map((m) => m.content)
		.join('\n\n')
	const userMessages = messages
		.filter((m) => m.role !== 'system')
		.map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))

	const isOAuth = apiKey.startsWith('sk-ant-oat')
	const headers: Record<string, string> = {
		'Content-Type': 'application/json',
		'anthropic-version': '2023-06-01',
	}
	if (isOAuth) {
		headers.Authorization = `Bearer ${apiKey}`
		headers['anthropic-beta'] = 'oauth-2025-04-20'
	} else {
		headers['x-api-key'] = apiKey
	}

	const response = await fetch('https://api.anthropic.com/v1/messages', {
		method: 'POST',
		headers,
		body: JSON.stringify({
			model,
			max_tokens: 1024,
			temperature: BASELINE_TEMPERATURE,
			system: systemPrompt || undefined,
			messages: userMessages,
		}),
	})
	if (!response.ok) {
		const body = await response.text()
		throw new Error(`Anthropic API error: ${response.status} ${body}`)
	}
	const data = (await response.json()) as {
		content: Array<{ type: string; text?: string }>
		usage: { input_tokens: number; output_tokens: number }
	}
	const text = data.content
		.filter((block) => block.type === 'text')
		.map((block) => block.text ?? '')
		.join('')
	return {
		content: text || null,
		promptTokens: data.usage.input_tokens,
		completionTokens: data.usage.output_tokens,
	}
}

export { EVAL_PAIRS, FIXTURE_SEED, FIXTURE_SOURCE_COMMIT, KNOWLEDGE_CORPUS }
