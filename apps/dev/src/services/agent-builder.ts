import { z } from 'zod'
import { logger } from '../lib/logger'
import { type LlmCallInput, callLlm } from './llm-call'

// Server-side pipeline that turns a one-liner into an opinionated SME agent
// spec. Stages 1 and 2 are implemented in T2. Stages 3-6 will be added by
// T3/T4 alongside SKILL.md assembly, actor registration, and the gap report.
//
// Stage sequencing (also see T2 approach comment):
//   Stage 1 → Stage 2       — sequential (stage 2 consumes parsed intent, and
//                              stage 1 gates the underspecified early return).
//   Stage 3 || Stage 4      — CAN run in parallel once T3 adds them (system
//                              prompt + opinionation layer take the same
//                              intent+persona input and do not consume each
//                              other's output). T3 should use Promise.all at
//                              the seam marked in `runAgentBuilder`.
//
// Prompt templates live inline as exported consts to match every other prompt
// in the codebase (BET_STRATEGIST_SYSTEM_PROMPT, workspace-briefing, session-
// manager default). Diffable, PR-reviewable, no extra abstraction until a
// stage grows past ~200 lines.

const STAGE_1_TEMPERATURE = 0.2
const STAGE_2_TEMPERATURE = 0.3
const STAGE_TIMEOUT_MS = 15_000

export const STAGE_1_PROMPT = `You extract structured intent from a one-line request for a new subject-matter-expert (SME) agent. Return STRICT JSON matching this shape (no prose, no code fences):

{
  "domain": string,                 // the field of expertise the agent works in
  "job_to_be_done": string,         // the outcome the caller wants the agent to produce
  "deliverables": string[],         // concrete artifacts the agent should return (may be empty)
  "constraints": string[],          // known constraints from the input (may be empty)
  "is_underspecified": boolean,     // true if EITHER domain OR job_to_be_done cannot be identified with confidence
  "missing": string[],              // when is_underspecified=true, the mandatory fields missing (e.g. ["domain","job_to_be_done"])
  "gap_question": string            // when is_underspecified=true, ONE direct question that would unblock you (empty string otherwise)
}

Rules:
- Never invent a domain or job the input does not support. When in doubt, mark is_underspecified=true.
- "constraints" and "deliverables" may be empty; only "domain" and "job_to_be_done" are mandatory for a well-specified input.
- Do not include markdown, backticks, or commentary — JSON only.`

export const STAGE_2_PROMPT = `You synthesize an opinionated SME persona from parsed intent. The persona is used to seed an agent that will end its answers with a clear recommendation and stated assumptions — never hedging. Return STRICT JSON matching this shape (no prose, no code fences):

{
  "name": string,                       // memorable persona name, ~1-3 words
  "role": string,                       // one-line role headline (e.g. "Senior migration architect")
  "backstory": string,                  // 3-6 sentences. MUST encode: (a) specific expertise, (b) a decision framework the agent uses, (c) at least two named biases/blind spots the agent is aware of.
  "scope_boundaries": string[],         // what this agent will and will NOT engage with
  "delegation_description": string,     // "Use this agent when..." — one sentence a caller can pattern-match on
  "tool_set": string[]                  // inferred minimal MCP/native tools the agent needs (short names, no prose)
}

Rules:
- Bias for opinion. A vague or diplomatic backstory is a failure of this stage.
- Never hedge in the persona ("might", "could be", "depending on") — this is a stance-bearing role, not a survey.
- Do not include markdown, backticks, or commentary — JSON only.`

const stage1Schema = z.object({
	domain: z.string().default(''),
	job_to_be_done: z.string().default(''),
	deliverables: z.array(z.string()).default([]),
	constraints: z.array(z.string()).default([]),
	is_underspecified: z.boolean(),
	missing: z.array(z.string()).default([]),
	gap_question: z.string().default(''),
})

const stage2Schema = z.object({
	name: z.string().min(1),
	role: z.string().min(1),
	backstory: z.string().min(1),
	scope_boundaries: z.array(z.string()).default([]),
	delegation_description: z.string().min(1),
	tool_set: z.array(z.string()).default([]),
})

export type Stage1Output = z.infer<typeof stage1Schema>
export type PersonaSpec = z.infer<typeof stage2Schema>

export interface RunAgentBuilderInput {
	prompt: string
	examples?: string[]
	references?: string[]
	constraints?: string[]
}

export type RunAgentBuilderResult =
	| { kind: 'gap_question'; gap_question: string; missing: string[] }
	| { kind: 'persona'; intent: Stage1Output; persona: PersonaSpec }

export class AgentBuilderError extends Error {
	constructor(
		readonly reason:
			| 'llm_no_api_key'
			| 'llm_http_error'
			| 'llm_exception'
			| 'stage1_parse_error'
			| 'stage2_parse_error',
		message: string,
	) {
		super(message)
		this.name = 'AgentBuilderError'
	}
}

function buildStage1UserMessage(input: RunAgentBuilderInput): string {
	const lines = [`ONE-LINER: ${input.prompt}`]
	if (input.examples?.length) lines.push(`EXAMPLES:\n- ${input.examples.join('\n- ')}`)
	if (input.references?.length) lines.push(`REFERENCES:\n- ${input.references.join('\n- ')}`)
	if (input.constraints?.length) lines.push(`CONSTRAINTS:\n- ${input.constraints.join('\n- ')}`)
	return lines.join('\n\n')
}

function buildStage2UserMessage(intent: Stage1Output): string {
	return [
		`DOMAIN: ${intent.domain}`,
		`JOB TO BE DONE: ${intent.job_to_be_done}`,
		intent.deliverables.length ? `DELIVERABLES:\n- ${intent.deliverables.join('\n- ')}` : '',
		intent.constraints.length ? `CONSTRAINTS:\n- ${intent.constraints.join('\n- ')}` : '',
	]
		.filter(Boolean)
		.join('\n\n')
}

function safeParseJson(raw: string): unknown {
	try {
		return JSON.parse(raw)
	} catch {
		const match = raw.match(/\{[\s\S]*\}/)
		if (!match) return null
		try {
			return JSON.parse(match[0])
		} catch {
			return null
		}
	}
}

async function runStage(stage: 'stage1' | 'stage2', params: LlmCallInput): Promise<string> {
	const result = await callLlm(params)
	if (!result.ok) {
		if (result.reason === 'no_api_key') {
			throw new AgentBuilderError('llm_no_api_key', `${stage}: LLM key not configured`)
		}
		if (result.reason === 'http_error') {
			throw new AgentBuilderError(
				'llm_http_error',
				`${stage}: LLM returned HTTP ${result.status ?? 'unknown'}`,
			)
		}
		throw new AgentBuilderError('llm_exception', `${stage}: LLM request failed`)
	}
	return result.content
}

export async function runAgentBuilder(input: RunAgentBuilderInput): Promise<RunAgentBuilderResult> {
	// ── Stage 1: intent extraction + underspecification gate ────────────────
	// Must run first; stage 2 depends on its output AND we short-circuit here
	// when the prompt is underspecified (per bet DoD: no hallucinated fills).
	const stage1Raw = await runStage('stage1', {
		system: STAGE_1_PROMPT,
		user: buildStage1UserMessage(input),
		temperature: STAGE_1_TEMPERATURE,
		maxTokens: 600,
		timeoutMs: STAGE_TIMEOUT_MS,
		jsonMode: true,
	})

	const stage1Parsed = stage1Schema.safeParse(safeParseJson(stage1Raw))
	if (!stage1Parsed.success) {
		logger.error('agent-builder: stage1 parse failed', {
			issues: stage1Parsed.error.issues,
			rawPreview: stage1Raw.slice(0, 200),
		})
		throw new AgentBuilderError('stage1_parse_error', 'stage1: LLM returned invalid JSON shape')
	}
	const intent = stage1Parsed.data

	const underspecified =
		intent.is_underspecified || !intent.domain.trim() || !intent.job_to_be_done.trim()
	if (underspecified) {
		const gapQuestion =
			intent.gap_question.trim() ||
			'Can you tell me the domain and the specific outcome you want this agent to deliver?'
		const missing =
			intent.missing.length > 0
				? intent.missing
				: [
						!intent.domain.trim() ? 'domain' : null,
						!intent.job_to_be_done.trim() ? 'job_to_be_done' : null,
					].filter((v): v is string => Boolean(v))
		return { kind: 'gap_question', gap_question: gapQuestion, missing }
	}

	// ── Stage 2: persona synthesis ──────────────────────────────────────────
	// Sequential after stage 1 — takes parsed intent as input.
	// SEAM: T3 adds stages 3 (system prompt) and 4 (opinionation layer). Those
	// stages both take {intent, persona} as input and do not consume each
	// other's output, so they SHOULD be wrapped in `Promise.all` here to
	// preserve the p95 <30s budget.
	const stage2Raw = await runStage('stage2', {
		system: STAGE_2_PROMPT,
		user: buildStage2UserMessage(intent),
		temperature: STAGE_2_TEMPERATURE,
		maxTokens: 900,
		timeoutMs: STAGE_TIMEOUT_MS,
		jsonMode: true,
	})

	const stage2Parsed = stage2Schema.safeParse(safeParseJson(stage2Raw))
	if (!stage2Parsed.success) {
		logger.error('agent-builder: stage2 parse failed', {
			issues: stage2Parsed.error.issues,
			rawPreview: stage2Raw.slice(0, 200),
		})
		throw new AgentBuilderError('stage2_parse_error', 'stage2: LLM returned invalid JSON shape')
	}

	return { kind: 'persona', intent, persona: stage2Parsed.data }
}
